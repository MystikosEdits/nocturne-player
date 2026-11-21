// Settings -> Appearance: everything about how Nocturne looks, applied live as you change it. Includes every
// Reaction Desk look, its rainbow options and its three effects (snow / starfield / embers) with all their knobs.
import { post } from './api.js';
import { h, icon, toast } from './ui.js';
import { PALETTES, DESK_LOOKS, ACCENTS, FONTS, getTheme, setTheme, resetTheme, flushTheme, onTheme, paletteOf, pickPalette } from './theme.js';
import { FX_DEF, FX_KNOBS, fmtKnob, clearSnow } from './effects.js';

function seg(options, value, onPick) {
  const el = h('div', { class: 'seg' });
  options.forEach(([v, label]) => el.append(h('button', { class: `seg-b ${v === value ? 'on' : ''}`, onclick: () => {
    el.querySelectorAll('.seg-b').forEach((b) => b.classList.remove('on'));
    el.querySelector(`[data-v="${v}"]`).classList.add('on');
    onPick(v);
  }, dataset: { v } }, label)));
  return el;
}

function range(min, max, step, value, fmt, onInput, dflt) {
  const out = h('span', { class: 'sl-val' }, fmt(value));
  const input = h('input', { type: 'range', class: 'range', min, max, step, value });
  const paint = () => {
    input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
    if (dflt !== undefined) out.classList.toggle('dflt', +input.value === dflt);
  };
  input.addEventListener('input', () => { out.textContent = fmt(+input.value); paint(); onInput(+input.value); });
  if (dflt !== undefined) input.addEventListener('dblclick', () => { input.value = dflt; out.textContent = fmt(dflt); paint(); onInput(dflt); });
  paint();
  return h('div', { class: 'ap-range' }, input, out);
}

const row = (title, desc, control) => h('div', { class: 'set-row' },
  h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, title), desc ? h('div', { class: 'set-desc' }, desc) : null), control);

function toggleEl(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}

const pct = (v) => (v ? `${v}%` : 'off');

// ------------------------------------------------------------------ theme tiles
function palTile(id, p, accentCss, badge) {
  return h('button', { class: `pal ${getTheme().palette === id ? 'on' : ''}`, dataset: { k: id }, title: p.name, onclick: (e) => {
    e.currentTarget.closest('.pal-all').querySelectorAll('.pal').forEach((x) => x.classList.toggle('on', x.dataset.k === id));
    pickPalette(id);
  } },
    h('div', { class: 'pal-prev', style: { background: p.bg } },
      h('i', { style: { background: p.bg2 } }), h('b', { style: { background: p.raise } }), h('u', { style: { background: accentCss } }),
      badge ? h('em', { class: 'pal-badge' }, icon(badge)) : null),
    h('span', null, p.name));
}

function themeGrid() {
  const all = h('div', { class: 'pal-all' });
  const own = h('div', { class: 'pal-grid' });
  for (const [k, p] of Object.entries(PALETTES)) own.append(palTile(k, p, 'rgb(var(--acc))'));
  all.append(h('div', { class: 'pal-ghead' }, 'Nocturne'), own);
  for (const g of ['Base', 'Colours', 'Seasonal']) {
    const grid = h('div', { class: 'pal-grid' });
    DESK_LOOKS.filter((l) => l.g === g).forEach((l) => {
      const p = paletteOf(l.id);
      const acc = l.acc === 'rainbow' ? 'linear-gradient(90deg,#ff5c5c,#ffd84d,#5cff8a,#5cc8ff,#b05cff)' : l.acc;
      grid.append(palTile(l.id, p, acc, l.fx === 'snow' ? 'snowflake' : l.fx === 'embers' ? 'flame' : l.fx === 'stars' ? 'stars' : null));
    });
    all.append(h('div', { class: 'pal-ghead' }, `Reaction Desk · ${g}`), grid);
  }
  return all;
}

// ------------------------------------------------------------------ Now Playing backdrop (also opened from Now Playing itself)
export function npControls(compact = false) {
  const n = getTheme().np;
  const wrap = h('div', { class: compact ? 'np-ctl' : '' });
  const add = (title, desc, ctl) => wrap.append(compact ? h('div', { class: 'np-ctl-row' }, h('span', null, title), ctl) : row(title, desc, ctl));
  add('Album art', 'How strongly the blurred cover shows behind Now Playing.', range(0, 100, 1, n.art, pct, (v) => setTheme({ np: { art: v } }), 55));
  add('Blur', null, range(0, 120, 2, n.blur, (v) => (v ? `${v}px` : 'off'), (v) => setTheme({ np: { blur: v } }), 70));
  add('Darken', 'Keeps the words readable over a bright cover.', range(0, 100, 1, n.dim, pct, (v) => setTheme({ np: { dim: v } }), 82));
  add('See-through', 'Lets your theme background show behind Now Playing. 0 = solid.', range(0, 100, 1, n.through, pct, (v) => setTheme({ np: { through: v } }), 0));
  return wrap;
}

// ------------------------------------------------------------------ the section
export function appearanceSection() {
  const t = getTheme();
  const card = h('div', { class: 'set-card' });

  card.append(h('div', { class: 'set-row col' }, h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Theme'),
    h('div', { class: 'set-desc' }, 'Every Reaction Desk look is here too. A seasonal look turns its effect on (snow, embers or stars); you can change it below.')), themeGrid()));

  // accent
  const acc = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color', class: 'color-in', value: /^#/.test(t.accent) ? t.accent : '#a78bfa', title: 'Any colour' });
  const pickAcc = (v) => {
    acc.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    setTheme({ accent: v });
    if (v === 'auto') toast('Accent now follows the album art');
  };
  ACCENTS.forEach((c) => acc.append(h('button', {
    class: `sw ${c === 'auto' ? 'auto' : ''} ${c === 'rainbow' ? 'rb' : ''} ${t.accent === c ? 'on' : ''}`, dataset: { v: c },
    title: c === 'auto' ? 'From the album art' : c === 'rainbow' ? 'Rainbow: cycles through every colour' : c,
    style: c === 'auto' || c === 'rainbow' ? {} : { background: c }, onclick: () => pickAcc(c) }, c === 'auto' ? 'A' : '')));
  custom.addEventListener('input', () => { acc.querySelectorAll('.sw').forEach((x) => x.classList.remove('on')); setTheme({ accent: custom.value }); });
  acc.append(h('label', { class: 'sw custom', title: 'Pick any colour' }, icon('palette'), custom));
  card.append(row('Accent colour', '“A” follows the album art. The striped one cycles through the rainbow.', acc));

  // background
  const bgBox = h('div', { class: 'bg-opts' });
  const renderBg = () => {
    const b = getTheme().bg;
    bgBox.replaceChildren();
    if (b.type === 'colour') {
      const c = h('input', { type: 'color', class: 'color-in big', value: b.color });
      c.addEventListener('input', () => setTheme({ bg: { color: c.value } }));
      bgBox.append(row('Colour', null, c));
    }
    if (b.type === 'gradient') {
      const c1 = h('input', { type: 'color', class: 'color-in big', value: b.c1 });
      const c2 = h('input', { type: 'color', class: 'color-in big', value: b.c2 });
      c1.addEventListener('input', () => setTheme({ bg: { c1: c1.value } }));
      c2.addEventListener('input', () => setTheme({ bg: { c2: c2.value } }));
      bgBox.append(row('Gradient colours', null, h('div', { class: 'row-inline tight' }, c1, c2)),
        row('Angle', null, range(0, 360, 5, b.angle, (v) => `${v}°`, (v) => setTheme({ bg: { angle: v } }))));
    }
    if (b.type === 'image') {
      const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      file.addEventListener('change', async () => {
        const f = file.files[0];
        if (!f) return;
        if (f.size > 25 * 1024 * 1024) return toast('Pick an image under 25 MB', 'error');
        const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
        try {
          const { url } = await post('/api/theme/background', { data, type: f.type });
          setTheme({ bg: { type: 'image', image: url } });
          renderBg();
        } catch (e) { toast(e.message, 'error'); }
      });
      bgBox.append(row('Your image', b.image ? 'Saved on this computer.' : 'Any picture: wallpaper, artwork, a photo.',
        h('div', { class: 'row-inline tight' },
          b.image ? h('div', { class: 'bg-thumb', style: { backgroundImage: `url("${b.image}")` } }) : null,
          h('button', { class: 'btn', onclick: () => file.click() }, icon('image'), b.image ? 'Change' : 'Choose image'), file)));
      if (b.image) bgBox.append(row('Fit', null, seg([['cover', 'Fill'], ['contain', 'Whole image'], ['tile', 'Tile']], b.fit || 'cover', (v) => setTheme({ bg: { fit: v } }))));
    }
    if (b.type !== 'none') {
      if (b.type === 'art' || b.type === 'image') bgBox.append(row('Blur', null, range(0, 80, 1, b.blur, (v) => `${v}px`, (v) => setTheme({ bg: { blur: v } }))));
      bgBox.append(row('Darken', 'Keeps text readable over bright backgrounds.', range(0, 95, 1, b.dim, (v) => `${v}%`, (v) => setTheme({ bg: { dim: v } }))),
        row('Glass', 'How see-through the sidebar, player bar and panels are.', range(0, 100, 1, getTheme().glass, (v) => `${v}%`, (v) => setTheme({ glass: v }))));
    }
  };
  card.append(row('Background', null, seg([['none', 'None'], ['art', 'Album art'], ['colour', 'Colour'], ['gradient', 'Gradient'], ['image', 'Image'], ['rainbow', 'Rainbow']], t.bg.type, (v) => {
    setTheme({ bg: { type: v }, glass: getTheme().glass || (v === 'none' ? 0 : 45), ...(v === 'rainbow' && !getTheme().bg.dim ? { bg: { type: v, dim: 30 } } : {}) });
    renderBg();
  })), bgBox);
  renderBg();

  // tint (the desk's "Tint the desk")
  const tintC = h('input', { type: 'color', class: 'color-in', value: /^#/.test(t.wash.color) ? t.wash.color : '#5B8DEF' });
  const tintRb = h('button', { class: `sw rb ${t.wash.color === 'rainbow' ? 'on' : ''}`, title: 'Rainbow tint' });
  tintC.addEventListener('input', () => { tintRb.classList.remove('on'); setTheme({ wash: { color: tintC.value, amount: getTheme().wash.amount || 12 } }); syncTint(); });
  tintRb.addEventListener('click', () => {
    const on = getTheme().wash.color !== 'rainbow';
    tintRb.classList.toggle('on', on);
    setTheme({ wash: { color: on ? 'rainbow' : tintC.value, amount: getTheme().wash.amount || 12 } }); syncTint();
  });
  const tintAmt = range(0, 40, 1, t.wash.amount, pct, (v) => setTheme({ wash: { amount: v } }));
  const syncTint = () => { const inp = tintAmt.querySelector('input'); inp.value = getTheme().wash.amount; inp.dispatchEvent(new Event('input')); };
  card.append(row('Tint the app', 'Mixes a colour into every surface.', h('div', { class: 'row-inline tight' }, tintRb, tintC, tintAmt)));

  // rainbow speed: only while something is cycling
  const rbRow = row('Rainbow speed', 'One speed for the rainbow accent, background and tint.', range(10, 400, 5, t.rainbowSpeed, (v) => `×${(v / 100).toFixed(2)}`, (v) => setTheme({ rainbowSpeed: v }), 100));
  const syncRb = (th) => {
    const L = DESK_LOOKS.find((l) => l.id === th.palette);
    rbRow.style.display = th.accent === 'rainbow' || (L && L.acc === 'rainbow') || th.bg.type === 'rainbow' || (th.wash.color === 'rainbow' && th.wash.amount > 0) ? '' : 'none';
  };
  syncRb(t);
  card.append(rbRow);

  // effects
  const fxBox = h('div', { class: 'bg-opts' });
  const renderFx = () => {
    const fx = getTheme().fx;
    fxBox.replaceChildren();
    if (fx.type === 'off') return;
    const o = fx[fx.type];
    const set = (k, v) => setTheme({ fx: { [fx.type]: { [k]: v } } });
    fxBox.append(row('Only behind the app', 'Off = over everything, like the desk. On = behind the sidebar, bar and panels.', toggleEl(fx.back, (v) => setTheme({ fx: { back: v } }))));
    fxBox.append(row('Smoothness', 'Light = 30 frames a second, about half the CPU of Smooth (60). Slow snow and stars look the same.', seg([[30, 'Light'], [60, 'Smooth']], +fx.fps === 60 ? 60 : 30, (v) => setTheme({ fx: { fps: +v } }))));
    if (fx.type === 'snow') {
      fxBox.append(row('Settle at the bottom', 'Snow slowly piles into a drift along the bottom of the window.', toggleEl(o.pile, (v) => { set('pile', v); if (!v) clearSnow(); renderFx(); })));
      if (o.pile) fxBox.append(row('Shovel', 'Dig the drift with your mouse. Esc puts it down.', toggleEl(o.shovel, (v) => set('shovel', v))));
    }
    fxBox.append(row('Rainbow', null, toggleEl(o.rainbow, (v) => set('rainbow', v))));
    const grid = h('div', { class: 'knob-grid' });
    FX_KNOBS[fx.type].forEach((s) => {
      if (s.pile && !o.pile) return;
      grid.append(h('div', { class: 'knob' }, h('div', { class: 'knob-name' }, s.n), range(s.lo, s.hi, s.st, o[s.k], (v) => fmtKnob(s, v), (v) => set(s.k, v), FX_DEF[fx.type][s.k])));
    });
    fxBox.append(h('div', { class: 'set-row col' }, grid,
      h('button', { class: 'btn', style: { alignSelf: 'flex-start' }, onclick: () => { setTheme({ fx: { [fx.type]: { ...FX_DEF[fx.type] } } }); renderFx(); } }, 'Reset this effect')));
  };
  const fxSeg = seg([['off', 'Off'], ['snow', 'Snow'], ['stars', 'Starfield'], ['embers', 'Embers']], t.fx.type, (v) => { setTheme({ fx: { type: v } }); renderFx(); });
  card.append(row('Effect', 'From the Reaction Desk. Paused whenever the window is hidden or minimised.', fxSeg), fxBox);
  renderFx();
  // a seasonal look switches the effect: keep the control in step
  let lastFx = t.fx.type, lastShovel = !!t.fx.snow?.shovel;
  const off = onTheme((th) => {
    if (!card.isConnected) { off(); return; }      // Settings was left: stop listening
    syncRb(th);
    if (th.fx.type !== lastFx) {
      lastFx = th.fx.type;
      fxSeg.querySelectorAll('.seg-b').forEach((b) => b.classList.toggle('on', b.dataset.v === th.fx.type));
      renderFx();
    } else if (!!th.fx.snow?.shovel !== lastShovel) renderFx();   // Esc put the shovel down: untick it
    lastShovel = !!th.fx.snow?.shovel;
  });

  // now playing
  card.append(h('div', { class: 'set-row sub-head' }, h('div', { class: 'set-title' }, 'Now Playing background')), npControls());

  // layout + type
  card.append(
    row('Size', 'Scales the whole app.', range(80, 130, 5, t.scale, (v) => `${v}%`, (v) => setTheme({ scale: v }))),
    row('Corners', null, range(0, 20, 1, t.radius, (v) => (v ? `${v}px` : 'Square'), (v) => setTheme({ radius: v }))),
    row('Density', 'Compact fits more songs on screen.', seg([['comfortable', 'Comfortable'], ['compact', 'Compact']], t.density, (v) => setTheme({ density: v }))),
    row('Font', null, seg(Object.entries(FONTS).map(([k, f]) => [k, f.name]), t.font, (v) => setTheme({ font: v }))),
    row('Colour page headers', 'Albums, playlists and artists glow in their artwork’s colour.', toggleEl(t.tint, (v) => setTheme({ tint: v }))),
    row('Reset', 'Back to the original Nocturne look.', h('button', { class: 'btn', onclick: () => { resetTheme(); flushTheme().then(() => location.reload()); } }, 'Reset appearance')),
  );
  return h('section', { class: 'set-sec' }, h('h2', null, 'Appearance'), card);
}
