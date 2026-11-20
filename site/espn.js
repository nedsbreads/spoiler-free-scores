// Port of src/byu_schedule/espn.py for the static site. The Python copy
// still drives the notifier, so a change to the spoiler rules or ESPN
// parsing here must be made there too (and vice versa).
//
// Core rule: never expose anything that hints at the score. No scores, no
// game clock, and no overtime period numbers (live display caps at the
// sport's last regulation period). The raw ESPN responses do contain
// scores; only the fields on the returned Game objects ever reach the page.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// ESPN's team schedule only returns one season type per request, and the
// default excludes the postseason (bowl games, March Madness, NBA playoffs).
const SEASON_TYPES = [2, 3]; // regular season, postseason

// A scheduled game is checked against the live feed from shortly before its
// listed start until this long after (covers TBD placeholders and delays).
const LIVE_CHECK_BEFORE_MS = 15 * 60 * 1000;
const LIVE_CHECK_AFTER_MS = 24 * 60 * 60 * 1000;

const PERIOD_LABELS = {
  quarters: (p) => `Q${p}`,
  halves: (p) => ({ 1: '1st Half', 2: '2nd Half' })[p],
};

const scheduleUrl = (sport, seasonType) =>
  `${BASE}/${sport.espn_path}/teams/${sport.team_slug}/schedule?seasontype=${seasonType}`;

// Single-game scoreboard feed. The team schedule feed's live status lags
// during games; this is the feed ESPN's own scoreboard uses.
const scoreboardEventUrl = (sport, eventId) =>
  `${BASE}/${sport.espn_path}/scoreboard/${eventId}`;

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN ${response.status} for ${url}`);
  return response.json();
}

function statusBucket(statusType) {
  if (statusType.state === 'post') return 'final';
  if (statusType.state === 'in') return 'live';
  return 'scheduled';
}

function liveLabel(sport, status) {
  if (status.type.name === 'STATUS_HALFTIME') return 'Halftime';
  const period = status.period;
  if (!period) return null;
  return PERIOD_LABELS[sport.period_style](Math.min(period, sport.regulation_periods));
}

function score(competitor) {
  // Scoreboard feed: "132"; schedule feed: {value: 132, ...}.
  let s = competitor.score;
  if (s && typeof s === 'object') s = s.value;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// W/L for a finished game, or null if ESPN hasn't settled it yet. ESPN
// flips a game to "post" a moment before it sets the `winner` flags, so a
// missing flag must not be read as a loss.
function result(ours, theirs) {
  if (ours.winner === true || theirs.winner === true) {
    return ours.winner === true ? 'W' : 'L';
  }
  const a = score(ours);
  const b = score(theirs);
  if (a === null || b === null || a === b) return null;
  return a > b ? 'W' : 'L';
}

function sides(sport, competition) {
  const ours = competition.competitors.find((c) => c.team.abbreviation === sport.team_abbr);
  const theirs = competition.competitors.find((c) => c !== ours);
  return { ours, theirs };
}

// Status, result, and live label from an ESPN competition object.
function liveFields(sport, competition) {
  const status = competition.status;
  const bucket = statusBucket(status.type);
  const { ours, theirs } = sides(sport, competition);
  return {
    status: bucket,
    // null when final means "result pending": shown as a neutral "Final".
    result: bucket === 'final' ? result(ours, theirs) : null,
    liveLabel: bucket === 'live' ? liveLabel(sport, status) : null,
  };
}

export function needsLiveCheck(game, now = Date.now()) {
  if (game.status === 'live') return true;
  if (game.status === 'scheduled') {
    const start = Date.parse(game.date);
    return start - LIVE_CHECK_BEFORE_MS <= now && now <= start + LIVE_CHECK_AFTER_MS;
  }
  return false;
}

export function versus(game) {
  return game.homeAway === 'away' && !game.neutral ? '@' : 'vs';
}

async function refreshLive(sport, game) {
  const data = await getJson(scoreboardEventUrl(sport, game.id));
  Object.assign(game, liveFields(sport, data.competitions[0]));
}

export async function fetchSchedule(sport) {
  const [regular, post] = await Promise.allSettled(
    SEASON_TYPES.map((t) => getJson(scheduleUrl(sport, t))),
  );
  if (regular.status === 'rejected') throw regular.reason;
  const events = [...(regular.value.events ?? [])];
  if (post.status === 'fulfilled') {
    // Postseason is a bonus; don't lose the whole page over it.
    const seen = new Set(events.map((e) => e.id));
    events.push(...(post.value.events ?? []).filter((e) => !seen.has(e.id)));
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const games = events.map((event) => {
    const competition = event.competitions[0];
    const { ours, theirs } = sides(sport, competition);
    return {
      id: event.id,
      date: event.date,
      opponent: theirs.team.displayName,
      homeAway: ours.homeAway,
      neutral: Boolean(competition.neutralSite),
      // Start time not announced yet; `date` then holds ESPN's placeholder
      // (midnight Eastern on game day, e.g. 05:00Z).
      timeTbd: event.timeValid === false,
      ...liveFields(sport, competition),
    };
  });

  // Overlay live status from the scoreboard feed for games in progress or
  // near their start. On failure, keep the schedule feed's status.
  const now = Date.now();
  const hot = games.filter((g) => needsLiveCheck(g, now));
  await Promise.allSettled(hot.map((g) => refreshLive(sport, g)));
  return games;
}
