// Bottom player bar, queue + lyrics side panel, and the full Now Playing view.
import { I } from './icons.js';
import { get, post, cmd } from './api.js';
import {
  h, icon, btn, img, store, on, emit, fmtTime, artistLinks, toggleLike, isLiked, trackMenu, menu, run, go, artColor,
  refreshPlaying, toast, openFxFor,
} from './ui.js';
import { onArt } from './theme.js';
import { miniBtn, panelWideBtn } from './layout.js';
import { describeFx } from './fxpanel.js';

const $ = (s, r = document) => r.querySelector(s);

// ------------------------------------------------------------------ position clock
export function livePos() {
  const s = store.state;
  if (!s) return 0;
  if (s.paused || s.loading || !s.track) return s.pos || 0;
  return Math.min((s.pos || 0) + ((performance.now() - store.stateAt) / 1000) * (s.speed || 1), s.dur || Infinity);
}

// ------------------------------------------------------------------ bar
let els = {};
let dragging = null;

export function buildBar() {
  const bar = $('#bar');
  els.art = h('div', { class: 'bar-art', title: 'Now playing (F)', onclick: () => toggleNowPlaying() });
  els.title = h('div', { class: 'bar-title' });
  els.artist = h('div', { class: 'bar-artist' });
  els.fxChip = h('button', { class: 'fx-chip', title: 'Edit this version', onclick: () => {
    const t = store.state?.track;
    if (t?.fx) openFxFor(t); else import('./fxpanel.js').then((m) => m.openFx(null, { global: true }));
  } });
  els.like = h('button', { class: 'ibtn like', title: 'Like (L)', onclick: () => store.state?.track && toggleLike(store.state.track) }, icon('heart'));
  const left = h('div', { class: 'bar-left' }, els.art, h('div', { class: 'bar-text' }, els.title, h('div', { class: 'bar-sub' }, els.fxChip, els.artist)), els.like);

  els.shuffle = btn('shuffle', 'Shuffle (S)', () => cmd('shuffle', !store.state?.shuffle));
  els.prev = btn('prev', 'Previous', () => cmd('prev'), 'tr');
  els.play = h('button', { class: 'playbtn', title: 'Play (Space)', onclick: () => cmd('toggle') }, icon('play'));
  els.next = btn('next', 'Next', () => cmd('next'), 'tr');
  els.repeat = btn('repeat', 'Repeat (R)', () => cmd('repeat', { off: 'all', all: 'one', one: 'off' }[store.state?.repeat || 'off']));
  els.cur = h('div', { class: 'time' }, '0:00');
  els.dur = h('div', { class: 'time right' }, '0:00');
  els.fill = h('div', { class: 'prog-fill' });
  els.thumb = h('div', { class: 'prog-thumb' });
  els.tip = h('div', { class: 'prog-tip' });
  els.prog = h('div', { class: 'prog' }, h('div', { class: 'prog-track' }, els.fill), els.thumb, els.tip);
  const center = h('div', { class: 'bar-center' },
    h('div', { class: 'controls' }, els.shuffle, els.prev, els.play, els.next, els.repeat),
    h('div', { class: 'progress' }, els.cur, els.prog, els.dur));

  els.quality = h('div', { class: 'quality', title: 'Stream quality' });
  els.fxBtn = btn('wand', 'Slowed / reverb / sped up (V)', () => openFxFor(store.state?.track));
  els.eqBtn = btn('sliders', 'Equalizer (E)', () => import('./fxpanel.js').then((m) => m.openEq()));
  els.bgBtn = btn('cloudRain', 'Background sounds (B)', () => import('./fxpanel.js').then((m) => m.openBg()));
  els.lyricsBtn = btn('lyrics', 'Lyrics (Y)', () => togglePanel('lyrics'));
  els.queueBtn = btn('queue', 'Queue (Q)', () => togglePanel('queue'));
  els.sleepBtn = btn('moon', 'Sleep timer', (e) => sleepMenu(e));
  els.volBtn = btn('vol', 'Mute (M)', () => cmd('mute', !store.state?.muted));
  els.volFill = h('div', { class: 'prog-fill' });
  els.volThumb = h('div', { class: 'prog-thumb' });
  els.vol = h('div', { class: 'prog vol' }, h('div', { class: 'prog-track' }, els.volFill), els.volThumb);
  els.expand = btn('expand', 'Now playing (F)', () => toggleNowPlaying());
  const right = h('div', { class: 'bar-right' }, els.quality, els.fxBtn, els.eqBtn, els.bgBtn, els.lyricsBtn, els.queueBtn, els.sleepBtn, h('div', { class: 'volume' }, els.volBtn, els.vol), els.expand, miniBtn());
  bar.append(left, center, right);

  slider(els.prog, (frac, done) => {
    const d = store.state?.dur || 0;
    if (!d) return;
    if (done) { cmd('seek', frac * d); store.state.pos = frac * d; store.stateAt = performance.now(); dragging = null; }
    else { dragging = { kind: 'seek', frac }; wakeClock(); }
    paintProgress(true);
  }, (frac) => { const d = store.state?.dur || 0; els.tip.textContent = fmtTime(frac * d); els.tip.style.left = frac * 100 + '%'; });
  slider(els.vol, (frac, done) => {
    const v = Math.round(frac * 100);
    if (done) { cmd('volume', v); dragging = null; } else { dragging = { kind: 'vol', v }; cmdThrottled(v); }
    paintVolume(v);
  });
  els.vol.addEventListener('wheel', (e) => { e.preventDefault(); const v = Math.max(0, Math.min(100, (store.state?.volume || 0) + (e.deltaY < 0 ? 5 : -5))); cmd('volume', v); }, { passive: false });
  els.prog.addEventListener('pointerenter', () => paintProgress(true));
}

let volT = 0;
function cmdThrottled(v) { const now = performance.now(); if (now - volT > 60) { volT = now; cmd('volume', v); } }

function slider(el, onChange, onHover) {
  const frac = (e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    onChange(frac(e), false);
    const move = (ev) => onChange(frac(ev), false);
    const up = (ev) => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onChange(frac(ev), true); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  if (onHover) el.addEventListener('pointermove', (e) => onHover(frac(e)));
}

// only touch the DOM when something visible changed (the idle UI used to re-layout 60x a second)
const painted = { frac: -1, cur: '', dur: '', thumb: -1, np: '' };
function setText(el, key, text) { if (painted[key] !== text) { painted[key] = text; el.textContent = text; } }

function paintProgress(force = false) {
  const s = store.state;
  const d = s?.dur || 0;
  const p = dragging?.kind === 'seek' ? dragging.frac * d : livePos();
  const frac = d ? Math.min(1, p / d) : 0;
  if (force || Math.abs(frac - painted.frac) > 0.0005) {
    painted.frac = frac;
    els.fill.style.transform = `scaleX(${frac.toFixed(4)})`;
  }
  // the thumb moves via `left` (a layout), so only while it's visible
  if (force || dragging || els.prog.matches(':hover')) {
    if (Math.abs(frac - painted.thumb) > 0.0005) { painted.thumb = frac; els.thumb.style.left = frac * 100 + '%'; }
  }
  setText(els.cur, 'cur', fmtTime(p));
  setText(els.dur, 'dur', fmtTime(d));
  const np = document.body.classList.contains('np-open') ? $('#nowplaying') : null;
  if (np) {
    const f = np.querySelector('.np-fill');
    if (f) {
      f.style.transform = `scaleX(${frac.toFixed(4)})`;
      const c = np.querySelector('.np-cur'), du = np.querySelector('.np-dur');
      if (c.textContent !== fmtTime(p)) c.textContent = fmtTime(p);
      if (du.textContent !== fmtTime(d)) du.textContent = fmtTime(d);
    }
  }
}

function paintVolume(v) {
  els.volFill.style.transform = `scaleX(${v / 100})`;
  els.volThumb.style.left = v + '%';
  const muted = store.state?.muted;
  els.volBtn.innerHTML = '';
  els.volBtn.append(icon(muted || v === 0 ? 'volX' : v < 50 ? 'vol1' : 'vol'));
}

// A light clock: runs only while music is actually playing (or a slider is being dragged),
// at ~10 fps. Paused or stopped = zero work.
let ticking = false;
let lastTick = 0;
function tick(now) {
  const s = store.state;
  const active = !!(s && s.track && !s.paused && !s.loading) || !!dragging;
  if (!active) { ticking = false; paintProgress(true); return; }
  if (now - lastTick >= 100) {
    lastTick = now;
    paintProgress();
    syncLyrics();
  }
  requestAnimationFrame(tick);
}
export function wakeClock() {
  if (!ticking) { ticking = true; requestAnimationFrame(tick); }
}

// ------------------------------------------------------------------ state -> bar
let lastTrackKey = null;
export function renderState() {
  const s = store.state;
  if (!s) return;
  const t = s.track;
  document.body.classList.toggle('has-track', !!t);
  wakeClock();
  els.play.innerHTML = '';
  els.play.append(icon(s.paused ? 'play' : 'pause'));
  els.play.classList.toggle('loading', !!s.loading);
  els.play.title = s.paused ? 'Play (Space)' : 'Pause (Space)';
  els.shuffle.classList.toggle('on', !!s.shuffle);
  els.repeat.classList.toggle('on', s.repeat !== 'off');
  els.repeat.innerHTML = '';
  els.repeat.append(icon(s.repeat === 'one' ? 'repeat1' : 'repeat'));
  els.repeat.title = `Repeat: ${s.repeat} (R)`;
  if (dragging?.kind !== 'vol') paintVolume(s.volume);
  const sl = s.sleep;
  els.sleepBtn.classList.toggle('on', !!sl);
  els.sleepBtn.title = sl ? (sl.end_of_track ? 'Sleep: after this song' : `Sleep in ${Math.ceil(sl.left / 60)} min`) : 'Sleep timer';
  const st = s.stream;
  els.quality.textContent = st ? (st.offline ? 'Offline' : st.abr ? `${st.abr >= 250 ? '256' : st.abr} kbps` : '') : '';
  els.quality.classList.toggle('hi', !!(st && st.abr >= 250));
  els.quality.title = st ? `${(st.codec || '').toUpperCase()} ${st.abr ? st.abr + ' kbps' : ''}${st.offline ? ' • played from your downloads' : ''}` : '';
  const key = t ? t.qid || t.id : null;
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    els.art.innerHTML = '';
    if (t) els.art.append(img(t.thumb, 'bar'));
    els.title.innerHTML = '';
    els.artist.innerHTML = '';
    if (t) {
      els.title.append(h('span', { class: 'link', onclick: () => (t.album?.id ? go(`#/album/${t.album.id}`) : toggleNowPlaying()) }, t.title));
      if (t.explicit) els.title.append(h('span', { class: 'explicit' }, 'E'));
      els.artist.append(artistLinks(t.artists));
      document.title = `${t.title} • ${t.artist}`;
      setAccent(t.thumb);
      onTrackChanged(t);
    } else document.title = 'Nocturne';
  }
  // the song's own version, else "effects on every song"
  const gfx = s.global_fx?.on ? s.global_fx.fx : null;
  const fxText = t ? (t.fx ? describeFx(t.fx) : gfx ? describeFx(gfx) : '') : '';
  els.fxChip.textContent = fxText;
  els.fxChip.classList.toggle('global', !!(t && !t.fx && gfx));
  els.fxChip.title = t && !t.fx && gfx ? 'Effects on every song: click to change' : 'Edit this version';
  els.bgBtn.classList.toggle('on', !!s.bg?.on);
  els.fxChip.style.display = fxText ? '' : 'none';
  els.fxBtn.classList.toggle('on', !!fxText);
  els.eqBtn.classList.toggle('on', !!s.eq?.on);
  const liked = t && isLiked(t);
  els.like.classList.toggle('on', !!liked);
  els.like.innerHTML = '';
  els.like.append(icon(liked ? 'heartFill' : 'heart'));
  refreshPlaying();
  renderNowPlayingState();
}

async function setAccent(thumb) {
  const rgb = await artColor(thumb);
  onArt(thumb, rgb);   // the theme decides: album-art accent / background, or the user's own colours
}

function sleepMenu(e) {
  const s = store.state?.sleep;
  const opt = (label, v) => ({ label, icon: 'moon', onClick: () => cmd('sleep', v) });
  menu(e.clientX - 160, e.clientY - 300, [
    s ? { label: 'Turn off sleep timer', icon: 'x', onClick: () => cmd('sleep', null) } : null,
    s ? '-' : null,
    opt('15 minutes', 15), opt('30 minutes', 30), opt('45 minutes', 45), opt('1 hour', 60), opt('2 hours', 120),
    opt('End of this song', 'track'),
  ]);
}

// ------------------------------------------------------------------ side panel: queue + lyrics
let panelTab = null;
export function togglePanel(tab) {
  const p = $('#panel');
  if (panelTab === tab && p.classList.contains('open')) { p.classList.remove('open'); panelTab = null; }
  else { panelTab = tab; p.classList.add('open'); renderPanel(); }
  els.queueBtn.classList.toggle('on', panelTab === 'queue');
  els.lyricsBtn.classList.toggle('on', panelTab === 'lyrics');
  try { localStorage.setItem('tempo.panel', panelTab || ''); } catch {}
}
export function restorePanel() {
  let t = null;
  try { t = localStorage.getItem('tempo.panel'); } catch {}
  if (t) togglePanel(t);
}

function renderPanel() {
  const p = $('#panel');
  [...p.children].forEach((c) => { if (!c.classList.contains('edge-grip')) c.remove(); });   // keep the resize edge
  const tabs = h('div', { class: 'panel-tabs' },
    h('button', { class: `ptab ${panelTab === 'queue' ? 'on' : ''}`, onclick: () => { panelTab = 'queue'; renderPanel(); togglePanelBtns(); } }, 'Up next'),
    h('button', { class: `ptab ${panelTab === 'lyrics' ? 'on' : ''}`, onclick: () => { panelTab = 'lyrics'; renderPanel(); togglePanelBtns(); } }, 'Lyrics'),
    panelWideBtn(), btn('x', 'Close', () => togglePanel(panelTab)));
  const body = h('div', { class: 'panel-body' });
  p.append(tabs, body);
  if (panelTab === 'queue') renderQueue(body);
  else renderLyrics(body);
}
function togglePanelBtns() {
  els.queueBtn.classList.toggle('on', panelTab === 'queue');
  els.lyricsBtn.classList.toggle('on', panelTab === 'lyrics');
}

export async function loadQueue() {
  store.queue = await get('/api/queue');
  emit('queue', store.queue);
  return store.queue;
}

on('queue-changed', async () => {
  const needed = (panelTab === 'queue' && $('#panel').classList.contains('open')) || $('#nowplaying')?.classList.contains('open');
  if (!needed) { store.queue = null; return; }
  await loadQueue();
  if (panelTab === 'queue' && $('#panel').classList.contains('open')) renderQueue($('#panel .panel-body'));
  const npq = $('#nowplaying .np-queue');
  if (npq) renderQueue(npq, true);
});

async function renderQueue(body, compact = false) {
  if (!body) return;
  const q = store.queue || (await loadQueue());
  const keepScroll = body.scrollTop;
  body.innerHTML = '';
  const idx = q.index;
  const items = q.items || [];
  if (!items.length) { body.append(h('div', { class: 'panel-empty' }, icon('queue'), h('div', null, 'Your queue is empty'), h('div', { class: 'muted' }, 'Play something, or right-click a song → Add to queue.'))); return; }
  const cur = items[idx];
  if (cur) {
    body.append(h('div', { class: 'qlabel' }, 'Now playing'));
    body.append(qrow(cur, idx, true));
  }
  const up = items.slice(idx + 1).map((t, k) => ({ t, i: idx + 1 + k }));
  const added = up.filter(({ t }) => t.added && !t.auto);
  const ctx = up.filter(({ t }) => !t.added && !t.auto);
  const auto = up.filter(({ t }) => t.auto);
  const group = (label, list, extra) => {
    if (!list.length) return;
    body.append(h('div', { class: 'qlabel' }, h('span', null, label), extra || null));
    list.forEach(({ t, i }) => body.append(qrow(t, i)));
  };
  const clear = h('button', { class: 'linkbtn', onclick: () => run(() => post('/api/queue/clear')) }, 'Clear');
  group('Next in queue', added, clear);
  group(q.context?.title ? `Next from: ${q.context.title}` : 'Next up', ctx, added.length ? null : clear);
  const ap = h('label', { class: 'mini-switch', title: 'Autoplay similar songs' }, h('input', { type: 'checkbox', checked: store.state?.autoplay, onchange: (e) => cmd('autoplay', e.target.checked) }), h('span'));
  ap.querySelector('input').checked = !!store.state?.autoplay;
  body.append(h('div', { class: 'qlabel auto' }, h('span', null, icon('sparkles'), ' Autoplay'), ap));
  if (store.state?.autoplay) auto.forEach(({ t, i }) => body.append(qrow(t, i)));
  else body.append(h('div', { class: 'muted small pad' }, 'Turn on to keep playing similar songs when your queue ends.'));
  body.scrollTop = keepScroll;
}

let dragQid = null;
function qrow(t, i, isCur = false) {
  const r = h('div', { class: `qrow ${isCur ? 'cur' : ''} ${t.unavailable ? 'dim' : ''} ${t.auto ? 'auto' : ''}`, draggable: isCur ? 'false' : 'true', dataset: { qid: t.qid, i: String(i) } },
    img(t.thumb, 'xs'),
    h('div', { class: 'tt' }, h('div', { class: 'tname' }, t.title), h('div', { class: 'tsub' }, t.artist)),
    h('div', { class: 'qdur' }, fmtTime(t.dur)),
    isCur ? null : btn('x', 'Remove', () => run(() => post('/api/queue/remove', { qid: t.qid })), 'qx'));
  if (!isCur) r.addEventListener('click', () => post('/api/queue/jump', { qid: t.qid }));
  r.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, e.clientX, e.clientY, { extra: isCur ? [] : ['-', { label: 'Remove from queue', icon: 'trash', danger: true, onClick: () => post('/api/queue/remove', { qid: t.qid }) }] }); });
  r.addEventListener('dragstart', (e) => { dragQid = t.qid; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  r.addEventListener('dragend', () => { dragQid = null; r.classList.remove('dragging'); document.querySelectorAll('.qrow.over').forEach((x) => x.classList.remove('over', 'below')); });
  r.addEventListener('dragover', (e) => {
    if (!dragQid || isCur) return;
    e.preventDefault();
    const rect = r.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    document.querySelectorAll('.qrow.over').forEach((x) => x !== r && x.classList.remove('over', 'below'));
    r.classList.add('over');
    r.classList.toggle('below', below);
  });
  r.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragQid || dragQid === t.qid) return;
    const rect = r.getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    const items = store.queue.items;
    const from = items.findIndex((x) => x.qid === dragQid);
    let to = i + (below ? 1 : 0);
    if (from < to) to -= 1;
    run(() => post('/api/queue/move', { qid: dragQid, to }));
  });
  return r;
}

// ------------------------------------------------------------------ lyrics
let lyr = { id: null, data: null, loading: false, userScrollAt: 0 };
async function fetchLyrics(id) {
  if (lyr.id === id && (lyr.data || lyr.loading)) return lyr.data;
  lyr = { id, data: null, loading: true, userScrollAt: 0 };
  try {
    const r = await get('/api/lyrics/' + id);
    if (lyr.id !== id) return null;
    lyr.data = r.lyrics || { none: true };
  } catch { lyr.data = { none: true }; }
  lyr.loading = false;
  return lyr.data;
}

async function renderLyrics(body, big = false) {
  if (!body) return;
  const t = store.state?.track;
  body.innerHTML = '';
  body.classList.add('lyrics');
  if (!t) { body.append(h('div', { class: 'panel-empty' }, icon('lyrics'), h('div', null, 'Play a song to see its lyrics'))); return; }
  body.append(h('div', { class: 'panel-empty' }, h('div', { class: 'spinner' })));
  const data = await fetchLyrics(t.id);
  if (store.state?.track?.id !== t.id) return;
  body.innerHTML = '';
  if (!data || data.none) { body.append(h('div', { class: 'panel-empty' }, icon('lyrics'), h('div', null, 'No lyrics for this one'))); return; }
  const wrap = h('div', { class: `lyr ${data.timed ? 'timed' : ''} ${big ? 'big' : ''}` });
  data.lines.forEach((l) => {
    const line = h('div', { class: `lline ${l.text.trim() ? '' : 'gap'}`, dataset: l.t !== null ? { t: String(l.t) } : {} }, l.text || '♪');
    if (data.timed) line.addEventListener('click', () => cmd('seek', l.t));
    wrap.append(line);
  });
  if (data.source) wrap.append(h('div', { class: 'lyr-src' }, data.source));
  body.append(wrap);
  body.addEventListener('wheel', () => { lyr.userScrollAt = performance.now(); }, { passive: true });
}

let lastLine = null;
function syncLyrics() {
  const wraps = document.querySelectorAll('.lyr.timed');
  if (!wraps.length) return;
  const pos = livePos() + 0.25;
  wraps.forEach((w) => {
    const lines = w.querySelectorAll('.lline[data-t]');
    let cur = null;
    for (const l of lines) { if (parseFloat(l.dataset.t) <= pos) cur = l; else break; }
    if (cur && !cur.classList.contains('on')) {
      w.querySelectorAll('.lline.on').forEach((x) => x.classList.remove('on'));
      cur.classList.add('on');
      const scroller = w.parentElement;
      if (performance.now() - lyr.userScrollAt > 2500 && scroller) {
        const top = cur.offsetTop - scroller.clientHeight * 0.38;
        scroller.scrollTo({ top, behavior: lastLine ? 'smooth' : 'auto' });
      }
      lastLine = cur;
    }
  });
}

function onTrackChanged(t) {
  if (panelTab === 'lyrics' && $('#panel').classList.contains('open')) renderLyrics($('#panel .panel-body'));
  if ($('#nowplaying')?.classList.contains('open')) renderNowPlaying();
}

// ------------------------------------------------------------------ Now Playing
let npTab = 'lyrics';
export function toggleNowPlaying(force) {
  const np = $('#nowplaying');
  const open = force !== undefined ? force : !np.classList.contains('open');
  np.classList.toggle('open', open);
  document.body.classList.toggle('np-open', open);
  els.expand.classList.toggle('on', open);
  if (open) renderNowPlaying();
}

// the Now Playing backdrop controls (Grant: "too transparent"), in a small popover; same settings as Appearance
async function toggleNpPop(np) {
  const old = np.querySelector('.np-pop');
  if (old) { old.remove(); return; }
  const { npControls } = await import('./appearance.js');
  const pop = h('div', { class: 'np-pop' }, h('div', { class: 'np-pop-h' }, 'Now Playing background'), npControls(true));
  np.append(pop);
  const close = (e) => { if (!pop.contains(e.target) && !e.target.closest('.np-bgbtn')) { pop.remove(); removeEventListener('pointerdown', close, true); } };
  addEventListener('pointerdown', close, true);
}

function renderNowPlaying() {
  const np = $('#nowplaying');
  const t = store.state?.track;
  np.innerHTML = '';
  if (!t) { np.append(h('div', { class: 'panel-empty' }, 'Nothing playing')); return; }
  const big = t.thumb ? t.thumb.replace(/=w\d+-h\d+[^&]*/, '=w1080-h1080-l90-rj').replace('hqdefault', 'maxresdefault') : null;
  np.append(h('div', { class: 'np-bg', style: { backgroundImage: big ? `url("${big}")` : 'none' } }), h('div', { class: 'np-shade' }));
  const left = h('div', { class: 'np-left' },
    h('div', { class: `np-art ${/ytimg\.com/.test(t.thumb || '') ? 'wide' : ''}` }, img(big || t.thumb, 'np')),
    h('div', { class: 'np-title' }, t.title),
    h('div', { class: 'np-artist' }, artistLinks(t.artists), t.album?.name ? h('span', { class: 'muted' }, ' • ', h('a', { href: `#/album/${t.album.id}`, onclick: () => toggleNowPlaying(false) }, t.album.name)) : null),
    h('div', { class: 'np-prog' }, h('span', { class: 'np-cur' }, '0:00'), h('div', { class: 'np-track' }, h('div', { class: 'np-fill' })), h('span', { class: 'np-dur' }, '0:00')),
    h('div', { class: 'np-actions' },
      btn(isLiked(t) ? 'heartFill' : 'heart', 'Like', () => toggleLike(t), `like ${isLiked(t) ? 'on' : ''}`),
      btn('radio', 'Start radio', () => run(() => post('/api/play', { kind: 'radio', videoId: t.id, title: `${t.title} radio` }))),
      btn('more', 'More', (e) => trackMenu(t, e.clientX, e.clientY))));
  const npTrack = left.querySelector('.np-track');
  npTrack.addEventListener('click', (e) => { const r = npTrack.getBoundingClientRect(); cmd('seek', ((e.clientX - r.left) / r.width) * (store.state?.dur || 0)); });
  const tabs = h('div', { class: 'np-tabs' },
    h('button', { class: `ptab ${npTab === 'lyrics' ? 'on' : ''}`, onclick: () => { npTab = 'lyrics'; renderNowPlaying(); } }, 'Lyrics'),
    h('button', { class: `ptab ${npTab === 'queue' ? 'on' : ''}`, onclick: () => { npTab = 'queue'; renderNowPlaying(); } }, 'Up next'));
  const body = h('div', { class: `np-body ${npTab === 'queue' ? 'np-queue' : ''}` });
  const right = h('div', { class: 'np-right' }, tabs, body);
  np.append(h('div', { class: 'np-wrap' }, left, right), btn('down', 'Close (Esc)', () => toggleNowPlaying(false), 'np-close'),
    btn('sliders', 'Background: album art, blur, darken, see-through', () => toggleNpPop(np), 'np-bgbtn'));
  if (npTab === 'lyrics') renderLyrics(body, true);
  else renderQueue(body, true);
}

function renderNowPlayingState() {
  const np = $('#nowplaying');
  if (!np?.classList.contains('open')) return;
  const like = np.querySelector('.np-actions .like');
  const t = store.state?.track;
  if (like && t) { like.innerHTML = ''; like.append(icon(isLiked(t) ? 'heartFill' : 'heart')); like.classList.toggle('on', isLiked(t)); }
}
on('like', () => store.state && renderState());
