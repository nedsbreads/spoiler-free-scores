# spoiler-free-scores

Spoiler-free schedules (BYU football, BYU men's basketball, Utah Jazz,
Kansas City Chiefs, Kansas City Royals), served as a static site on GitHub
Pages: https://nedsbreads.github.io/spoiler-free-scores/ (`site/`, deployed
by `.github/workflows/pages.yml` when `site/` changes), plus push
notifications from `scripts/notify.py`. The core rule: never expose anything that hints at the score — no scores, no
game clock, and no overtime period numbers (live display caps at each
sport's last regulation period; see `Sport.regulation_periods` and
`_live_label` in `espn.py`). Men's college basketball plays halves, not
quarters. Baseball shows the inning number only (never top/bottom, which
would hint at the score), capped at the 9th. NFL games can tie: result `T`.

## Sports

Each followed team is an entry in `site/sports.json`, loaded into `SPORTS`
(`espn.py`) and by the static site: URL slug,
ESPN path and team slug/abbreviation (not all teams are BYU), titles,
period labels, and the env var holding its ntfy topic (a team whose
secret isn't set gets no notifications; Chiefs intentionally have none).
The site has a team menu (the page heading; a custom listbox, not a
`<select>`, so it can show logos) and `?team={key}`. Logos are
`site/logos/{logo}.png` and `{logo}-dark.png` (ESPN's dark-background
version, used in dark mode), 96px, named by each team's `logo` in
`sports.json`. `espn.py` ignores site-only keys like `logo`; with no
`?team` it shows the last-viewed team (localStorage). Each team's last
rendered list is cached in localStorage (`games:{key}`, spoiler-safe
fields only) and drawn instantly on open, then refreshed. Notifier
state in `state/notified.json` is keyed by sport; a sport new to the state
file has its already-started/finished games recorded silently (no flood).

## Two copies of the ESPN/spoiler rules

The browser fetches ESPN directly (its feeds allow any origin), so
`site/espn.js` is a port of `src/byu_schedule/espn.py`, which the notifier
uses. **Any change to ESPN parsing or the spoiler rules must be
made in both `espn.py` and `site/espn.js`.** Teams are defined once, in
`site/sports.json`, which both read. To check the two copies agree, dump
both copies' Game fields for every team and compare them (last done 2026-11-19:
identical for all 5 teams, 301 games).

Script/data URLs in `site/` carry `?v=__VERSION__`, which `pages.yml`
replaces with the commit SHA at deploy. Keep it on any new script or
data file: Pages sends max-age=600, and a new `index.html` running a
cached old `app.js` once left the site stuck on "Loading…".
Served locally, the literal `__VERSION__` works fine.

ESPN returns 403 to user agents containing "HeadlessChrome", so headless
browser tests must pass a normal `--user-agent`. Real browsers are fine.
Test the site locally with `uv run python -m http.server --directory site`.

## Data sources

`espn.py` reads the season from ESPN's team schedule feed, then, for games
live or near kickoff, overlays status/result from the single-game
scoreboard feed (`scoreboard/{event_id}`), because the schedule feed lags
during games. The notifier logs both feeds' status each poll ("feeds:"
lines in the Actions log) to measure that lag.

## Multi-machine setup

This folder is synced between two Windows machines (a laptop and a
desktop), so anything in it, including `.venv/`, is shared.

- The `.venv/` in this folder belongs to the **laptop** (its `pyvenv.cfg`
  points at the laptop's uv Python). It does not run on the desktop.
- On the **desktop**, the environment lives outside the synced folder so the
  two machines don't clobber each other. Set this before any `uv` command
  there: `UV_PROJECT_ENVIRONMENT=$LOCALAPPDATA/venvs/byu-schedule`
- The desktop also has `uv` and the GitHub CLI (`gh`) installed.
- The GitHub repo was renamed `byu-schedule` -> `spoiler-free-scores`
  (2026-11-19). The local folder and Python package keep the old name. On
  any machine still pointing at the old remote:
  `git remote set-url origin https://github.com/nedsbreads/spoiler-free-scores.git`
- The site moved from Render (FastAPI) to GitHub Pages on 2026-11-19; the
  Render service and FastAPI code were removed. The Python package is now
  just the notifier's ESPN code (`espn.py`), with `httpx` its only
  dependency.

## Notifications

`scripts/notify.py` runs from `.github/workflows/notify.yml` and commits
`state/notified.json` back to the repo, so `git pull` before committing.

GitHub throttles the `*/15` cron to every ~3-7h, so timing doesn't rely on
it: a run that finds a game live or within 12h of kickoff stays running,
polling every 60s, and re-dispatches itself before the 6h job limit until
the game is final. On game weekends that means near-continuous runs, which
is why the repo is public (unlimited Actions minutes; it was private with a
2,000 min/month cap). A `concurrency` group prevents overlapping watchers.
