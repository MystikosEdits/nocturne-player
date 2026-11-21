// Layout controls (Grant, Nov 20: "add more buttons for like extending tabs and minimizing shit"):
//   sidebar   collapse to icons ([), drag its edge to resize, double-click the edge to reset
//   playlists the sidebar's list folds away
//   panel     queue / lyrics: drag its edge, or the wide button (])
//   mini      a small always-on-top player window (P); the restore button / P puts the window back where it was
// Remembered per computer in localStorage.
import { h, icon, pageZoom } from './ui.js';

const KEY = 'tempo.layout';
const D = { sideW: 236, sideMini: false, plsHidden: false, panelW: 344, panelWide: false };
let L = { ...D };
try { L = { ...D, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch {} };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Narrow windows (or a big Size on a small window): the sidebar goes to icons by itself. The width that counts is the
// app's own CSS width (documentElement.clientWidth already divides by Settings -> Size), not the window's.
const NARROW = 1000;
let narrow = false, narrowOpen = false;        // narrowOpen: expanded by hand ([) while narrow, until it widens again
const appWidth = () => document.documentElement.clientWidth || innerWidth;
const sideMini = () => (narrow ? !narrowOpen : L.sideMini);

export function applyLayout() {
  const root = document.documentElement.style;
  const mini = sideMini();
  // the side panel never takes more than ~45% of the app (cqw = the app's width, correct under the page zoom)
  root.setProperty('--side-w', `${mini ? 72 : L.sideW}px`);
  // ...and always leaves the middle column ~400 px (a wide queue at 130% on a small window left it 380 px)
  const sw = mini ? 72 : L.sideW;
  root.setProperty('--panel-w', `max(260px, min(${L.panelWide ? '54cqw, 780px' : `${L.panelW}px, 46cqw`}, calc(100cqw - ${sw}px - 400px)))`);
  document.body.classList.toggle('side-mini', mini);
  document.body.classList.toggle('side-auto', narrow && mini);
  document.body.classList.toggle('pls-hidden', L.plsHidden);
  document.body.classList.toggle('panel-wide', L.panelWide);
  document.querySelectorAll('.side-toggle').forEach((b) => { b.title = mini ? 'Expand the sidebar ([)' : 'Collapse the sidebar ([)'; });
  document.querySelectorAll('.panel-wide-btn').forEach((b) => { b.title = L.panelWide ? 'Narrower (])' : 'Wider (])'; b.classList.toggle('on', L.panelWide); });
}

export const toggleSidebar = () => { if (narrow) narrowOpen = !narrowOpen; else { L.sideMini = !L.sideMini; save(); } applyLayout(); };
function checkNarrow() {
  const n = appWidth() < NARROW;
  if (n === narrow) return;
  narrow = n;
  narrowOpen = false;
  applyLayout();
}
export const togglePlaylists = () => { L.plsHidden = !L.plsHidden; save(); applyLayout(); };
export const toggleWidePanel = () => { L.panelWide = !L.panelWide; save(); applyLayout(); };

export const sideToggleBtn = () => h('button', { class: 'ibtn side-toggle', title: sideMini() ? 'Expand the sidebar ([)' : 'Collapse the sidebar ([)', onclick: toggleSidebar }, icon('panelLeft'));
export const panelWideBtn = () => h('button', { class: `ibtn panel-wide-btn ${L.panelWide ? 'on' : ''}`, title: L.panelWide ? 'Narrower (])' : 'Wider (])', onclick: toggleWidePanel }, icon('panelWide'));

// drag an edge: `measure` gives the element's on-screen box, `toWidth` turns the pointer into a CSS width
function edge(host, cls, onDrag, onReset) {
  const grip = h('div', { class: `edge-grip ${cls}`, title: 'Drag to resize · double-click to reset' });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => onDrag(ev);
    const up = () => {
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('lostpointercapture', up);
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('lostpointercapture', up);
  });
  grip.addEventListener('dblclick', () => { onReset(); save(); applyLayout(); });
  host.append(grip);
}

export function initLayout() {
  narrow = appWidth() < NARROW;
  applyLayout();
  // window resized, moved to another monitor, or Settings -> Size changed: all change the app's CSS width
  new ResizeObserver(checkNarrow).observe(document.body);
  const side = document.getElementById('side');
  const panel = document.getElementById('panel');
  // the page may be zoomed (Settings -> Size): convert screen pixels to CSS pixels through the element's own box
  edge(side, 'side-grip', (e) => {
    const r = side.getBoundingClientRect();
    const f = r.width / (side.offsetWidth || 1) || 1;
    const w = (e.clientX - r.left) / f;
    if (w < 120) { if (narrow) { narrowOpen = false; applyLayout(); } else if (!L.sideMini) { L.sideMini = true; applyLayout(); } return; }
    if (narrow) narrowOpen = true; else L.sideMini = false;
    L.sideW = Math.round(clamp(w, 180, 420));
    applyLayout();
  }, () => { L.sideW = D.sideW; L.sideMini = false; });
  edge(panel, 'panel-grip', (e) => {
    const r = panel.getBoundingClientRect();
    const f = r.width / (panel.offsetWidth || 1) || 1;
    L.panelWide = false;
    L.panelW = Math.round(clamp((r.right - e.clientX) / f, 280, Math.min(780, appWidth() * 0.46)));
    applyLayout();
  }, () => { L.panelW = D.panelW; L.panelWide = false; });
}

// ------------------------------------------------------------------ mini player
let mini = false;
export async function toggleMini(force) {
  const on = force !== undefined ? force : !mini;
  if (on === mini) return;
  mini = on;
  document.body.classList.toggle('mini', on);
  dispatchEvent(new Event('tempo-mini'));     // effects.js: canvases are hidden in the mini player, so stop their loops
  if (on) document.body.classList.remove('np-open');
  const api = window.pywebview?.api;
  if (api?.mini) {
    const zoom = pageZoom();
    try { await api.mini(on, Math.round(440 * zoom), Math.round(136 * zoom), window.devicePixelRatio || 1); } catch {}
  }
  document.querySelectorAll('.mini-btn').forEach((b) => { b.title = on ? 'Back to the full window (P)' : 'Mini player (P)'; b.replaceChildren(icon(on ? 'maximize' : 'miniPlayer')); });
}
export const miniBtn = () => h('button', { class: 'ibtn mini-btn', title: 'Mini player (P)', onclick: () => toggleMini() }, icon('miniPlayer'));
