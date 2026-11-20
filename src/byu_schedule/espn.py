from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Literal

import httpx

_BASE = "https://site.api.espn.com/apis/site/v2/sports"


@dataclass(frozen=True)
class Sport:
    """One followed team. (Named Sport for history; it's really team+sport.)"""

    key: str  # URL slug and state key
    title: str  # page heading, e.g. "BYU Football"
    espn_path: str
    team_slug: str  # ESPN team URL slug, e.g. "byu", "utah"
    team_abbr: str  # ESPN abbreviation identifying our team in a game
    team_name: str  # used in notifications: "BYU W", "Jazz beat ..."
    # Periods in regulation. Live display is capped here: showing an
    # overtime period would reveal a tie at the end of regulation.
    regulation_periods: int
    period_label: Callable[[int], str]
    start_word: str  # for notifications: "kickoff", "tip-off"
    ntfy_env: str  # env var holding this team's ntfy topic

    def schedule_url(self, season_type: int) -> str:
        return (
            f"{_BASE}/{self.espn_path}/teams/{self.team_slug}/schedule"
            f"?seasontype={season_type}"
        )

    def scoreboard_event_url(self, event_id: str) -> str:
        # Single-game scoreboard feed (~15-25 KB). The team schedule feed's
        # live status lags during games; this is the feed ESPN's own
        # scoreboard uses, so live status/results come from here.
        return f"{_BASE}/{self.espn_path}/scoreboard/{event_id}"


def _quarters(p: int) -> str:
    return f"Q{p}"


def _halves(p: int) -> str:
    return {1: "1st Half", 2: "2nd Half"}[p]


def _innings(p: int) -> str:
    # Inning number only, never top/bottom: "Bottom 9th" would reveal the
    # home team wasn't already ahead.
    return f"{ {1: '1st', 2: '2nd', 3: '3rd'}.get(p, f'{p}th') } Inning"


_PERIOD_LABELS: dict[str, Callable[[int], str]] = {
    "quarters": _quarters,
    "halves": _halves,  # men's college basketball plays halves
    "innings": _innings,
}

# Followed teams are defined once in site/sports.json, shared with the
# static site's espn.js (which also has its own copy of these rules).
SPORTS_JSON = Path(__file__).resolve().parents[2] / "site" / "sports.json"


_SPORT_FIELDS = {f.name for f in dataclasses.fields(Sport)} - {"period_label"}


def _load_sports() -> dict[str, Sport]:
    sports: dict[str, Sport] = {}
    for entry in json.loads(SPORTS_JSON.read_text(encoding="utf-8")):
        # sports.json also holds site-only settings (e.g. "logo"); keep
        # just the fields Sport defines.
        fields = {k: v for k, v in entry.items() if k in _SPORT_FIELDS}
        label = _PERIOD_LABELS[entry["period_style"]]
        sports[entry["key"]] = Sport(**fields, period_label=label)
    return sports


SPORTS: dict[str, Sport] = _load_sports()

# ESPN's team schedule only returns one season type per request, and the
# default excludes the postseason (bowl games, March Madness, NBA playoffs).
_SEASON_TYPES = (2, 3)  # regular season, postseason

# A scheduled game is checked against the live feed from shortly before its
# listed start until this long after (covers TBD placeholders and delays).
_LIVE_CHECK_BEFORE = timedelta(minutes=15)
_LIVE_CHECK_AFTER = timedelta(hours=24)

# Per sport, from the latest refresh: what each feed reported for games
# checked live, e.g. "401856849 schedule='11/7 - 12:00 PM EST' live='7:42 -
# 3rd'". Used by the notifier to log feed lag; never displayed on the site.
feed_comparison: dict[str, list[str]] = {}

Status = Literal["scheduled", "live", "final"]


@dataclass
class Game:
    id: str
    week: int | None
    date: str
    opponent: str
    home_away: str
    neutral: bool
    status: Status
    result: Literal["W", "L", "T"] | None
    # Spoiler-safe progress for live games: "Q3", "2nd Half", "Halftime".
    # Never past the last regulation period; the clock is never exposed.
    live_label: str | None = None
    # Start time not announced yet; `date` then holds ESPN's placeholder
    # (midnight Eastern on game day, e.g. 05:00Z).
    time_tbd: bool = False

    @property
    def versus(self) -> str:
        return "@" if self.home_away == "away" and not self.neutral else "vs"

    def needs_live_check(self, now: datetime) -> bool:
        if self.status == "live":
            return True
        if self.status == "scheduled":
            start = datetime.fromisoformat(self.date)
            return start - _LIVE_CHECK_BEFORE <= now <= start + _LIVE_CHECK_AFTER
        return False


def _status_bucket(status_type: dict) -> Status:
    state = status_type.get("state")
    if state == "post":
        return "final"
    if state == "in":
        return "live"
    return "scheduled"


def _live_label(sport: Sport, status: dict) -> str | None:
    if status["type"].get("name") == "STATUS_HALFTIME":
        return "Halftime"
    period = status.get("period")
    if not period:
        return None
    return sport.period_label(min(period, sport.regulation_periods))


def _score(competitor: dict) -> float | None:
    # Scoreboard feed: "132"; schedule feed: {"value": 132.0, ...}.
    score = competitor.get("score")
    if isinstance(score, dict):
        score = score.get("value")
    try:
        return float(score)
    except (TypeError, ValueError):
        return None


def _result(ours: dict, theirs: dict) -> Literal["W", "L", "T"] | None:
    """W/L/T for a finished game, or None if ESPN hasn't settled it yet.

    ESPN flips a game to "post" a moment before it sets the `winner` flags,
    so a missing flag must not be read as a loss. Fall back to the scores,
    and if those are missing too, report no result yet. Equal scores with
    no winner is a tie (NFL games can end tied).
    """
    if ours.get("winner") is True or theirs.get("winner") is True:
        return "W" if ours.get("winner") is True else "L"
    our_score, their_score = _score(ours), _score(theirs)
    if our_score is None or their_score is None:
        return None
    if our_score == their_score:
        return "T"
    return "W" if our_score > their_score else "L"


def _live_fields(sport: Sport, competition: dict) -> dict:
    """Status, result, and live label from an ESPN competition object."""
    status = competition["status"]
    bucket = _status_bucket(status["type"])
    ours = next(
        c
        for c in competition["competitors"]
        if c["team"]["abbreviation"] == sport.team_abbr
    )
    theirs = next(c for c in competition["competitors"] if c is not ours)
    result: Literal["W", "L", "T"] | None = None
    if bucket == "final":
        # None here means "final, result pending": callers must not treat
        # it as a loss (the notifier waits; the page shows "Final").
        result = _result(ours, theirs)
    return {
        "status": bucket,
        "result": result,
        "live_label": _live_label(sport, status) if bucket == "live" else None,
    }


def _detail(competition: dict) -> str | None:
    return competition["status"]["type"].get("shortDetail")


async def _refresh_live(
    client: httpx.AsyncClient, sport: Sport, game: Game, schedule_detail: str | None
) -> None:
    response = await client.get(sport.scoreboard_event_url(game.id))
    response.raise_for_status()
    competition = response.json()["competitions"][0]
    for field, value in _live_fields(sport, competition).items():
        setattr(game, field, value)
    feed_comparison[sport.key].append(
        f"{game.id} schedule={schedule_detail!r} live={_detail(competition)!r}"
    )


async def _get_schedule(
    client: httpx.AsyncClient, sport: Sport, season_type: int
) -> list[dict]:
    response = await client.get(sport.schedule_url(season_type))
    response.raise_for_status()
    return response.json().get("events", [])


async def fetch_schedule(sport: Sport) -> list[Game]:
    async with httpx.AsyncClient(timeout=10) as client:
        regular, post = await asyncio.gather(
            *(_get_schedule(client, sport, t) for t in _SEASON_TYPES),
            return_exceptions=True,
        )
        if isinstance(regular, BaseException):
            raise regular
        events = list(regular)
        if isinstance(post, BaseException):
            # Postseason is a bonus; don't lose the whole page over it.
            print(f"{sport.key} postseason schedule failed: {post!r}")
        else:
            seen = {e["id"] for e in events}
            events += [e for e in post if e["id"] not in seen]
        events.sort(key=lambda e: e["date"])

        games: list[Game] = []
        schedule_details: dict[str, str | None] = {}
        for event in events:
            competition = event["competitions"][0]
            ours = next(
                c
                for c in competition["competitors"]
                if c["team"]["abbreviation"] == sport.team_abbr
            )
            opponent = next(c for c in competition["competitors"] if c is not ours)
            games.append(
                Game(
                    id=event["id"],
                    week=event.get("week", {}).get("number"),
                    date=event["date"],
                    opponent=opponent["team"]["displayName"],
                    home_away=ours["homeAway"],
                    neutral=bool(competition.get("neutralSite")),
                    time_tbd=event.get("timeValid") is False,
                    **_live_fields(sport, competition),
                )
            )
            schedule_details[event["id"]] = _detail(competition)

        # Overlay live status from the scoreboard feed for games in progress
        # or near their start. On failure, keep the schedule feed's status.
        now = datetime.now(timezone.utc)
        feed_comparison[sport.key] = []
        hot = [g for g in games if g.needs_live_check(now)]
        results = await asyncio.gather(
            *(_refresh_live(client, sport, g, schedule_details[g.id]) for g in hot),
            return_exceptions=True,
        )
        for game, result in zip(hot, results):
            if isinstance(result, Exception):
                feed_comparison[sport.key].append(f"{game.id} live feed failed: {result!r}")

    return games
