# spoiler-free-scores

Spoiler-free schedules for BYU football, BYU men's basketball, the Utah
Jazz, the Kansas City Chiefs, and the Kansas City Royals: wins and losses
only, never scores. Uses ESPN's public API (no key required).

**Site:** https://nedsbreads.github.io/spoiler-free-scores/

## Site (`site/`)

A static page on GitHub Pages. The browser fetches each team's schedule
straight from ESPN, so there's no server to wake up.

- Pick a team from the dropdown in the heading, or link to one with
  `?team=jazz`. With no `?team`, the page opens on the last team viewed.
- Teams are defined in `site/sports.json`: ESPN path, team slug and
  abbreviation, display names, and how periods are labeled.
- For games live or about to start, status comes from ESPN's single-game
  scoreboard feed, which updates faster during games. While a game is
  live, the page refreshes it every 30 seconds.
- Live games show only the period, never the clock, and it stops at the
  last regulation period so overtime doesn't reveal a tie:
  - football and NBA: Q4
  - men's college basketball: 2nd Half
  - baseball: 9th inning, shown without top/bottom
- Halftime shows as "Halftime".
- Results come from ESPN's `winner` flag. If that isn't set yet, the
  result comes from the scores. Equal scores is a tie (`T`, NFL only).
  The page never displays scores.
- The last list drawn for each team is saved on the device and shown
  instantly the next time the page opens, then refreshed.

Pushing changes under `site/` deploys automatically
(`.github/workflows/pages.yml`). To test locally:

```
uv run python -m http.server --directory site
```

Then open http://localhost:8000.

## Notifications

`scripts/notify.py` sends spoiler-free start and W/L/T push notifications
via [ntfy.sh](https://ntfy.sh), one topic per team. Each topic is a repo
secret named by the team's `ntfy_env` in `sports.json`:

| Team | Secret |
|---|---|
| BYU football | `NTFY_TOPIC` |
| BYU men's basketball | `NTFY_TOPIC_MBB` |
| Utah Jazz | `NTFY_TOPIC_JAZZ` |
| Kansas City Royals | `NTFY_TOPIC_ROYALS` |
| Kansas City Chiefs | `NTFY_TOPIC_CHIEFS` (not set: no notifications) |

A team whose secret isn't set is skipped.

The notifier runs from GitHub Actions. When a game is live or within 12h
of its start, the run stays up polling ESPN every minute and re-dispatches
itself until the game is final, so notifications arrive within about a
minute. It uses the Python copy of the ESPN logic in
`src/byu_schedule/espn.py`. Changes to the spoiler rules must be made there
and in `site/espn.js`.
