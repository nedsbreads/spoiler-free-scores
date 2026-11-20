// Draws the spoiler-free schedule. Data comes from espn.js; this file only
// renders the spoiler-safe Game fields (never anything else from ESPN).
// ?v=__VERSION__ is replaced with the commit at deploy (pages.yml), so a
// new page never runs against cached files from an older deploy.
import { fetchSchedule, needsLiveCheck, versus } from './espn.js?v=__VERSION__';

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

const pickerEl = document.querySelector('.picker');
const pickerLabelEl = document.querySelector('.picker-label');
const pickerLogoEl = document.querySelector('.logo-slot');
const menuEl = document.getElementById('team-menu');
const statusEl = document.querySelector('.status');
const gamesEl = document.getElementById('games');

let sports = []; // from sports.json, in tab order
let current = null; // the Sport being shown
let loadedAt = 0;
let loadSeq = 0; // ignores responses for a team no longer shown
let timer = null;
let refreshWhenVisible = false;
// Set when a team is opened: center the "current" game once its list is
// drawn. Cleared after the first fresh render, or as soon as the user
// scrolls, so refreshes never move the page out from under them.
let centerPending = false;

// We position the page ourselves on open; don't let the browser restore
// an old scroll offset on reload.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
for (const type of ['wheel', 'touchmove', 'keydown']) {
  window.addEventListener(type, () => { centerPending = false; }, { passive: true });
}

// Show the pinned header's divider only once rows are scrolling under it.
const topbarEl = document.querySelector('.topbar');
const updateTopbar = () => topbarEl.classList.toggle('stuck', topbarEl.getBoundingClientRect().top <= 0 && scrollY > 0);
window.addEventListener('scroll', updateTopbar, { passive: true });

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

// Team logo, swapping to ESPN's dark-background version in dark mode.
function logoEl(sport) {
  const picture = document.createElement('picture');
  const dark = document.createElement('source');
  dark.media = '(prefers-color-scheme: dark)';
  dark.srcset = `logos/${sport.logo}-dark.png`;
  const img = new Image(28, 28);
  img.className = 'logo';
  img.alt = '';
  img.src = `logos/${sport.logo}.png`;
  picture.append(dark, img);
  return picture;
}

// --- Team menu: a listbox under the heading button ---------------------

function renderPicker() {
  pickerLabelEl.textContent = current.title;
  pickerLogoEl.replaceChildren(logoEl(current));
  menuEl.replaceChildren(
    ...sports.map((s) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.dataset.key = s.key;
      li.setAttribute('aria-selected', String(s === current));
      const label = document.createElement('span');
      label.textContent = s.title;
      li.append(logoEl(s), label);
      return li;
    }),
  );
}

const menuOpen = () => !menuEl.hidden;
const options = () => [...menuEl.children];

function openMenu() {
  menuEl.hidden = false;
  pickerEl.setAttribute('aria-expanded', 'true');
  (options().find((li) => li.dataset.key === current.key) ?? options()[0])?.focus();
}

function closeMenu({ focusButton = false } = {}) {
  if (!menuOpen()) return;
  menuEl.hidden = true;
  pickerEl.setAttribute('aria-expanded', 'false');
  if (focusButton) pickerEl.focus();
}

function choose(key) {
  closeMenu({ focusButton: true });
  const sport = byKey(key);
  if (!sport || sport === current) return;
  history.pushState(null, '', `?team=${encodeURIComponent(sport.key)}`);
  show(sport);
}

pickerEl.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu()));
pickerEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    openMenu();
  }
});
menuEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) choose(li.dataset.key);
});
menuEl.addEventListener('keydown', (e) => {
  const items = options();
  const i = items.indexOf(document.activeElement);
  const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, move))].focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (i !== -1) choose(items[i].dataset.key);
  } else if (e.key === 'Escape') {
    closeMenu({ focusButton: true });
  } else if (e.key === 'Tab') {
    closeMenu();
  }
});
// Tapping anywhere outside the heading or menu closes it.
document.addEventListener('pointerdown', (e) => {
  if (menuOpen() && !e.target.closest('.topbar')) closeMenu();
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

// The game to center on open: a live game if there is one, else the most
// recent finished game. -1 before the season starts (stay at the top).
function currentIndex(games) {
  const live = games.findIndex((g) => g.status === 'live');
  if (live !== -1) return live;
  return games.findLastIndex((g) => g.status === 'final');
}

// Puts the current game mid-screen, so the last couple of results and the
// next couple of games are visible. Near the top of the list it scrolls
// only as far as needed (often not at all).
function centerCurrent(games) {
  const row = gamesEl.children[currentIndex(games)];
  if (row) row.scrollIntoView({ block: 'center' });
  else window.scrollTo(0, 0);
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
    if (centerPending) {
      centerCurrent(games);
      centerPending = false;
    }
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
    centerPending = true;
    const cached = loadCache(sport);
    if (cached) {
      renderGames(cached); // instant; replaced when fresh data arrives
      statusEl.textContent = '';
      centerCurrent(cached); // fresh data re-centers unless the user scrolls
    } else {
      gamesEl.replaceChildren();
      statusEl.textContent = 'Loading…';
      window.scrollTo(0, 0);
    }
  }
  storageSet(TEAM_STORAGE_KEY, sport.key);
  document.title = `${sport.title} · Spoiler-Free Scores`;
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
    const response = await fetch('sports.json?v=__VERSION__');
    sports = await response.json();
  } catch (err) {
    console.warn('sports.json failed', err);
    statusEl.textContent = "Couldn't load the team list. Close and reopen to retry.";
    return;
  }
  show(teamFromUrl());
}

start();
