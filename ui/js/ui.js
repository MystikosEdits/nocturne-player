// Shared state + UI building blocks.
import { I } from './icons.js';
import { get, post, dropCache } from './api.js';

// ------------------------------------------------------------------ store
export const store = {
  state: null, stateAt: 0, queue: null, playlists: null, downloads: { ids: new Set(), active: null, queued: 0 },
  likes: new Map(), os: new URLSearchParams(location.search).get('os') || (navigator.platform.includes('Mac') ? 'mac' : 'win'),
  _subs: new Map(),
};
export function on(evt, fn) {
  if (!store._subs.has(evt)) store._subs.set(evt, new Set());
  store._subs.get(evt).add(fn);
  return () => store._subs.get(evt).delete(fn);
}
export function emit(evt, data) { for (const fn of store._subs.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } }
export const isMac = () => store.os === 'mac';
export const mod = () => (isMac() ? '⌘' : 'Ctrl');

// ------------------------------------------------------------------ dom helpers
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const icon = (name, cls = '') => h('span', { class: `ico ${cls}`, html: I[name] });

export function btn(iconName, title, onClick, cls = '') {
  return h('button', { class: `ibtn ${cls}`, title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onClick(e); } }, icon(iconName));
}

export function pill(label, onClick, { iconName, cls = '' } = {}) {
  return h('button', { class: `pill ${cls}`, onclick: onClick }, iconName ? icon(iconName) : null, label);
}

export function fmtTime(s) {
  if (s === null || s === undefined || isNaN(s)) return '–:––';
  s = Math.max(0, Math.floor(s));
  const h_ = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h_ ? `${h_}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtBytes(b) {
  if (!b) return '0 MB';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  return Math.round(b / 1e6) + ' MB';
}

// ask Google's image servers for the size we actually draw (2x for sharp screens), not 226-544 px
// for a 40 px row thumbnail: far fewer bytes, faster pages
const ART_PX = { xs: 96, sm: 120, bar: 144, lg: 240, avatar: 120, 'avatar-xs': 64, cover: 600, np: 1080, '': 360 };
export function sizedArt(src, px) {
  if (!src) return src;
  if (/googleusercontent\.com|ggpht\.com/.test(src)) return src.replace(/=(w\d+-h\d+|s\d+)[^/?#]*$/, `=w${px}-h${px}-l90-rj`);
  if (/i\.ytimg\.com\/vi\//.test(src) && px <= 160) return src.replace(/\/(hq|maxres|sd)default\.jpg/, '/mqdefault.jpg');
  return src;
}

export function img(src, cls = '', round = false) {
  const wrap = h('div', { class: `art ${cls} ${round ? 'round' : ''}` });
  if (src) {
    const i = h('img', { loading: 'lazy', decoding: 'async', alt: '', draggable: 'false' });
    i.onload = () => wrap.classList.add('ok');
    i.onerror = () => wrap.classList.add('err');
    i.src = sizedArt(src, ART_PX[cls.split(' ')[0]] ?? 360);
    wrap.append(i);
  } else wrap.classList.add('err');
  return wrap;
}

export function go(hash) { if (location.hash !== hash) location.hash = hash; }

export function artistLinks(artists, plain = false) {
  const span = h('span', { class: 'artists' });
  (artists || []).forEach((a, i) => {
    if (i) span.append(', ');
    if (a.id && !plain && /^UC/.test(a.id)) span.append(h('a', { href: `#/artist/${a.id}`, onclick: (e) => e.stopPropagation() }, a.name));
    else span.append(a.name);
  });
  return span;
}

// ------------------------------------------------------------------ toasts
// toast(text, kind, { action: 'Undo', onAction, onDone }): with an action it stays 6 s and has a button; onDone runs
// when it goes away (clicked or not), so a removal can be written only once Undo is no longer possible
export function toast(text, kind = 'info', { action, onAction, onDone } = {}) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind} ${action ? 'has-action' : ''}` }, h('span', null, text));
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
    onDone && onDone();
  };
  if (action) t.append(h('button', { class: 'toast-act', onclick: () => { onAction && onAction(); hide(); } }, action));
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(hide, action ? 6000 : kind === 'error' ? 4500 : 2600);
}

export async function run(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText); return r; } catch (e) { toast(e.message || String(e), 'error'); throw e; }
}

// ------------------------------------------------------------------ modals
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.classList.remove('in'); setTimeout(() => back.remove(), 200); onClose && onClose(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('.modal-back');
    if (all[all.length - 1] !== back) return;     // only the dialog on top
    e.stopPropagation(); close();
  };
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}` },
    h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title), btn('x', 'Close', close)),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, ...actions.map((a) => h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, onclick: async () => { const keep = await a.onClick?.(); if (!keep) close(); } }, a.label))) : null);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', esc, true);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('in'));
  return { close, box };
}

export function prompt(title, placeholder, initial = '') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder, value: initial });
    let done = false;
    const m = modal({
      title, body: input,
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { done = true; resolve(input.value.trim()); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(input.value.trim()); m.close(); } });
    setTimeout(() => input.focus(), 50);
  });
}

// ------------------------------------------------------------------ context menus
let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.querySelectorAll('.menu.submenu').forEach((m) => m.remove());   // never leave a submenu behind
}
// a press inside ANY menu (a submenu is its own element on <body>, not inside openMenu) must not close it: this
// used to close everything on mousedown, so a submenu item's click never ran ("Add to playlist" ▸ did nothing)
document.addEventListener('mousedown', (e) => { if (openMenu && !e.target.closest?.('.menu')) closeMenu(); });
// Esc with a menu open only closes the menu (not the selection / Now Playing behind it)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (openMenu || document.querySelector('.menu'))) { closeMenu(); e.stopImmediatePropagation(); } });
window.addEventListener('blur', closeMenu);

export function menu(x, y, items) {
  closeMenu();
  const el = buildMenu(items);
  document.body.append(el);
  place(el, x, y, x);   // no room on the right: open to the LEFT of the cursor, like a normal menu (was: pinned to the window edge)
  openMenu = el;
  return el;
}

function buildMenu(items) {
  const el = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
    const row = h('div', { class: `menu-item ${it.danger ? 'danger' : ''} ${it.sub ? 'has-sub' : ''}` },
      it.icon ? icon(it.icon) : h('span', { class: 'ico' }), h('span', { class: 'menu-label' }, it.label), it.sub ? icon('right', 'chev') : null);
    if (it.sub) {
      let sub = null, building = false;
      row.addEventListener('mouseenter', async () => {
        if (sub || building) return;          // one submenu per row, even if the mouse re-enters while it loads
        building = true;
        let items2;
        try { items2 = typeof it.sub === 'function' ? await it.sub() : it.sub; } finally { building = false; }
        if (!el.isConnected) return;          // the menu closed while the list was loading
        el.parentElement?.querySelectorAll(':scope > .menu.submenu').forEach((m) => m.remove());   // one submenu open at a time
        sub = buildMenu(items2);
        sub.classList.add('submenu');
        document.body.append(sub);
        const r = row.getBoundingClientRect();
        place(sub, r.right - 4, r.top - 6, r.left);
        const kill = () => { setTimeout(() => { if (sub && !sub.matches(':hover') && !row.matches(':hover')) { sub.remove(); sub = null; } }, 120); };
        row.addEventListener('mouseleave', kill);
        sub.addEventListener('mouseleave', kill);
        const parentRemove = el.remove.bind(el);
        el.remove = () => { sub && sub.remove(); parentRemove(); };
      });
    } else {
      row.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
    }
    el.append(row);
  }
  return el;
}

// x / y / altX are SCREEN positions (clientX, getBoundingClientRect). With Settings -> Size below or above 100% the
// page is CSS-zoomed and style.left/top are in zoomed pixels, so divide by the zoom (at 90% menus opened up-left of the
// cursor and the "Add to playlist" list landed ON the menu instead of beside it).
export const pageZoom = () => parseFloat(document.documentElement.style.zoom || '1') || 1;
function place(el, x, y, altX) {
  const z = pageZoom();
  // the layout size (offset*), not getBoundingClientRect: the menu is still mid "menuin" scale(.97) animation here
  const r = { width: el.offsetWidth * z, height: el.offsetHeight * z };
  const W = innerWidth, H = innerHeight;
  let left = x, top = y;
  if (left + r.width > W - 8) left = altX !== undefined ? altX - r.width + 4 : W - r.width - 8;
  if (top + r.height > H - 8) top = Math.max(8, H - r.height - 8);
  el.style.left = Math.max(8, left) / z + 'px';
  el.style.top = Math.max(8, top) / z + 'px';
}

// ------------------------------------------------------------------ playlists cache (for "Add to playlist")
export async function myPlaylists(force = false) {
  if (!store.state?.auth?.yt) return [];
  if (!store.playlists || force) {
    try { store.playlists = (await get('/api/library/playlists')).items || []; } catch { store.playlists = []; }
    emit('playlists', store.playlists);
  }
  return store.playlists;
}

export async function addToPlaylistMenu(tracks) {
  // the engine needs version_id: a My version goes into the playlist as its own entry, with its effects remembered
  const items = tracks.map((t) => ({ id: t.id, version_id: t.version_id || undefined }));
  const pls = (await myPlaylists()).filter((p) => p.id !== 'LM' && !/^(RDCLAK|RDAT|RDEM)/.test(p.id) && p.id !== 'SE');
  return [
    { label: 'New playlist…', icon: 'plus', onClick: async () => {
      const name = await prompt('New playlist', 'Playlist name');
      if (!name) return;
      await run(() => post('/api/playlist/create', { title: name, tracks: items }));
      dropCache('/api/library'); myPlaylists(true);
    } },
    pls.length ? '-' : null,
    ...pls.slice(0, 40).map((p) => ({ label: p.title, icon: 'queue', onClick: () => run(() => post('/api/playlist/add', { playlistId: p.id, tracks: items, title: p.title })).then(() => dropCache('/api/playlist/' + p.id)) })),
  ];
}

// ------------------------------------------------------------------ playing things
export function isLiked(t) {
  if (store.likes.has(t.id)) return store.likes.get(t.id) === 'LIKE';
  return t.like === 'LIKE';
}

export async function toggleLike(t) {
  if (!store.state?.auth?.yt) { needSignIn('like songs'); return; }
  const status = isLiked(t) ? 'INDIFFERENT' : 'LIKE';
  store.likes.set(t.id, status);
  emit('like', { id: t.id, status });
  try { await post('/api/like', { id: t.id, status }); dropCache('/api/playlist/LM'); }
  catch (e) { store.likes.set(t.id, status === 'LIKE' ? 'INDIFFERENT' : 'LIKE'); emit('like', { id: t.id }); toast(e.message, 'error'); }
}

export function needSignIn(what) {
  toast(`Sign in to YouTube Music to ${what} (Settings)`, 'error');
}

export const playTracks = (tracks, index = 0, context = null, shuffle = undefined) =>
  run(() => post('/api/play', { tracks, index, context, shuffle }));
export const playKind = (kind, id, extra = {}) => run(() => post('/api/play', { kind, id, ...extra }));

export function playItem(item, opts = {}) {
  if (item.kind === 'song' || item.kind === 'video' || (!item.kind && item.id && item.title && item.artists)) return playKind('song', item.id, { track: item });
  if (item.kind === 'playlist') return playKind('playlist', item.id, opts);
  if (item.kind === 'album') return playKind('album', item.id, opts);
  if (item.kind === 'artist') return playKind('artist', item.id, opts);
}

export function openItem(item) {
  if (item.kind === 'playlist') go(`#/playlist/${item.id}`);
  else if (item.kind === 'album') go(`#/album/${item.id}`);
  else if (item.kind === 'artist') go(`#/artist/${item.id}`);
  else if (item.kind === 'song' || item.kind === 'video') playItem(item);
}

export function copyLink(t, kind = 'song') {
  const url = kind === 'song' ? `https://music.youtube.com/watch?v=${t.id}` : kind === 'playlist' ? `https://music.youtube.com/playlist?list=${t.id}` : kind === 'album' ? `https://music.youtube.com/browse/${t.id}` : `https://music.youtube.com/channel/${t.id}`;
  navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast(url));
}

export function openFxFor(t) { import('./fxpanel.js').then((m) => m.openFx(t)); }

export function trackMenu(t, x, y, opts = {}) {
  const dl = store.downloads.ids.has(t.id);
  const isVersion = !!t.version_id;
  const items = [
    { label: 'Play next', icon: 'playNext', onClick: () => run(() => post('/api/queue/add', { tracks: [t], next: true })) },
    { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: [t] })) },
    { label: 'Start radio', icon: 'radio', onClick: () => run(() => post('/api/play', { kind: 'radio', videoId: t.id, title: `${t.title} radio` })) },
    { label: isVersion ? 'Edit effects…' : 'Slowed / reverb / sped up…', icon: 'wand', onClick: () => openFxFor(t) },
    isVersion ? { label: 'Rename version', icon: 'wand', onClick: async () => {
      const name = await prompt('Rename version', 'Name', t.title);
      if (name) { await run(() => post('/api/versions/rename', { vid: t.version_id, title: name })); emit('versions-changed'); }
    } } : null,
    isVersion ? { label: 'Delete version', icon: 'trash', danger: true, onClick: async () => {
      const r = await run(() => post('/api/versions/delete', { vid: t.version_id }));
      emit('versions-changed');
      if (r?.version) toast(`Deleted “${t.title}”`, 'info', { action: 'Undo', onAction: () => post('/api/versions/restore', { version: r.version }).then(() => emit('versions-changed')).catch((e) => toast(e.message, 'error')) });
    } } : null,
    '-',
    { label: isLiked(t) ? 'Remove from liked songs' : 'Like', icon: isLiked(t) ? 'heartFill' : 'heart', onClick: () => toggleLike(t) },
    store.state?.auth?.yt ? { label: 'Add to playlist', icon: 'plus', sub: () => addToPlaylistMenu([t]) } : null,
    { label: dl ? 'Remove download' : 'Download', icon: dl ? 'downloaded' : 'download', onClick: () => dl ? run(() => post('/api/downloads/remove', { ids: [t.id] })) : run(() => post('/api/downloads/add', { tracks: [t] })) },
    '-',
    t.artists?.find((a) => a.id && /^UC/.test(a.id)) ? { label: 'Go to artist', icon: 'user', onClick: () => go(`#/artist/${t.artists.find((a) => a.id && /^UC/.test(a.id)).id}`) } : null,
    t.album?.id ? { label: 'Go to album', icon: 'album', onClick: () => go(`#/album/${t.album.id}`) } : null,
    { label: 'Copy link', icon: 'link', onClick: () => copyLink(t) },
    ...(opts.extra || []),
  ];
  menu(x, y, items);
}

export function collectionMenu(item, x, y, extra = []) {
  menu(x, y, [
    { label: 'Play', icon: 'play', onClick: () => playItem(item) },
    { label: 'Shuffle', icon: 'shuffle', onClick: () => playItem(item, { shuffle: true }) },
    item.kind !== 'artist' ? { label: 'Play next', icon: 'playNext', onClick: () => run(() => post('/api/queue/add', { kind: item.kind, id: item.id, next: true })) } : null,
    item.kind !== 'artist' ? { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { kind: item.kind, id: item.id })) } : null,
    item.kind === 'artist' ? { label: 'Artist radio', icon: 'radio', onClick: () => playKind('artist', item.id, { radio: true }) } : null,
    item.kind === 'playlist' || item.kind === 'album' ? { label: 'Download', icon: 'download', onClick: () => run(() => post('/api/downloads/add', { kind: item.kind, id: item.id })) } : null,
    '-',
    { label: 'Copy link', icon: 'link', onClick: () => copyLink(item, item.kind) },
    ...(item.kind === 'playlist' && store.playlistMenuExtra ? store.playlistMenuExtra(item) : []),
    ...extra,
  ]);
}

// ------------------------------------------------------------------ hover prefetch
let hoverTimer = null;
export function prefetchOnHover(el, getIds) {
  el.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { const ids = getIds(); if (ids?.length) post('/api/prefetch', { ids }).catch(() => {}); }, 220);
  });
  el.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
}

// ------------------------------------------------------------------ track lists (tracklist.js)
// hovering a playlist / album / artist loads it in the background, so the click opens instantly
let pageHoverTimer = null;
export function prefetchPageOnHover(el, item) {
  const path = item.kind === 'playlist' ? `/api/playlist/${item.id}` : item.kind === 'album' ? `/api/album/${item.id}` : item.kind === 'artist' ? `/api/artist/${item.id}` : null;
  if (!path) return;
  el.addEventListener('mouseenter', () => {
    clearTimeout(pageHoverTimer);
    pageHoverTimer = setTimeout(() => import('./api.js').then((a) => a.cached(path, item.kind === 'playlist' ? 60000 : 600000)).catch(() => {}), 250);
  });
  el.addEventListener('mouseleave', () => clearTimeout(pageHoverTimer));
}

export function currentId() { return store.state?.track?.id; }

// keep "now playing" highlight + like hearts in sync everywhere
export function refreshPlaying() {
  const id = currentId();
  const paused = store.state?.paused;
  document.querySelectorAll('.trow[data-tid]').forEach((r) => {
    const on = r.dataset.tid === id;
    r.classList.toggle('playing', on);
    r.classList.toggle('paused', on && paused);
    const pb = r.querySelector('.rowplay');
    if (pb) pb.innerHTML = I[on && !paused ? 'pause' : 'play'];
  });
  document.querySelectorAll('.qcard[data-tid]').forEach((c) => c.classList.toggle('playing', c.dataset.tid === id));
}
on('like', ({ id, status }) => {
  document.querySelectorAll(`.trow[data-tid="${CSS.escape(id)}"] .like`).forEach((b) => {
    const liked = (status || store.likes.get(id)) === 'LIKE';
    b.classList.toggle('on', liked);
    b.innerHTML = I[liked ? 'heartFill' : 'heart'];
  });
});

// ------------------------------------------------------------------ cards + shelves
export function card(item) {
  const isTrack = item.kind === 'song' || item.kind === 'video';
  const c = h('div', { class: `card ${item.round ? 'artist' : ''} ${isTrack && item.type === 'video' ? 'video' : ''}`, dataset: isTrack ? { tid: item.id } : {} });
  const play = h('button', { class: 'cardplay', title: 'Play', onclick: (e) => { e.stopPropagation(); playItem(item); } }, icon('play'));
  c.append(h('div', { class: 'card-art' }, img(item.thumb, '', item.round), item.kind !== 'podcast' ? play : null),
    h('div', { class: 'card-title', title: item.title }, item.title, item.explicit ? h('span', { class: 'explicit' }, 'E') : null),
    h('div', { class: 'card-sub' }, isTrack ? artistLinks(item.artists) : (item.sub || '')));
  c.addEventListener('click', () => openItem(item));
  c.addEventListener('contextmenu', (e) => { e.preventDefault(); isTrack ? trackMenu(item, e.clientX, e.clientY) : collectionMenu(item, e.clientX, e.clientY); });
  if (isTrack) prefetchOnHover(c, () => [item.id]);
  else prefetchPageOnHover(c, item);
  return c;
}

/* A SIDEWAYS ROW ONLY SCROLLS SIDEWAYS ON PURPOSE (Grant, Nov 20: "each section in the home page should only scroll in
   a way that is necessary"). A touchpad swipe down the page is never perfectly vertical, and every shelf under the
   pointer took the sideways part and drifted. Now a mostly-vertical gesture moves the PAGE only; the row moves on a
   clearly sideways swipe, Shift + wheel, or its arrows. A pure vertical wheel is left to the browser (smooth scrolling). */
export function sidewaysOnly(row) {
  row.addEventListener('wheel', (e) => {
    if (e.shiftKey || e.ctrlKey) return;
    const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
    if (ax > ay * 1.5) return;                 // a real sideways swipe: the row scrolls
    if (!ax) return;                           // straight down: the browser scrolls the page by itself
    e.preventDefault();                        // diagonal: page only
    const page = row.closest('#main-scroll, .np-body, .modal-body') || document.getElementById('main-scroll');
    if (page) page.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page.clientHeight : 1);
  }, { passive: false });
}

export function shelf(s, { compactTracks = true } = {}) {
  const sec = h('section', { class: 'shelf' });
  const head = h('div', { class: 'shelf-head' }, h('h2', null, s.title));
  sec.append(head);
  if (s.type === 'tracks' && compactTracks) {
    // Quick-picks style grid of compact rows
    const grid = h('div', { class: 'qgrid' });
    s.items.forEach((t, i) => {
      const r = h('div', { class: `qcard ${currentId() === t.id ? 'playing' : ''}`, dataset: { tid: t.id } },
        h('div', { class: 'qart' }, img(t.thumb, 'sm'), h('button', { class: 'qplay', onclick: (e) => { e.stopPropagation(); playTracks(s.items, i, { type: 'shelf', title: s.title }); } }, icon('play'))),
        h('div', { class: 'tt' }, h('div', { class: 'tname' }, t.title, t.explicit ? h('span', { class: 'explicit' }, 'E') : null), h('div', { class: 'tsub' }, artistLinks(t.artists))),
        btn('more', 'More', (e) => trackMenu(t, e.clientX, e.clientY)));
      r.addEventListener('click', () => playTracks(s.items, i, { type: 'shelf', title: s.title }));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, e.clientX, e.clientY); });
      prefetchOnHover(r, () => [t.id]);
      grid.append(r);
    });
    sec.append(grid);
    head.append(h('div', { class: 'shelf-nav' }, pill('Play all', () => playTracks(s.items, 0, { type: 'shelf', title: s.title }), { iconName: 'play' })));
    return sec;
  }
  const row = h('div', { class: 'cards-row' });
  s.items.forEach((it) => row.append(card(it)));
  sidewaysOnly(row);
  const nav = h('div', { class: 'shelf-nav' },
    btn('left', 'Back', () => row.scrollBy({ left: -row.clientWidth * 0.85, behavior: 'smooth' })),
    btn('right', 'More', () => row.scrollBy({ left: row.clientWidth * 0.85, behavior: 'smooth' })));
  head.append(nav);
  const upd = () => {
    nav.children[0].disabled = row.scrollLeft < 8;
    nav.children[1].disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 8;
    const fits = row.scrollWidth <= row.clientWidth + 8;
    nav.style.visibility = fits ? 'hidden' : 'visible';
    row.classList.toggle('fits', fits);        // a row that fits doesn't scroll at all
  };
  row.addEventListener('scroll', upd, { passive: true });
  requestAnimationFrame(upd);
  new ResizeObserver(upd).observe(row);
  sec.append(row);
  return sec;
}

export function grid(items) {
  const g = h('div', { class: 'cards-grid' });
  items.forEach((it) => g.append(card(it)));
  return g;
}

export function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico', html: I[iconName] }), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'empty-text' }, text) : null, action || null);
}

export function skeleton(kind = 'shelves') {
  const s = h('div', { class: 'skel-wrap' });
  if (kind === 'list') {
    for (let i = 0; i < 10; i++) s.append(h('div', { class: 'skel-row' }, h('div', { class: 'skel sq' }), h('div', { class: 'skel-lines' }, h('div', { class: 'skel l1' }), h('div', { class: 'skel l2' }))));
  } else {
    for (let k = 0; k < 3; k++) {
      s.append(h('div', { class: 'skel title' }));
      const r = h('div', { class: 'skel-cards' });
      for (let i = 0; i < 7; i++) r.append(h('div', { class: 'skel-card' }, h('div', { class: 'skel sq' }), h('div', { class: 'skel l1' }), h('div', { class: 'skel l2' })));
      s.append(r);
    }
  }
  return s;
}

// what a failed page says: plain words for the usual causes, the raw error only as a tooltip
export function errorBox(e, retry) {
  const raw = e?.message || String(e);
  let title = 'Something went wrong', text = raw;
  if (/ConnectionError|HTTPSConnectionPool|Max retries|getaddrinfo|NameResolution|timed out|Temporary failure|Network is unreachable|URLError/i.test(raw)) {
    title = 'Can’t reach YouTube Music'; text = 'Check your internet connection, then try again. Downloaded songs still play.';
  } else if (/Sign in|signed in|401|403|Forbidden/i.test(raw)) {
    title = 'Sign-in needed'; text = 'Connect YouTube Music in Settings to open this.';
  } else if (/404|not found|KeyError|NoneType/i.test(raw)) {
    title = 'Couldn’t open this'; text = 'YouTube Music didn’t return it. It may have been removed or made private.';
  }
  const box = empty('info', title, text, retry ? h('button', { class: 'btn', onclick: retry }, 'Try again') : null);
  box.title = raw;
  return box;
}

// accent colour from artwork
const colorCache = new Map();
export async function artColor(url) {
  if (!url) return null;
  if (colorCache.has(url)) return colorCache.get(url);
  try {
    const { rgb } = await get('/api/color?u=' + encodeURIComponent(url));
    colorCache.set(url, rgb);
    return rgb;
  } catch { return null; }
}
