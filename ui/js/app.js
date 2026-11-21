// App shell: routing, sidebar, search box, shortcuts, live events.
import { I } from './icons.js';
import { get, post, cmd, listen, dropCache } from './api.js';
import { h, icon, btn, img, store, on, emit, go, toast, myPlaylists, errorBox, toggleLike, isMac, closeMenu, refreshPlaying, collectionMenu, prefetchPageOnHover, openFxFor, menu } from './ui.js';
import * as V from './views.js';
import { buildBar, renderState, togglePanel, toggleNowPlaying, restorePanel, livePos } from './player.js';
import { applyTheme, syncFromEngine } from './theme.js';
import { initLayout, sideToggleBtn, togglePlaylists, toggleSidebar, toggleWidePanel, toggleMini } from './layout.js';
import { sideCfg, buildRows, playlistMenuItems, newFolder, headDrop } from './sidelist.js';

const $ = (s) => document.querySelector(s);
document.body.classList.add(isMac() ? 'mac' : 'win');
applyTheme();            // from localStorage: no flash of the default look
syncFromEngine();        // then the engine's saved copy
if (new URLSearchParams(location.search).get('shell')) document.body.classList.add('shell');

// ------------------------------------------------------------------ routing
const routes = {
  home: V.home, explore: V.explore, search: V.search, library: V.library, playlist: V.playlist, album: V.album,
  artist: V.artist, mood: V.mood, settings: V.settings, import: V.importView, downloads: V.downloads,
  versions: V.versions,
};
const scrolls = new Map();
let current = { cleanup: null, key: null };
let renderSeq = 0;

function parse() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', param: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null, query: new URLSearchParams(qs || '') };
}

async function render() {
  const seq = ++renderSeq;
  const sc = $('#main-scroll');
  if (current.key) scrolls.set(current.key, sc.scrollTop);
  try { current.cleanup && current.cleanup(); } catch {}
  current.cleanup = null;
  closeMenu();
  if (document.body.classList.contains('np-open')) toggleNowPlaying(false);
  const { name, param, query } = parse();
  const key = location.hash || '#/home';
  current.key = key;
  const fn = routes[name] || V.home;
  const view = h('div', { class: `view view-${name}` });
  const host = $('#view');
  host.replaceChildren(view);
  sc.scrollTop = 0;
  updateNav(name, param);
  if (name === 'search') $('#search-input').value = query.get('q') || '';
  try {
    const res = await fn(param, view, query);
    if (seq !== renderSeq) { res?.cleanup && res.cleanup(); return; }
    current.cleanup = res?.cleanup || null;
    if (scrolls.has(key)) requestAnimationFrame(() => { sc.scrollTop = scrolls.get(key); });
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    view.replaceChildren(errorBox(e, render));
  }
}

function updateNav(name, param) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('on', n.dataset.route === name));
  document.querySelectorAll('.side-pl').forEach((n) => n.classList.toggle('on', (name === 'playlist' && n.dataset.id === param) || (name === 'library' && param === 'liked' && n.dataset.id === 'LM')));
}

// ------------------------------------------------------------------ sidebar
function buildSidebar() {
  const side = $('#side');
  const nav = (route, label, ico, hash) => h('a', { class: 'nav-item', href: hash || `#/${route}`, dataset: { route } }, icon(ico), h('span', null, label));
  side.append(
    h('div', { class: 'brand' }, h('img', { src: '/assets/nocturne-512.png', alt: '' }), h('span', null, 'Nocturne'), sideToggleBtn()),
    h('nav', { class: 'nav' }, nav('home', 'Home', 'home'), nav('explore', 'Explore', 'explore'), nav('library', 'Library', 'library', '#/library/playlists')),
    h('div', { class: 'side-sep' }),
    h('div', { class: 'side-head' }, h('button', { class: 'side-fold', title: 'Show / hide your playlists', onclick: togglePlaylists }, h('span', null, 'Playlists'), icon('chevDown')), btn('folderPlus', 'New folder', () => sideCfg().then(() => newFolder())), btn('plus', 'New playlist', async () => {
      if (!store.state?.auth?.yt) return go('#/settings');
      const { prompt } = await import('./ui.js');
      const name = await prompt('New playlist', 'Playlist name');
      if (!name) return;
      const r = await post('/api/playlist/create', { title: name }).catch((e) => toast(e.message, 'error'));
      dropCache('/api/library'); await myPlaylists(true);
      if (r?.id) go('#/playlist/' + r.id);
    })),
    h('div', { id: 'side-pls', class: 'side-pls' }),
    h('div', { class: 'side-foot' },
      h('a', { class: 'nav-item', href: '#/library/downloads', dataset: { route: 'downloads' } }, icon('download'), h('span', null, 'Downloads'), h('span', { id: 'dl-badge', class: 'badge-dot' })),
      h('a', { class: 'nav-item', href: '#/settings', dataset: { route: 'settings' } }, icon('settings'), h('span', null, 'Settings'), h('span', { id: 'acct-mini' }))));
  renderSidePlaylists();
}

async function renderSidePlaylists() {
  const box = $('#side-pls');
  if (!store.state?.auth?.yt) {
    box.replaceChildren(h('div', { class: 'side-empty' }, 'Sign in to see your playlists here.', h('a', { href: '#/settings' }, 'Connect YouTube Music')));
    return;
  }
  const pls = await myPlaylists();
  const liked = h('a', { class: 'side-pl', href: '#/playlist/LM', dataset: { id: 'LM' } }, h('div', { class: 'art xs liked-art', html: I.heartFill }), h('span', null, 'Liked music'));
  prefetchPageOnHover(liked, { kind: 'playlist', id: 'LM' });
  const mine = h('a', { class: 'side-pl', href: '#/library/versions', dataset: { id: 'versions' } }, h('div', { class: 'art xs versions-art', html: I.wand }), h('span', null, 'My versions'));
  await sideCfg();
  const row = (p) => {
    const a = h('a', { class: 'side-pl', href: `#/playlist/${p.id}`, dataset: { id: p.id }, title: p.title }, img(p.thumb, 'xs'), h('span', null, p.title));
    a.addEventListener('contextmenu', (e) => { e.preventDefault(); collectionMenu(p, e.clientX, e.clientY); });
    prefetchPageOnHover(a, p);
    return a;
  };
  const rows = buildRows(pls.filter((p) => p.id !== 'LM' && p.id !== 'SE'), row, (x, y, items) => menu(x, y, items));
  box.replaceChildren(liked, mine, ...rows);
  updateNav(parse().name, parse().param);
  sideLoadedAt = Date.now();
}
on('playlists', () => renderSidePlaylists());
on('sidecfg', () => renderSidePlaylists());
store.playlistMenuExtra = playlistMenuItems;   // Pin / Move to folder on every playlist's right-click menu

// new playlists (e.g. right after a Spotify import) only get their cover art from YouTube a little
// later, so refresh the sidebar when you come back to the window and every few minutes
let sideLoadedAt = 0;
const refreshSide = async (force) => {
  if (!store.state?.auth?.yt) return;
  if (!force && Date.now() - sideLoadedAt < 120000) return;
  dropCache('/api/library/playlists');
  await myPlaylists(true);
};
window.addEventListener('focus', () => refreshSide(false));
setInterval(() => refreshSide(true), 10 * 60000);

function renderAccount() {
  const a = store.state?.auth;
  const el = $('#acct-mini');
  if (!el) return;
  el.replaceChildren();
  if (a?.yt && a.account?.photo) el.append(img(a.account.photo, 'avatar-xs', true));
}

// ------------------------------------------------------------------ top bar + search
function buildTop() {
  const input = h('input', { id: 'search-input', class: 'search-input', placeholder: 'Search songs, artists, albums — or paste a YouTube or Spotify link', autocomplete: 'off', spellcheck: 'false' });
  const sugg = h('div', { class: 'suggest' });
  const box = h('div', { class: 'search' }, icon('search', 'search-ico'), input, h('span', { class: 'kbd' }, isMac() ? '⌘K' : 'Ctrl K'), sugg);
  const top = $('#top');
  top.append(
    h('div', { class: 'hist' }, btn('left', 'Back', () => history.back()), btn('right', 'Forward', () => history.forward())),
    box);
  let tm = null, sel = -1, items = [];
  const show = (list) => {
    items = list; sel = -1;
    sugg.replaceChildren(...list.map((s, i) => h('div', { class: 'sugg', onmousedown: (e) => { e.preventDefault(); submit(s); } }, icon('search'), h('span', null, s))));
    sugg.classList.toggle('open', list.length > 0 && document.activeElement === input);
  };
  const submit = (q) => {
    q = (q || '').trim();
    if (!q) return;
    input.value = q;
    sugg.classList.remove('open');
    input.blur();
    go(`#/search?q=${encodeURIComponent(q)}`);
  };
  input.addEventListener('input', () => {
    clearTimeout(tm);
    const q = input.value.trim();
    if (!q || /^https?:\/\//.test(q)) { show([]); return; }
    tm = setTimeout(async () => { try { const r = await get('/api/suggest?q=' + encodeURIComponent(q)); if (input.value.trim() === q) show(r.items || []); } catch {} }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { submit(sel >= 0 ? items[sel] : input.value); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      sugg.querySelectorAll('.sugg').forEach((s, i) => s.classList.toggle('on', i === sel));
    } else if (e.key === 'Escape') { sugg.classList.remove('open'); input.blur(); }
  });
  input.addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\/.*(youtube\.com|youtu\.be|open\.spotify\.com|spotify\.link|spoti\.fi)/.test(input.value.trim()) || /^spotify:(playlist|album|track):/.test(input.value.trim())) submit(input.value); }, 0));
  input.addEventListener('focus', () => { input.select(); if (items.length) sugg.classList.add('open'); });
  input.addEventListener('blur', () => setTimeout(() => sugg.classList.remove('open'), 120));
}

// ------------------------------------------------------------------ keyboard
function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
document.addEventListener('keydown', (e) => {
  const m = isMac() ? e.metaKey : e.ctrlKey;
  if (m && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search-input').focus(); return; }
  if (typing(e)) return;
  if (document.querySelector('.modal-back')) return;
  const s = store.state;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); cmd('toggle'); }
  else if (k === '/') { e.preventDefault(); $('#search-input').focus(); }
  else if (m && k === 'ArrowRight') { e.preventDefault(); cmd('next'); }
  else if (m && k === 'ArrowLeft') { e.preventDefault(); cmd('prev'); }
  else if (m && k === 'ArrowUp') { e.preventDefault(); cmd('volume', Math.min(100, (s?.volume || 0) + 5)); }
  else if (m && k === 'ArrowDown') { e.preventDefault(); cmd('volume', Math.max(0, (s?.volume || 0) - 5)); }
  else if (!m && !e.altKey && k === 'ArrowRight') { e.preventDefault(); cmd('seek', livePos() + 10); }
  else if (!m && !e.altKey && k === 'ArrowLeft') { e.preventDefault(); cmd('seek', Math.max(0, livePos() - 10)); }
  else if (e.altKey && k === 'ArrowLeft') history.back();
  else if (e.altKey && k === 'ArrowRight') history.forward();
  else if (m || e.altKey) return;
  else if (k === 'm' || k === 'M') cmd('mute', !s?.muted);
  else if ((k === 'l' || k === 'L') && s?.track) toggleLike(s.track);
  else if (k === 's' || k === 'S') cmd('shuffle', !s?.shuffle);
  else if (k === 'r' || k === 'R') cmd('repeat', { off: 'all', all: 'one', one: 'off' }[s?.repeat || 'off']);
  else if (k === 'q' || k === 'Q') togglePanel('queue');
  else if (k === 'y' || k === 'Y') togglePanel('lyrics');
  else if (k === 'f' || k === 'F') toggleNowPlaying();
  else if ((k === 'v' || k === 'V') && s?.track) openFxFor(s.track);
  else if (k === 'e' || k === 'E') import('./fxpanel.js').then((m) => m.openEq());
  else if (k === 'b' || k === 'B') post('/api/bg', { on: !s?.bg?.on }).then(() => toast(s?.bg?.on ? 'Background sounds off' : 'Background sounds on')).catch(() => {});
  else if (k === '[') toggleSidebar();
  else if (k === ']') toggleWidePanel();
  else if (k === 'p' || k === 'P') toggleMini();
  else if (k === 'Escape' && document.body.classList.contains('np-open')) toggleNowPlaying(false);
});
// mouse back/forward buttons
document.addEventListener('mouseup', (e) => { if (e.button === 3) history.back(); if (e.button === 4) history.forward(); });

// ------------------------------------------------------------------ live events from the engine
let firstState = true;
let lastAuth = null;
function onState(s) {
  store.state = s;
  store.stateAt = performance.now();
  renderState();
  const authKey = JSON.stringify([s.auth?.yt, s.auth?.account?.name]);
  if (authKey !== lastAuth) {
    const changed = lastAuth !== null;
    lastAuth = authKey;
    renderAccount();
    if (changed) { store.playlists = null; dropCache('/'); renderSidePlaylists(); }
  }
  if (firstState) { firstState = false; renderSidePlaylists(); render(); restorePanel(); }
}
let lastQver = -1;
listen({
  state: (s) => { onState(s); if (s.qver !== lastQver) { lastQver = s.qver; emit('queue-changed'); } },
  queue: () => emit('queue-changed'),
  toast: (t) => toast(t.text, t.kind),
  like: ({ id, status }) => { store.likes.set(id, status); emit('like', { id, status }); },
  downloads: (d) => {
    store.downloads = { ...d, ids: new Set(d.ids || []) };
    const b = $('#dl-badge');
    if (b) b.classList.toggle('on', !!(d.active || d.queued));
    emit('downloads', d);
    refreshPlaying();
  },
  spotify: (s) => emit('spotify', s),
  show: () => { try { window.pywebview?.api?.bring_to_front?.(); } catch {} },
  signin: () => { if (!store.state?.auth?.yt) V.signInGoogle(); },
  offline: () => document.body.classList.add('disconnected'),
  online: () => document.body.classList.remove('disconnected'),
});

get('/api/downloads').then((d) => { store.downloads = { ...d, ids: new Set(d.ids || []) }; }).catch(() => {});

buildSidebar();
buildTop();
buildBar();
initLayout();
$('#main-scroll').addEventListener('scroll', (e) => $('#top').classList.toggle('scrolled', e.target.scrollTop > 8), { passive: true });
window.addEventListener('hashchange', render);
document.addEventListener('contextmenu', (e) => { if (!typing(e)) e.preventDefault(); });
