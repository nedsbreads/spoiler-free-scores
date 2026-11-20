// Draws the spoiler-free schedule. Data comes from espn.js; this file only
// renders the spoiler-safe Game fields (never anything else from ESPN).
import { fetchSchedule, needsLiveCheck, versus } from './espn.js';

// While a game is live or about to start, refetch this often (when visible).
const LIVE_REFRESH_MS = 30 * 1000;
// Coming back to the app after this long refetches (the home-screen app
// can resume an old copy without reloading).
const STALE_MS = 60 * 1000;
const RETRY_MS = 30 * 1000;
const TEAM_STORAGE_KEY = 'team';

// "Instant badges": the last list drawn for each team is saved on this
// device and drawn immediately on open, then replaced by fresh data. Only
// the spoiler-safe Game fields below are ever saved.
const CACHE_PREFIX = 'games:';
const CACHED_FIELDS = [
  'id', 'date', 'opponent', 'homeAway', 'neutral', 'timeTbd', 'status', 'result', 'liveLabel',
];

const pickerEl = document.querySelector('.picker select');
const pickerLabelEl = document.querySelector('.picker-label');
const statusEl = document.querySelector('.status');
const gamesEl = document.getElementById('games');

let sports = []; // from sports.json, in tab order
let current = null; // the Sport being shown
let loadedAt = 0;
let loadSeq = 0; // ignores responses for a team no longer shown
let timer = null;
let refreshWhenVisible = false;

// Storage can be unavailable (private mode, blocked site data).
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not essential */ }
}

const byKey = (key) => sports.find((s) => s.key === key);

// ?team=jazz, else the last team viewed on this device, else the first.
function teamFromUrl() {
  const key = new URLSearchParams(location.search).get('team');
  return byKey(key) ?? byKey(storageGet(TEAM_STORAGE_KEY)) ?? sports[0];
}

function renderPicker() {
  pickerEl.replaceChildren(
    ...sports.map((s) => new Option(s.title, s.key, false, s === current)),
  );
}

pickerEl.addEventListener('change', () => {
  const sport = byKey(pickerEl.value);
  if (!sport || sport === current) return;
  history.pushState(null, '', `?team=${encodeURIComponent(sport.key)}`);
  show(sport);
});

function saveCache(sport, games) {
  const safe = games.map((g) => Object.fromEntries(CACHED_FIELDS.map((f) => [f, g[f]])));
  storageSet(CACHE_PREFIX + sport.key, JSON.stringify(safe));
}

function loadCache(sport) {
  try {
    const games = JSON.parse(storageGet(CACHE_PREFIX + sport.key));
    return Array.isArray(games) ? games : null;
  } catch {
    return null;
  }
}

function formatDate(game) {
  const d = new Date(game.date);
  if (game.timeTbd) {
    // Kickoff not set: ESPN's placeholder time (midnight Eastern) would show
    // as the previous evening in Mountain time. Its UTC date is the actual
    // game day, so show that date only.
    return d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    }) + ' · Time TBD';
  }
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function badge(game) {
  const el = document.createElement('span');
  if (game.status === 'final' && game.result) {
    el.className = `badge ${{ W: 'win', L: 'loss', T: 'tie' }[game.result]}`;
    el.textContent = game.result;
  } else if (game.status === 'final') {
    // Over, but ESPN hasn't settled W/L yet: never guess.
    el.className = 'badge upcoming';
    el.textContent = 'Final';
  } else if (game.status === 'live') {
    el.className = 'badge live';
    el.textContent = game.liveLabel ? `LIVE · ${game.liveLabel}` : 'LIVE';
  } else {
    el.className = 'badge upcoming';
    el.textContent = 'Upcoming';
  }
  return el;
}

function renderGames(games) {
  if (!games.length) {
    gamesEl.replaceChildren();
    statusEl.textContent = 'No games on the schedule yet.';
    return;
  }
  gamesEl.replaceChildren(
    ...games.map((game) => {
      const row = document.createElement('div');
      row.className = 'game';
      const info = document.createElement('div');
      info.className = 'info';
      const opponent = document.createElement('span');
      opponent.className = 'opponent';
      opponent.textContent = `${versus(game)} ${game.opponent}`;
      const time = document.createElement('time');
      time.className = 'meta';
      time.dateTime = game.date;
      time.textContent = formatDate(game);
      info.append(opponent, time);
      row.append(info, badge(game));
      return row;
    }),
  );
}

function schedule(fn, ms) {
  clearTimeout(timer);
  timer = setTimeout(fn, ms);
}

// Refetch now if visible; otherwise as soon as the page is visible again.
function refresh() {
  if (document.visibilityState === 'visible') load();
  else refreshWhenVisible = true;
}

async function load() {
  const seq = ++loadSeq;
  const sport = current;
  clearTimeout(timer);
  refreshWhenVisible = false;
  try {
    const games = await fetchSchedule(sport);
    if (seq !== loadSeq) return;
    statusEl.textContent = '';
    renderGames(games);
    saveCache(sport, games);
    loadedAt = Date.now();
    if (games.some((g) => needsLiveCheck(g))) schedule(refresh, LIVE_REFRESH_MS);
  } catch (err) {
    if (seq !== loadSeq) return;
    console.warn('schedule load failed', err);
    // Keep whatever list is showing; just say so and retry.
    statusEl.textContent = "Couldn't reach ESPN. Retrying…";
    schedule(refresh, RETRY_MS);
  }
}

function show(sport) {
  if (sport !== current) {
    current = sport;
    const cached = loadCache(sport);
    if (cached) {
      renderGames(cached); // instant; replaced when fresh data arrives
      statusEl.textContent = '';
    } else {
      gamesEl.replaceChildren();
      statusEl.textContent = 'Loading…';
    }
  }
  storageSet(TEAM_STORAGE_KEY, sport.key);
  document.title = `${sport.title} · Spoiler-Free Scores`;
  pickerLabelEl.textContent = sport.title;
  renderPicker();
  load();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !current) return;
  if (refreshWhenVisible || Date.now() - loadedAt > STALE_MS) load();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && current) load(); // restored from the back/forward cache
});
window.addEventListener('popstate', () => show(teamFromUrl()));

async function start() {
  try {
    const response = await fetch('sports.json');
    sports = await response.json();
  } catch (err) {
    console.warn('sports.json failed', err);
    statusEl.textContent = "Couldn't load the team list. Close and reopen to retry.";
    return;
  }
  show(teamFromUrl());
}

start();
