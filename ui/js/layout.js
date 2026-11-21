// Layout controls (Grant, Nov 20: "add more buttons for like extending tabs and minimizing shit"):
//   sidebar   collapse to icons ([), drag its edge to resize, double-click the edge to reset
//   playlists the sidebar's list folds away
//   panel     queue / lyrics: drag its edge, or the wide button (])
//   mini      a small always-on-top player window (P); the restore button / P puts the window back where it was
// Remembered per computer in localStorage.
import { h, icon } from './ui.js';

const KEY = 'tempo.layout';
const D = { sideW: 236, sideMini: false, plsHidden: false, panelW: 344, panelWide: false };
let L = { ...D };
try { L = { ...D, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch {} };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--side-w', `${L.sideMini ? 72 : L.sideW}px`);
  root.setProperty('--panel-w', L.panelWide ? 'min(54vw, 780px)' : `${L.panelW}px`);
  document.body.classList.toggle('side-mini', L.sideMini);
  document.body.classList.toggle('pls-hidden', L.plsHidden);
  document.body.classList.toggle('panel-wide', L.panelWide);
  document.querySelectorAll('.side-toggle').forEach((b) => { b.title = L.sideMini ? 'Expand the sidebar ([)' : 'Collapse the sidebar ([)'; });
  document.querySelectorAll('.panel-wide-btn').forEach((b) => { b.title = L.panelWide ? 'Narrower (])' : 'Wider (])'; b.classList.toggle('on', L.panelWide); });
}

export const toggleSidebar = () => { L.sideMini = !L.sideMini; save(); applyLayout(); };
export const togglePlaylists = () => { L.plsHidden = !L.plsHidden; save(); applyLayout(); };
export const toggleWidePanel = () => { L.panelWide = !L.panelWide; save(); applyLayout(); };

export const sideToggleBtn = () => h('button', { class: 'ibtn side-toggle', title: L.sideMini ? 'Expand the sidebar ([)' : 'Collapse the sidebar ([)', onclick: toggleSidebar }, icon('panelLeft'));
export const panelWideBtn = () => h('button', { class: `ibtn panel-wide-btn ${L.panelWide ? 'on' : ''}`, title: L.panelWide ? 'Narrower (])' : 'Wider (])', onclick: toggleWidePanel }, icon('panelWide'));

// drag an edge: `measure` gives the element's on-screen box, `toWidth` turns the pointer into a CSS width
function edge(host, cls, onDrag, onReset) {
  const grip = h('div', { class: `edge-grip ${cls}`, title: 'Drag to resize · double-click to reset' });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => onDrag(ev);
    const up = () => { document.body.classList.remove('resizing'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); save(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { onReset(); save(); applyLayout(); });
  host.append(grip);
}

export function initLayout() {
  applyLayout();
  const side = document.getElementById('side');
  const panel = document.getElementById('panel');
  // the page may be zoomed (Settings -> Size): convert screen pixels to CSS pixels through the element's own box
  edge(side, 'side-grip', (e) => {
    const r = side.getBoundingClientRect();
    const f = r.width / (L.sideMini ? 72 : L.sideW) || 1;
    const w = (e.clientX - r.left) / f;
    if (w < 120) { if (!L.sideMini) { L.sideMini = true; applyLayout(); } return; }
    L.sideMini = false;
    L.sideW = Math.round(clamp(w, 180, 420));
    applyLayout();
  }, () => { L.sideW = D.sideW; L.sideMini = false; });
  edge(panel, 'panel-grip', (e) => {
    const r = panel.getBoundingClientRect();
    const f = r.width / (panel.offsetWidth || 1) || 1;
    L.panelWide = false;
    L.panelW = Math.round(clamp((r.right - e.clientX) / f, 280, 780));
    applyLayout();
  }, () => { L.panelW = D.panelW; L.panelWide = false; });
}

// ------------------------------------------------------------------ mini player
let mini = false;
export const isMini = () => mini;
export async function toggleMini(force) {
  const on = force !== undefined ? force : !mini;
  if (on === mini) return;
  mini = on;
  document.body.classList.toggle('mini', on);
  if (on) document.body.classList.remove('np-open');
  const api = window.pywebview?.api;
  if (api?.mini) {
    const zoom = parseFloat(document.documentElement.style.zoom || '1') || 1;
    try { await api.mini(on, Math.round(440 * zoom), Math.round(136 * zoom), window.devicePixelRatio || 1); } catch {}
  }
  document.querySelectorAll('.mini-btn').forEach((b) => { b.title = on ? 'Back to the full window (P)' : 'Mini player (P)'; b.replaceChildren(icon(on ? 'maximize' : 'miniPlayer')); });
}
export const miniBtn = () => h('button', { class: 'ibtn mini-btn', title: 'Mini player (P)', onclick: () => toggleMini() }, icon('miniPlayer'));
