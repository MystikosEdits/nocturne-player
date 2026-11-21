// Appearance: palettes (Nocturne's own + every Reaction Desk look), accent (album art / any colour / rainbow),
// backgrounds (album art, colour, gradient, image, rainbow), tint, glass, effects (snow / starfield / embers), size,
// corners, density, font. Applied instantly from localStorage at boot, saved to the engine (settings.theme) on change.
import { post, get } from './api.js';
import { applyEffects, clearSnow, FX_DEF, rbRGB } from './effects.js';

export const PALETTES = {
  midnight: { name: 'Midnight', bg: '#0b0b0e', bg2: '#101014', raise: '#1a1a20', raise2: '#222229', text: '#f1f1f4', text2: '#a1a1ab', text3: '#6b6b76' },
  oled:     { name: 'OLED black', bg: '#000000', bg2: '#050506', raise: '#121214', raise2: '#1b1b1e', text: '#f4f4f6', text2: '#9d9da6', text3: '#64646d' },
  graphite: { name: 'Graphite', bg: '#18181b', bg2: '#1e1e22', raise: '#28282d', raise2: '#313137', text: '#f2f2f4', text2: '#a8a8b2', text3: '#73737d' },
  ocean:    { name: 'Deep ocean', bg: '#06101b', bg2: '#0a1623', raise: '#11233a', raise2: '#172d47', text: '#e9f2fc', text2: '#96aac0', text3: '#5f748c' },
  forest:   { name: 'Forest', bg: '#07110b', bg2: '#0b1711', raise: '#13261b', raise2: '#193022', text: '#ebf5ee', text2: '#9bb3a3', text3: '#647a6b' },
  wine:     { name: 'Wine', bg: '#12090d', bg2: '#180c12', raise: '#26131c', raise2: '#301824', text: '#f8ecf1', text2: '#b89aa7', text3: '#7d6270' },
  mocha:    { name: 'Mocha', bg: '#14100d', bg2: '#1a1511', raise: '#272019', raise2: '#30281f', text: '#f6efe8', text2: '#b4a596', text3: '#7c6e61' },
  sakura:   { name: 'Sakura', bg: '#170f14', bg2: '#1d1219', raise: '#2b1a25', raise2: '#36202e', text: '#fdf0f6', text2: '#c7a5b6', text3: '#8a6a7a' },
  light:    { name: 'Light', bg: '#f5f5f7', bg2: '#ececf0', raise: '#ffffff', raise2: '#f1f1f4', text: '#141418', text2: '#55555f', text3: '#8b8b95', light: true },
};

/* THE REACTION DESK'S LOOKS (rig index.html LOOKS + BASE, Sep 23-25 2026), same colours and the same maths:
   a colour look is the desk's dark slate washed 4-5% toward its accent; a seasonal look is washed 7-10% toward a
   second colour and brings the effect it goes with (picking it turns that effect on, once). */
const DESK_BASE = {
  dark:  { bg: '#0F1215', panel: '#171B21', raised: '#1E242B', raised2: '#232B33', text: '#E4E9EE', muted: '#8A96A3', dim: '#5F6B78' },
  ultra: { bg: '#000000', panel: '#07080A', raised: '#0D0F12', raised2: '#121519', text: '#E4E9EE', muted: '#7F8A96', dim: '#525C67' },
  light: { bg: '#E8ECF0', panel: '#F6F7F9', raised: '#FFFFFF', raised2: '#EDF0F3', text: '#161B21', muted: '#55606C', dim: '#848E99' },
};
export const DESK_LOOKS = [
  { id: 'd_default', n: 'Default', g: 'Base', acc: '#F2A03D' },
  { id: 'd_ultra', n: 'Ultra dark', g: 'Base', base: 'ultra', acc: '#F2A03D' },
  { id: 'd_light', n: 'Light', g: 'Base', base: 'light', acc: '#C8720F' },
  { id: 'd_blue', n: 'Blue', g: 'Colours', acc: '#4C9AFF', wash: 0.05 },
  { id: 'd_purple', n: 'Purple', g: 'Colours', acc: '#A67CFF', wash: 0.05 },
  { id: 'd_green', n: 'Green', g: 'Colours', acc: '#3DD68C', wash: 0.04 },
  { id: 'd_red', n: 'Red', g: 'Colours', acc: '#FF5A5F', wash: 0.04 },
  { id: 'd_pink', n: 'Pink', g: 'Colours', acc: '#FF6FB5', wash: 0.05 },
  { id: 'd_teal', n: 'Teal', g: 'Colours', acc: '#2CC9B5', wash: 0.05 },
  { id: 'd_gold', n: 'Gold', g: 'Colours', acc: '#F5C542', wash: 0.04 },
  { id: 'd_rainbow', n: 'Rainbow', g: 'Colours', acc: 'rainbow', wash: 0.05 },
  { id: 'd_halloween', n: 'Halloween', g: 'Seasonal', acc: '#FF7A1A', wash: 0.1, washc: '#7A2FB0', fx: 'embers' },
  { id: 'd_christmas', n: 'Christmas', g: 'Seasonal', acc: '#E8484B', wash: 0.09, washc: '#1F8A50', fx: 'snow' },
  { id: 'd_winter', n: 'Winter', g: 'Seasonal', acc: '#8FD3FF', wash: 0.09, washc: '#3C79B8', fx: 'snow' },
  { id: 'd_spring', n: 'Spring', g: 'Seasonal', acc: '#FF8CC6', wash: 0.07, washc: '#4FAF6A' },
  { id: 'd_summer', n: 'Summer', g: 'Seasonal', acc: '#FFC23D', wash: 0.08, washc: '#1FA7A0', fx: 'stars' },
];
const LOOK_BY_ID = Object.fromEntries(DESK_LOOKS.map((l) => [l.id, l]));
export const lookOf = (id) => LOOK_BY_ID[id] || null;

export const ACCENTS = ['auto', 'rainbow', '#a78bfa', '#7c5cff', '#ff5c8a', '#f43f5e', '#fb923c', '#F2A03D', '#facc15', '#4ade80', '#2dd4bf', '#38bdf8', '#60a5fa', '#e5e7eb'];

export const FONTS = {
  system: { name: 'System', css: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif' },
  rounded: { name: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", "Arial Rounded MT Bold", Nunito, system-ui, sans-serif' },
  serif: { name: 'Serif', css: 'ui-serif, "New York", Georgia, "Times New Roman", serif' },
  mono: { name: 'Mono', css: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace' },
};

export const DEFAULT_THEME = {
  palette: 'midnight', accent: 'auto',
  bg: { type: 'none', color: '#1b1430', c1: '#3b1d6e', c2: '#0b0b0e', angle: 160, image: null, fit: 'cover', blur: 40, dim: 55 },
  np: { art: 55, blur: 70, dim: 82, through: 0 },   // the Now Playing backdrop (Grant: "too transparent")
  wash: { color: '#5B8DEF', amount: 0 },        // "Tint the app": a colour mixed into every surface
  rainbowSpeed: 100,                             // one speed for every rainbow in the look (accent, background, tint)
  fx: { type: 'off', back: false, fps: 30, snow: { ...FX_DEF.snow }, stars: { ...FX_DEF.stars }, embers: { ...FX_DEF.embers } },
  glass: 0, scale: 100, radius: 8, density: 'comfortable', font: 'system', tint: true,
};

let theme = load();
let lastArt = null, lastArtRgb = null;
const listeners = new Set();
export const getTheme = () => theme;
export const onTheme = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function load() {
  try {
    const raw = localStorage.getItem('tempo.theme');
    if (raw) return merge(JSON.parse(raw));
  } catch {}
  return merge({});
}
function merge(t) {
  t = t || {};
  const D = DEFAULT_THEME, fx = t.fx || {};
  return {
    ...D, ...t,
    bg: { ...D.bg, ...(t.bg || {}) },
    wash: { ...D.wash, ...(t.wash || {}) },
    np: { ...D.np, ...(t.np || {}) },
    fx: { ...D.fx, ...fx, snow: { ...D.fx.snow, ...(fx.snow || {}) }, stars: { ...D.fx.stars, ...(fx.stars || {}) }, embers: { ...D.fx.embers, ...(fx.embers || {}) } },
  };
}

// ------------------------------------------------------------------ colour maths (the desk's)
const RB = 'rainbow';
const hex6 = (h) => (/^#[0-9a-f]{6}$/i.test(String(h || '')) ? h : '');
const hexRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return toHex(A.map((x, i) => x * t + B[i] * (1 - t))); };   // t of a
const trip = (hex) => hexRgb(hex).join(' ');
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rbPeriod = (t = theme) => 40 / Math.max(0.1, (+t.rainbowSpeed || 100) / 100);
const rbHue = (t = theme) => (STILL ? 200 : ((Date.now() / 1000 / rbPeriod(t)) * 360) % 360);
const rbHex = (h, s, l) => toHex(rbRGB(h, s, l));
const rbAcc = (h, light) => (light ? rbHex(h, 0.8, 0.42) : rbHex(h, 0.9, 0.63));

/** the palette a theme id resolves to right now (a desk look is computed; a rainbow wash moves with the hue) */
export function paletteOf(id, hue = rbHue()) {
  if (PALETTES[id]) return PALETTES[id];
  const L = LOOK_BY_ID[id];
  if (!L) return PALETTES.midnight;
  const B = DESK_BASE[L.base || 'dark'];
  let T = { ...B };
  if (L.wash) {
    const w = hex6(L.washc) || (L.acc === RB ? rbHex(hue, 0.8, 0.55) : L.acc);
    for (const k of ['bg', 'panel', 'raised', 'raised2']) T[k] = mix(w, T[k], L.wash);
  }
  return { name: L.n, bg: T.bg, bg2: T.panel, raise: T.raised, raise2: T.raised2, text: T.text, text2: T.muted, text3: T.dim, light: L.base === 'light', acc: L.acc, fx: L.fx };
}

function rbActive(t) {
  const L = LOOK_BY_ID[t.palette];
  return { acc: t.accent === RB, look: !!(L && L.acc === RB), tint: t.wash.color === RB && t.wash.amount > 0, wall: t.bg.type === 'rainbow' };
}

// ------------------------------------------------------------------ apply
function applyColours(t, hue = rbHue(t)) {
  const root = document.documentElement.style;
  const p0 = paletteOf(t.palette, hue);
  const p = { ...p0 };
  if (t.wash.amount > 0) {
    const tc = t.wash.color === RB ? rbHex(hue, 0.75, 0.55) : hex6(t.wash.color);
    if (tc) for (const k of ['bg', 'bg2', 'raise', 'raise2']) p[k] = mix(tc, p[k], t.wash.amount / 100);
  }
  root.setProperty('--bg', p.bg);
  root.setProperty('--bg2', p.bg2);
  root.setProperty('--raise', p.raise);
  root.setProperty('--raise2', p.raise2);
  root.setProperty('--text', p.text);
  root.setProperty('--text2', p.text2);
  root.setProperty('--text3', p.text3);
  root.setProperty('--bg-rgb', trip(p.bg));
  root.setProperty('--bg2-rgb', trip(p.bg2));
  root.setProperty('--ink', p.light ? '0 0 0' : '255 255 255');
  document.body.classList.toggle('theme-light', !!p.light);
  document.documentElement.style.colorScheme = p.light ? 'light' : 'dark';
  if (t.accent === RB) root.setProperty('--acc', trip(rbAcc(hue, p.light)));
  else if (t.accent && t.accent !== 'auto' && hex6(t.accent)) root.setProperty('--acc', trip(t.accent));
  else if (lastArtRgb) root.setProperty('--acc', lastArtRgb.join(' '));
  return p;
}

export function applyTheme(t = theme) {
  const root = document.documentElement.style;
  const p = applyColours(t);
  // background layer
  const hasBg = t.bg.type !== 'none';
  document.body.classList.toggle('has-bg', hasBg);
  const bd = document.getElementById('backdrop');
  if (bd) {
    const img = bd.querySelector('.bd-img');
    const dim = bd.querySelector('.bd-dim');
    let rbw = bd.querySelector('.bd-rb');
    if (!rbw) { rbw = document.createElement('div'); rbw.className = 'bd-rb'; bd.insertBefore(rbw, dim); }
    img.style.filter = `blur(${t.bg.blur}px) saturate(1.2)`;
    img.style.transform = t.bg.blur > 0 ? 'scale(1.12)' : 'none';
    img.style.backgroundColor = '';
    dim.style.background = `rgb(${trip(p.bg)} / ${t.bg.dim / 100})`;
    rbw.style.display = t.bg.type === 'rainbow' ? 'block' : 'none';
    if (t.bg.type === 'gradient') { img.style.backgroundImage = `linear-gradient(${t.bg.angle}deg, ${t.bg.c1}, ${t.bg.c2})`; img.style.filter = 'none'; img.style.transform = 'none'; }
    else if (t.bg.type === 'image' && t.bg.image) img.style.backgroundImage = `url("${t.bg.image}")`;
    else if (t.bg.type === 'art') img.style.backgroundImage = lastArt ? `url("${lastArt}")` : 'none';
    else if (t.bg.type === 'colour') { img.style.backgroundImage = 'none'; img.style.backgroundColor = t.bg.color; img.style.filter = 'none'; img.style.transform = 'none'; }
    else img.style.backgroundImage = 'none';
    img.style.backgroundSize = t.bg.type === 'image' ? (t.bg.fit === 'contain' ? 'contain' : t.bg.fit === 'tile' ? 'auto' : 'cover') : '';
    img.style.backgroundRepeat = t.bg.type === 'image' && t.bg.fit === 'tile' ? 'repeat' : 'no-repeat';
    if (t.bg.type === 'rainbow') {
      rbw.style.setProperty('--rb-l', p.light ? '84%' : '22%');
      rbw.style.setProperty('--rb-dur', `${rbPeriod(t).toFixed(1)}s`);
    }
  }
  // glass: how see-through the sidebar / bar / panels are over the background
  const alpha = hasBg ? Math.max(0.12, 1 - (t.glass / 100) * 0.88) : 1;
  root.setProperty('--glass-a', alpha.toFixed(3));
  root.setProperty('--glass-blur', hasBg && t.glass > 0 ? '22px' : '0px');
  root.setProperty('--np-art', (t.np.art / 100).toFixed(2));
  root.setProperty('--np-blur', `${t.np.blur}px`);
  root.setProperty('--np-dim', (t.np.dim / 100).toFixed(2));
  root.setProperty('--np-solid', (1 - t.np.through / 100).toFixed(2));
  root.setProperty('--r', `${t.radius}px`);
  root.setProperty('--r2', `${Math.round(t.radius * 1.5)}px`);
  root.setProperty('--r-art', `${Math.max(2, Math.round(t.radius * 0.75))}px`);
  root.setProperty('--font', (FONTS[t.font] || FONTS.system).css);
  root.setProperty('--font-d', (FONTS[t.font] || FONTS.system).css);
  document.body.classList.toggle('compact', t.density === 'compact');
  document.body.classList.toggle('no-tint', !t.tint);
  document.documentElement.style.zoom = String((t.scale || 100) / 100);
  applyEffects(t.fx, () => setTheme({ fx: { snow: { shovel: false } } }));
  rbRun(t);
  listeners.forEach((fn) => fn(t));
}

/* A RAINBOW ACCENT / TINT / LOOK STEPS ONCE A SECOND, it does not glide: every step restyles the whole app (the desk
   measured 9-31 ms a step on its board). Transitions are off for the step (html.rb-tick) so ~100 buttons don't all
   start a colour fade at once. Stops on a hidden window. The rainbow BACKGROUND is a sliding element instead (CSS). */
let rbTimer = 0;
function rbRun(t) {
  const R = rbActive(t);
  const want = !STILL && (R.acc || R.look || R.tint);
  if (want && !rbTimer) rbTimer = setInterval(rbStep, 1000);
  else if (!want && rbTimer) { clearInterval(rbTimer); rbTimer = 0; }
}
function rbStep() {
  if (document.hidden) return;
  const html = document.documentElement;
  html.classList.add('rb-tick');
  applyColours(theme);
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('rb-tick')));
}

let saveTimer = null;
export function setTheme(patch) {
  const fxp = patch.fx || {};
  theme = merge({
    ...theme, ...patch,
    bg: { ...theme.bg, ...(patch.bg || {}) },
    wash: { ...theme.wash, ...(patch.wash || {}) },
    np: { ...theme.np, ...(patch.np || {}) },
    fx: { ...theme.fx, ...fxp, snow: { ...theme.fx.snow, ...(fxp.snow || {}) }, stars: { ...theme.fx.stars, ...(fxp.stars || {}) }, embers: { ...theme.fx.embers, ...(fxp.embers || {}) } },
  });
  try { localStorage.setItem('tempo.theme', JSON.stringify(theme)); } catch {}
  applyTheme(theme);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => post('/api/settings', { theme }).catch(() => {}), 400);
}

/** picking a desk look brings its accent, and a seasonal look turns its effect on (the desk's behaviour) */
export function pickPalette(id) {
  const L = LOOK_BY_ID[id];
  const patch = { palette: id };
  if (L) {
    patch.accent = L.acc;
    if (L.fx) { if (L.fx !== 'snow') clearSnow(); patch.fx = { type: L.fx }; }
  }
  setTheme(patch);
}

export function resetTheme() { setTheme(DEFAULT_THEME); }
export const currentHue = () => rbHue();
export const rainbowHex = (h, s, l) => rbHex(h, s, l);

// the "Album art" background + automatic accent follow the song
export function onArt(url, rgb) {
  lastArt = url ? url.replace(/=w\d+-h\d+[^&]*/, '=w800-h800-l90-rj') : null;
  if (rgb) lastArtRgb = rgb;
  if (theme.accent === 'auto' && rgb) document.documentElement.style.setProperty('--acc', rgb.join(' '));
  if (theme.bg.type === 'art') applyTheme(theme);
}

// the engine's copy wins (it survives a cleared browser cache); localStorage only makes boot instant
export async function syncFromEngine() {
  try {
    const s = (await get('/api/settings')).settings;
    if (s.theme && JSON.stringify(merge(s.theme)) !== JSON.stringify(theme)) {
      theme = merge(s.theme);
      try { localStorage.setItem('tempo.theme', JSON.stringify(theme)); } catch {}
      applyTheme(theme);
    }
  } catch {}
}
