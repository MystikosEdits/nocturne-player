// Song lists (playlist, album, liked, versions, downloads, search, history): rows, long-list windowing, multi-select
// with bulk actions, drag onto a sidebar playlist / the queue, find + sort inside the list, jump to the playing song.
//   click = select · Ctrl/⌘+click = add/remove · Shift+click = range · double-click / Enter = play
//   Ctrl/⌘+A = select all · Esc = clear · Delete = remove from your playlist (with Undo) · Ctrl/⌘+F = find in list
import { I, eq } from './icons.js';
import { post, cmd, dropCache } from './api.js';
import {
  h, icon, btn, img, store, on, fmtTime, artistLinks, isLiked, toggleLike, trackMenu, menu, run, toast,
  addToPlaylistMenu, playTracks, prefetchOnHover, pageZoom, currentId, mod,
} from './ui.js';

const rowH = () => (document.body.classList.contains('compact') ? 46 : 56);
const sortPrefs = new Map();          // context id -> sort key, for this session
let active = null;                    // the list that has a selection (one at a time)

const SORTS = [['', 'Custom order'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['dur', 'Duration']];
const sortVal = {
  title: (t) => (t.title || '').toLocaleLowerCase(),
  artist: (t) => (t.artist || (t.artists || []).map((a) => a.name).join(', ')).toLocaleLowerCase(),
  album: (t) => (t.album?.name || '').toLocaleLowerCase(),
  dur: (t) => t.dur || 0,
};
const matches = (t, q) => [t.title, t.artist, ...(t.artists || []).map((a) => a.name), t.album?.name]
  .some((s) => s && s.toLocaleLowerCase().includes(q));

/** Drag payload shared with the sidebar playlists and the queue panel. */
export const dragged = { tracks: null };

function dragImage(n) {
  const g = h('div', { class: 'drag-ghost' }, icon('music'), n === 1 ? '1 song' : `${n} songs`);
  document.body.append(g);
  setTimeout(() => g.remove(), 0);
  return g;
}

export function trackList(tracks, opts = {}) {
  // opts: context, showAlbum, showArt (default true), header, playlistId + owned (remove), onPlay(i), extraMenu(t, i),
  //       tools (find + sort + locate, returned as list.tools for the page's action row), showViews, badgeVideos
  const showArt = opts.showArt !== false;
  const list = h('div', { class: `tracks ${showArt ? '' : 'noart'} ${opts.showAlbum === false ? 'noalbum' : ''}` });
  if (opts.header !== false) {
    list.append(h('div', { class: 'trow thead' },
      h('div', { class: 'c-num' }, '#'), h('div', { class: 'c-title' }, 'Title'),
      opts.showAlbum === false ? null : h('div', { class: 'c-album' }, 'Album'),
      h('div', { class: 'c-dur' }, icon('clock')), h('div', { class: 'c-act' })));
  }
  const body = h('div', { class: 'tbody' });
  list.append(body);

  const ctxKey = opts.context ? `${opts.context.type}:${opts.context.id || opts.context.title}` : null;
  const st = { q: '', sort: (ctxKey && sortPrefs.get(ctxKey)) || '', sel: new Set(), anchor: -1, view: [] };
  const custom = () => !st.q && !st.sort;

  const compute = () => {
    let v = tracks.map((t, i) => ({ t, i }));
    if (st.q) v = v.filter(({ t }) => matches(t, st.q));
    if (st.sort) {
      const f = sortVal[st.sort];
      v.sort((a, b) => { const x = f(a.t), y = f(b.t); return x < y ? -1 : x > y ? 1 : a.i - b.i; });
    }
    st.view = v;
  };

  const playAt = (k) => {
    // the list as you see it: a sorted / filtered list plays in that order (like Spotify)
    if (custom() && opts.onPlay) return opts.onPlay(st.view[k].i);
    if (custom()) return playTracks(tracks, st.view[k].i, opts.context || null);
    return playTracks(st.view.map((x) => x.t), k, opts.context || null);
  };
  const selected = () => st.view.filter(({ i }) => st.sel.has(i)).map(({ t }) => t);

  // ---------------- selection
  const paintSel = () => {
    body.querySelectorAll('.trow').forEach((r) => r.classList.toggle('sel', st.sel.has(+r.dataset.i)));
    // the bar only for 2+ songs: one selected song has its own buttons + menu, and a bar popping up on every click
    // (or right-click) just covered the bottom rows
    if (st.sel.size) { active = handle; if (st.sel.size > 1) showSelBar(handle); else hideSelBar(); }
    else if (active === handle) { active = null; hideSelBar(); }
  };
  const clearSel = () => { if (st.sel.size) { st.sel.clear(); paintSel(); } };
  const clickRow = (e, k) => {
    const i = st.view[k].i;
    if (active && active !== handle) active.clear();
    if (e.shiftKey && st.anchor >= 0) {
      const [a, b] = [Math.min(st.anchor, k), Math.max(st.anchor, k)];
      if (!(e.ctrlKey || e.metaKey)) st.sel.clear();
      for (let x = a; x <= b; x++) st.sel.add(st.view[x].i);
    } else if (e.ctrlKey || e.metaKey) {
      if (st.sel.has(i)) st.sel.delete(i); else st.sel.add(i);
      st.anchor = k;
    } else {
      st.sel.clear(); st.sel.add(i); st.anchor = k;
    }
    paintSel();
  };

  // ---------------- removing (playlists you own): hidden at once, written to YouTube when the Undo toast is gone
  const canRemove = () => !!(opts.playlistId && opts.owned);
  const removeTracks = (ts) => {
    ts = ts.filter((t) => t.setVideoId);
    if (!ts.length) return;
    const gone = new Set(ts);
    const before = tracks.slice();
    for (let k = tracks.length - 1; k >= 0; k--) if (gone.has(tracks[k])) tracks.splice(k, 1);
    st.sel.clear(); paintSel(); redraw();
    const pid = opts.playlistId;
    let undone = false;
    toast(ts.length === 1 ? `Removed “${ts[0].title}”` : `Removed ${ts.length} songs`, 'info', {
      action: 'Undo',
      onAction: () => { undone = true; tracks.splice(0, tracks.length, ...before); redraw(); },
      onDone: () => {
        if (undone) return;
        run(() => post('/api/playlist/remove', { playlistId: pid, items: ts })).then(() => dropCache('/api/playlist/' + pid)).catch(() => {
          // YouTube refused: put them back so the list shows the truth
          tracks.splice(0, tracks.length, ...before); if (body.isConnected) redraw();
        });
      },
    });
    opts.onChanged && opts.onChanged(tracks);
  };

  // ---------------- bulk actions (selection bar + right-click on a selection)
  const bulkItems = () => {
    const ts = selected();
    const n = ts.length;
    return [
      { label: `Play ${n} songs`, icon: 'play', onClick: () => playTracks(ts, 0, opts.context || null, false) },
      { label: 'Play next', icon: 'playNext', onClick: () => run(() => post('/api/queue/add', { tracks: ts, next: true })) },
      { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: ts })) },
      store.state?.auth?.yt ? { label: 'Add to playlist', icon: 'plus', sub: () => addToPlaylistMenu(ts) } : null,
      { label: 'Download', icon: 'download', onClick: () => run(() => post('/api/downloads/add', { tracks: ts })) },
      canRemove() ? '-' : null,
      canRemove() ? { label: `Remove ${n} from this playlist`, icon: 'trash', danger: true, onClick: () => removeTracks(ts) } : null,
    ];
  };

  const rowExtra = (t, i) => {
    const out = [];
    if (canRemove() && t.setVideoId) out.push('-', { label: 'Remove from this playlist', icon: 'trash', danger: true, onClick: () => removeTracks([t]) });
    if (opts.extraMenu) out.push(...opts.extraMenu(t, i));
    return out;
  };

  // ---------------- one row
  const row = (k) => {
    const { t, i } = st.view[k];
    const isCur = () => currentId() === t.id;
    const r = h('div', { class: `trow ${isCur() ? 'playing' : ''} ${t.unavailable ? 'dim' : ''} ${st.sel.has(i) ? 'sel' : ''}`, draggable: 'true', dataset: { tid: t.id, i: String(i) } });
    const num = h('div', { class: 'c-num' }, h('span', { class: 'n' }, String(k + 1)), h('span', { class: 'eqw', html: eq() }),
      // the playing state is read on click (it was fixed when the row was drawn: a row drawn before its song started
      // restarted the song instead of pausing it)
      h('button', { class: 'rowplay', title: 'Play', onclick: (e) => { e.stopPropagation(); if (isCur()) cmd('toggle'); else playAt(k); } }, icon('play')));
    const title = h('div', { class: 'c-title' },
      showArt ? img(t.thumb, 'sm', false) : null,
      h('div', { class: 'tt' },
        h('div', { class: 'tname' }, t.title, t.explicit ? h('span', { class: 'explicit', title: 'Explicit' }, 'E') : null,
          t.type === 'video' && opts.badgeVideos ? h('span', { class: 'badge' }, 'Video') : null,
          store.downloads.ids.has(t.id) ? h('span', { class: 'dlmark', title: 'Downloaded', html: I.downloaded }) : null),
        h('div', { class: 'tsub' }, artistLinks(t.artists), t.views && opts.showViews ? h('span', { class: 'muted' }, ` • ${t.views}`) : null)));
    const album = opts.showAlbum === false ? null : h('div', { class: 'c-album' }, t.album?.id ? h('a', { href: `#/album/${t.album.id}`, onclick: (e) => e.stopPropagation() }, t.album.name) : (t.album?.name || ''));
    const like = h('button', { class: `ibtn like ${isLiked(t) ? 'on' : ''}`, title: 'Like', onclick: (e) => { e.stopPropagation(); toggleLike(t); } }, icon(isLiked(t) ? 'heartFill' : 'heart'));
    const more = btn('more', 'More', (e) => trackMenu(t, e.clientX, e.clientY, { extra: rowExtra(t, i) }));
    r.append(...[num, title, album, h('div', { class: 'c-dur' }, t.dur ? fmtTime(t.dur) : ''), h('div', { class: 'c-act' }, like, more)].filter(Boolean));
    r.addEventListener('click', (e) => clickRow(e, k));
    r.addEventListener('dblclick', (e) => { if (!e.target.closest('button, a')) playAt(k); });
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (st.sel.has(i) && st.sel.size > 1) return menu(e.clientX, e.clientY, bulkItems());
      if (!st.sel.has(i)) { if (active && active !== handle) active.clear(); st.sel.clear(); st.sel.add(i); st.anchor = k; paintSel(); }
      trackMenu(t, e.clientX, e.clientY, { extra: rowExtra(t, i) });
    });
    r.addEventListener('dragstart', (e) => {
      const ts = st.sel.has(i) && st.sel.size > 1 ? selected() : [t];
      dragged.tracks = ts;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', ts.map((x) => `${x.title} — ${x.artist || ''}`).join('\n'));
      try { e.dataTransfer.setDragImage(dragImage(ts.length), 14, 14); } catch {}
      document.body.classList.add('dragging-songs');
    });
    r.addEventListener('dragend', () => { dragged.tracks = null; document.body.classList.remove('dragging-songs'); document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });
    prefetchOnHover(r, () => [t.id]);
    return r;
  };

  // ---------------- drawing (long lists: only the rows near the screen exist)
  let rendered = new Map();
  let virtual = false;
  const scroller = () => document.getElementById('main-scroll');
  const update = () => {
    const sc = scroller();
    if (!body.isConnected) { detach(); return; }      // the page changed: stop listening (these used to pile up)
    if (!virtual || !sc) return;
    const RH = rowH();
    // getBoundingClientRect is in screen pixels; rows and clientHeight are in CSS pixels. Under Settings -> Size the
    // two differ (x0.9 at 90%), and deep in a long playlist the rows were drawn far from the screen: all blank.
    const top = (body.getBoundingClientRect().top - sc.getBoundingClientRect().top) / pageZoom();
    const first = Math.max(0, Math.floor(-top / RH) - 10);
    const last = Math.min(st.view.length - 1, Math.ceil((-top + sc.clientHeight) / RH) + 10);
    for (const [k, el] of rendered) if (k < first || k > last) { el.remove(); rendered.delete(k); }
    for (let k = first; k <= last; k++) {
      if (rendered.has(k)) continue;
      const el = row(k);
      el.style.position = 'absolute';
      el.style.top = k * RH + 'px';
      el.style.left = '0'; el.style.right = '0';
      body.append(el);
      rendered.set(k, el);
    }
  };
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    scroller()?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    scroller()?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    if (active === handle) { active = null; hideSelBar(); }
  };
  const redraw = () => {
    compute();
    body.replaceChildren();
    rendered = new Map();
    virtual = st.view.length > 120 && opts.virtual !== false;
    body.classList.toggle('virtual', virtual);
    body.style.height = virtual ? st.view.length * rowH() + 'px' : '';
    if (virtual) { requestAnimationFrame(() => { attach(); update(); }); }
    else st.view.forEach((_, k) => body.append(row(k)));
    if (!st.view.length && st.q) body.append(h('div', { class: 'list-none muted' }, `Nothing matches “${st.q}”`));
    locateBtn && (locateBtn.style.display = st.view.some(({ t }) => t.id === currentId()) ? '' : 'none');
  };

  // ---------------- find + sort + jump to the playing song (in the page's action row)
  let locateBtn = null;
  if (opts.tools) {
    const input = h('input', { class: 'lfind-input', placeholder: 'Find in list', spellcheck: 'false', 'aria-label': 'Find in this list' });
    let tm = null;
    input.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { st.q = input.value.trim().toLocaleLowerCase(); st.sel.clear(); paintSel(); redraw(); }, 120); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; st.q = ''; redraw(); input.blur(); } });
    const find = h('label', { class: 'lfind', title: `Find in this list (${mod()} F)` }, icon('search'), input);
    const sortLabel = () => (SORTS.find(([k]) => k === st.sort) || SORTS[0])[1];
    const sortBtn = h('button', { class: 'pill lsort', title: 'Sort this list', onclick: (e) => {
      const r = sortBtn.getBoundingClientRect();
      menu(r.left, r.bottom + 4, SORTS.map(([k, label]) => ({ label, icon: k === st.sort ? 'check' : null, onClick: () => {
        st.sort = k; if (ctxKey) sortPrefs.set(ctxKey, k);
        sortBtn.replaceChildren(icon('sort'), sortLabel()); st.sel.clear(); paintSel(); redraw();
      } })));
      e.stopPropagation();
    } }, icon('sort'), sortLabel());
    locateBtn = btn('locate', 'Go to the playing song', () => {
      const k = st.view.findIndex(({ t }) => t.id === currentId());
      if (k < 0) return;
      const sc = scroller();
      if (virtual && sc) {
        const top = (body.getBoundingClientRect().top - sc.getBoundingClientRect().top) / pageZoom() + sc.scrollTop;
        sc.scrollTo({ top: top + k * rowH() - sc.clientHeight / 3, behavior: 'smooth' });
      } else body.children[k]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 'locate-btn');
    list.tools = h('div', { class: 'ltools' }, find, sortBtn, locateBtn);
    // the playing song changed: show / hide the jump button (the listener goes when the list leaves the page)
    const offTrack = on('track', () => { if (!list.isConnected) { offTrack(); return; } locateBtn.style.display = st.view.some(({ t }) => t.id === currentId()) ? '' : 'none'; });
    list.focusFind = () => { input.focus(); input.select(); };
  }

  const handle = {
    list, clear: clearSel, items: bulkItems, selected,
    selectAll: () => { if (active && active !== handle) active.clear(); st.view.forEach(({ i }) => st.sel.add(i)); paintSel(); },
    playSelected: () => { const ts = selected(); if (ts.length) playTracks(ts, 0, opts.context || null, false); },
    removeSelected: () => { if (canRemove()) removeTracks(selected()); },
    focusFind: () => list.focusFind?.(),
  };
  list._list = handle;
  list._refresh = redraw;
  redraw();
  return list;
}

// ------------------------------------------------------------------ the selection bar (bottom of the page)
let bar = null;
function showSelBar(hd) {
  const main = document.getElementById('main');
  if (!bar) { bar = h('div', { class: 'selbar' }); main.append(bar); }
  const n = hd.selected().length;
  const acts = hd.items().filter((x) => x && x !== '-');
  bar.replaceChildren(h('span', { class: 'selbar-n' }, n === 1 ? '1 selected' : `${n} selected`),
    ...acts.map((a) => h('button', { class: `pill ${a.danger ? 'danger' : ''}`, title: a.label, onclick: (e) => {
      e.stopPropagation();
      if (a.sub) { const r = e.currentTarget.getBoundingClientRect(); Promise.resolve(a.sub()).then((items) => menu(r.left, r.top - 8 - items.length * 37, items)); }
      else a.onClick();
    } }, icon(a.icon), a.label.replace(/^Play \d+ songs$/, 'Play').replace(/^Remove \d+ from this playlist$/, 'Remove'))),
    btn('x', 'Clear selection (Esc)', () => hd.clear(), 'sm'));
  bar.classList.add('in');
}
function hideSelBar() { bar?.classList.remove('in'); }

/** Keys for the list on the page (app.js calls this first; true = handled). */
export function listKeys(e) {
  const m = e.ctrlKey || e.metaKey;
  const lists = [...document.querySelectorAll('#view .tracks')].map((l) => l._list).filter(Boolean);
  const main = lists.sort((a, b) => b.list.querySelectorAll('.trow').length - a.list.querySelectorAll('.trow').length)[0];
  if (m && e.key.toLowerCase() === 'f' && main?.list.tools) { e.preventDefault(); main.focusFind(); return true; }
  if (m && e.key.toLowerCase() === 'a' && main) { e.preventDefault(); main.selectAll(); return true; }
  if (!active) return false;
  if (e.key === 'Escape') { active.clear(); return true; }
  if (e.key === 'Enter') { active.playSelected(); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') { active.removeSelected(); return true; }
  return false;
}

// a press anywhere but a song row, the selection bar or a menu clears the selection
document.addEventListener('mousedown', (e) => {
  if (active && !e.target.closest?.('.trow, .selbar, .menu, .modal-back')) active.clear();
});
on('route', () => { if (active) active.clear(); hideSelBar(); });
