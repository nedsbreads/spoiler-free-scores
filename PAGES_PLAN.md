# Plan: move the site from Render to GitHub Pages

Why: Render's free plan sleeps after ~15 min idle, so opening the site
takes 30-60s to wake it. GitHub Pages serves static files and never sleeps.

Target URL: **https://nedsbreads.github.io/spoiler-free-scores/**
(repo renamed from `byu-schedule` on 2026-11-19 for this).

## Approach: the browser fetches ESPN directly

Verified 2026-11-19: both ESPN feeds we use (team schedule and
`scoreboard/{event_id}`) send `Access-Control-Allow-Origin: *`, so a page
on github.io can read them directly. No server needed.

## What gets built (new `site/` folder)

- `index.html`: current page markup and styles, with the Jinja template
  syntax removed.
- `espn.js`: a port of `espn.py`.
  - Read the regular and postseason schedule feeds, then overlay the live
    scoreboard feed for games that are live or near their start.
  - Apply the same spoiler rules as `espn.py`:
    - no scores and no clock
    - the period display stops at the last regulation period
    - "Halftime" during the break
    - W/L comes from the `winner` flag, then the scores; otherwise the
      result is pending and shown as a neutral "Final" (commit `ae4fd53`)
- `app.js`: draws the game list.
  - While a game is live, fetch new data every 30s and update only the
    list instead of reloading the whole page.
  - Also refresh when the app comes back into view.
- Teams: `?team=jazz` instead of `/jazz`, since Pages can't serve made-up
  paths. The last team viewed goes in `localStorage` instead of a cookie.
- All paths relative, because the site lives under `/spoiler-free-scores/`.
  That includes the manifest's `start_url` and icon paths.
- The browser receives ESPN's raw data, which includes scores. The page
  must never put scores in the page or log them.

## Deploy

- Add a GitHub Actions workflow that publishes `site/` to Pages, using
  `paths: site/**`.
- Don't publish straight from the branch: the notifier commits state to
  master every few minutes during games, and each commit would rebuild the
  site for nothing.

## Notifier

No change. It stays in Python and keeps running in Actions.

## Decisions (2026-11-19)

- Duplicated rules (DECIDED): keep the Python notifier and the JS site as separate
  copies of the ESPN/spoiler rules, **with team definitions moved into one
  shared `sports.json`** and a CLAUDE.md note that rule changes go in both
  places. The alternative is porting the notifier to JS so there's a
  single copy.
- Instant badges (DONE): cache the last-rendered W/L and Upcoming badges in
  `localStorage` so they paint instantly on open, then refresh. It's
  spoiler-safe because it holds only what the page already shows.
  Built: `games:<team>` keys in localStorage, only the spoiler-safe Game fields.

## Cut-over

1. DONE: built `site/` and checked it against the Python output; Pages enabled.
2. Deploy to Pages and run it alongside Render for a game or two.
3. On the phone, remove the old home-screen app and add the new URL. The
   address changes, so the old icon won't follow.
4. Change Render to forward to the new URL, then delete the Render
   service and `render.yaml`.
5. Delete the FastAPI app (`main.py`, `templates/`) and update CLAUDE.md
   and README.
