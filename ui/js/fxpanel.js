// Equalizer + "make a version" (slowed / reverb / sped up / bass) panels.
import { get, post } from './api.js';
import { h, icon, img, modal, store, toast, run, prompt, on, emit } from './ui.js';

let presetsCache = null;
async function fxPresets() {
  if (!presetsCache) presetsCache = (await get('/api/fx/presets')).presets;
  return presetsCache;
}

export function describeFx(f) {
  if (!f) return '';
  const parts = [];
  const s = f.speed ?? 1;
  if (s < 0.97) parts.push('slowed');
  else if (s > 1.03) parts.push(s >= 1.3 && !f.keep_pitch ? 'nightcore' : 'sped up');
  if (f.reverb) parts.push('reverb');
  if ((f.bass || 0) > 3) parts.push('bass boosted');   // light bass touches aren't worth naming
  if (f.muffle) parts.push('muffled');
  return parts.join(' + ');
}
const isOriginal = (f) => !f || ((f.speed ?? 1) === 1 && !f.reverb && !f.bass && !f.muffle);

// a labelled slider row
function slider({ label, min, max, step, value, fmt, onInput }) {
  const out = h('span', { class: 'sl-val' }, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value, class: 'range' });
  const paint = () => input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
  input.addEventListener('input', () => { out.textContent = fmt(+input.value); paint(); onInput(+input.value); });
  paint();
  const row = h('div', { class: 'sl-row' }, h('div', { class: 'sl-head' }, h('span', null, label), out), input);
  row.set = (v) => { input.value = v; out.textContent = fmt(+v); paint(); };
  return row;
}

// ------------------------------------------------------------------ make a version
export async function openFx(track, opts = {}) {
  const globalMode = !!opts.global;          // "effects on every song"
  if (!track && !globalMode) return;
  const presets = await fxPresets();
  const base = { speed: 1, reverb: 0, bass: 0, muffle: 0, keep_pitch: false };
  const g = store.state?.global_fx || { on: false, fx: {} };
  let gOn = !!g.on;
  let f = globalMode ? { ...base, ...(g.fx || {}) } : { ...base, ...(track.fx || {}) };
  const sameSong = () => {
    const c = store.state?.track;
    return c && c.id === track.id && (c.qid === track.qid || !track.qid || (c.version_id || null) === (track.version_id || null));
  };
  let live = globalMode ? true : sameSong();
  let timer = null;
  const pushLive = () => {
    if (globalMode) {
      clearTimeout(timer);
      timer = setTimeout(() => post('/api/fx/global', isOriginal(f) ? { on: false } : { on: gOn, fx: f }).catch((e) => toast(e.message, 'error')), 180);
      return;
    }
    if (!live) return;
    clearTimeout(timer);
    timer = setTimeout(() => post('/api/fx/live', { fx: isOriginal(f) ? null : f }).catch((e) => toast(e.message, 'error')), 180);
  };
  const desc = h('div', { class: 'fx-desc' });
  const refreshDesc = () => {
    desc.textContent = isOriginal(f) ? 'Original' : describeFx(f);
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.p === matchPreset()));
  };
  const matchPreset = () => {
    if (isOriginal(f)) return 'Original';
    for (const [k, p] of Object.entries(presets)) {
      if (Math.abs(p.speed - f.speed) < 0.005 && p.reverb === f.reverb && Math.abs(p.bass - f.bass) < 0.05 && (p.muffle || 0) === (f.muffle || 0) && !!p.keep_pitch === !!f.keep_pitch) return k;
    }
    return '';
  };
  const change = (patch) => { f = { ...f, ...patch }; refreshDesc(); pushLive(); };

  const sSpeed = slider({ label: 'Speed', min: 0.5, max: 1.5, step: 0.01, value: f.speed, fmt: (v) => `${v.toFixed(2)}×`, onInput: (v) => change({ speed: v }) });
  const sRev = slider({ label: 'Reverb', min: 0, max: 100, step: 1, value: f.reverb, fmt: (v) => (v ? `${v}%` : 'Off'), onInput: (v) => change({ reverb: v }) });
  const sBass = slider({ label: 'Bass boost', min: 0, max: 12, step: 0.5, value: f.bass, fmt: (v) => (v ? `+${v} dB` : 'Off'), onInput: (v) => change({ bass: v }) });
  const sMuffle = slider({ label: 'Muffle (through a wall)', min: 0, max: 100, step: 1, value: f.muffle || 0, fmt: (v) => (v ? `${v}%` : 'Off'), onInput: (v) => change({ muffle: v }) });
  const pitch = h('input', { type: 'checkbox' });
  pitch.checked = !!f.keep_pitch;
  pitch.addEventListener('change', () => change({ keep_pitch: pitch.checked }));
  const setAll = (p) => { f = { ...base, ...p }; sSpeed.set(f.speed); sRev.set(f.reverb); sBass.set(f.bass); sMuffle.set(f.muffle || 0); pitch.checked = !!f.keep_pitch; refreshDesc(); pushLive(); };

  const chips = h('div', { class: 'chips fx-chips' },
    h('button', { class: 'chip', dataset: { p: 'Original' }, onclick: () => setAll(base) }, 'Original'),
    ...Object.entries(presets).map(([k, p]) => h('button', { class: 'chip', dataset: { p: k }, onclick: () => setAll(p) }, k)));

  const liveNote = h('div', { class: 'fx-live' });
  const paintLive = () => {
    if (globalMode) {
      liveNote.replaceChildren(gOn ? h('span', null, h('i', { class: 'live-dot' }), 'On: every song plays like this (your saved versions keep their own effects)') : h('span', null, 'Off: songs play normally'));
      return;
    }
    liveNote.replaceChildren(live
      ? h('span', null, h('i', { class: 'live-dot' }), 'Live: you’re hearing changes as you make them')
      : h('button', { class: 'btn', onclick: async () => {
          await run(() => post('/api/play', { kind: 'song', id: track.id, track: { ...track, fx: isOriginal(f) ? undefined : f } }));
          live = true; paintLive();
        } }, icon('play'), 'Preview'));
  };
  paintLive();

  const gSw = h('input', { type: 'checkbox' });
  gSw.checked = gOn;
  gSw.addEventListener('change', () => { gOn = gSw.checked; if (gOn && isOriginal(f)) setAll(presets['Slowed + reverb']); paintLive(); pushLive(); });
  const head = globalMode
    ? h('label', { class: 'fx-song global' }, h('div', { class: 'tt' }, h('div', { class: 'tname' }, 'Play everything with these effects'), h('div', { class: 'tsub' }, 'Every song gets them until you switch this off. Saved versions keep their own.')), desc, h('span', { class: 'switch' }, gSw, h('span')))
    : h('div', { class: 'fx-song' }, img(track.thumb, 'sm'), h('div', { class: 'tt' }, h('div', { class: 'tname' }, track.title), h('div', { class: 'tsub' }, track.artist || '')), desc);
  const body = h('div', { class: 'fx' },
    head,
    chips,
    h('div', { class: 'fx-sliders' }, sSpeed, sRev, sBass, sMuffle,
      h('label', { class: 'set-row slim fx-pitch' }, h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Keep original pitch'),
        h('div', { class: 'set-desc' }, 'Off = turntable style: slowed sounds deeper, sped up sounds higher.')),
        h('span', { class: 'switch' }, pitch, h('span')))),
    liveNote);

  const versionTrack = () => ({ ...track, fx: f });
  if (globalMode) {
    const m = modal({ title: 'Effects on every song', wide: true, body, actions: [{ label: 'Done', primary: true }] });
    refreshDesc();
    return m;
  }
  const m = modal({
    title: 'Make a version', wide: true, body,
    actions: [
      { label: 'Use on every song', onClick: async () => {
        if (isOriginal(f)) { toast('Pick an effect first', 'error'); return true; }
        await run(() => post('/api/fx/global', { on: true, fx: f }), `Every song now plays ${describeFx(f)}`);
      } },
      { label: 'Add to queue', onClick: () => { if (isOriginal(f)) return true; run(() => post('/api/queue/add', { tracks: [versionTrack()] })); } },
      { label: 'Save to My versions', primary: true, onClick: async () => {
        if (isOriginal(f)) { toast('Pick an effect first', 'error'); return true; }
        const name = await prompt('Save version', 'Name', `${track.title} (${describeFx(f)})`);
        if (!name) return true;
        await run(() => post('/api/versions/save', { track, fx: f, title: name }));
        emit('versions-changed');
      } },
    ],
  });
  refreshDesc();
  return m;
}

// ------------------------------------------------------------------ equalizer
export async function openEq() {
  const data = await get('/api/eq');
  let eq = { on: false, preset: 'Flat', bands: Array(10).fill(0), preamp: 0, ...(data.eq || {}) };
  let timer = null;
  const push = () => { clearTimeout(timer); timer = setTimeout(() => post('/api/eq', eq).catch((e) => toast(e.message, 'error')), 140); };

  const onSw = h('input', { type: 'checkbox' });
  onSw.checked = !!eq.on;
  const presetSel = h('select', { class: 'select' }, ...Object.keys(data.presets).map((k) => h('option', { value: k }, k)), h('option', { value: 'Custom' }, 'Custom'));
  presetSel.value = data.presets[eq.preset] ? eq.preset : 'Custom';

  const bars = h('div', { class: 'eq-bands' });
  const cols = data.bands.map((label, i) => {
    const val = h('div', { class: 'eq-val' });
    const input = h('input', { type: 'range', class: 'range vertical', min: -12, max: 12, step: 0.5, value: eq.bands[i] });
    const paint = () => { const v = +input.value; val.textContent = (v > 0 ? '+' : '') + v; input.style.setProperty('--p', `${((v + 12) / 24) * 100}%`); };
    input.addEventListener('input', () => {
      eq.bands[i] = +input.value; eq.preset = 'Custom'; presetSel.value = 'Custom';
      if (!eq.on) { eq.on = true; onSw.checked = true; }
      paint(); push();
    });
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
    paint();
    const col = h('div', { class: 'eq-col' }, val, h('div', { class: 'eq-slot' }, input), h('div', { class: 'eq-lab' }, label));
    col.set = (v) => { input.value = v; paint(); };
    bars.append(col);
    return col;
  });
  const pre = slider({ label: 'Preamp', min: -12, max: 6, step: 0.5, value: eq.preamp, fmt: (v) => `${v > 0 ? '+' : ''}${v} dB`, onInput: (v) => { eq.preamp = v; push(); } });

  onSw.addEventListener('change', () => { eq.on = onSw.checked; push(); });
  presetSel.addEventListener('change', () => {
    if (presetSel.value === 'Custom') return;
    eq.preset = presetSel.value;
    eq.bands = [...data.presets[presetSel.value]];
    eq.on = true; onSw.checked = true;
    cols.forEach((c, i) => c.set(eq.bands[i]));
    push();
  });

  const body = h('div', { class: 'eqp' },
    h('div', { class: 'eq-top' },
      h('label', { class: 'eq-on' }, h('span', { class: 'switch' }, onSw, h('span')), h('span', null, 'Equalizer')),
      presetSel,
      h('button', { class: 'btn', onclick: () => { eq.bands = Array(10).fill(0); eq.preamp = 0; eq.preset = 'Flat'; presetSel.value = 'Flat'; cols.forEach((c) => c.set(0)); pre.set(0); push(); } }, 'Reset')),
    bars, pre,
    h('div', { class: 'set-desc' }, 'Applies to everything you play. Double-click a slider to zero it. A limiter keeps boosts from distorting.'));
  modal({ title: 'Equalizer', wide: true, body });
}

// ------------------------------------------------------------------ background sounds: a mixer of real recordings
export async function openBg() {
  const { state, sounds, presets, max } = await get('/api/bg');
  const byId = Object.fromEntries(sounds.map((s) => [s.id, s]));
  let st = { ...state, mix: { ...state.mix } };
  const timers = {};
  // sliders send at most every 150 ms; a tile / preset / switch goes at once
  const push = (patch, now = false, key = 'x') => {
    clearTimeout(timers[key]);
    const go = () => post('/api/bg', patch).then((r) => { if (r && r.state && now) { st = { ...r.state, mix: { ...r.state.mix } }; paint(); } }).catch((e) => toast(e.message, 'error'));
    if (now) go(); else timers[key] = setTimeout(go, 150);
  };
  const onSw = h('input', { type: 'checkbox' });
  onSw.checked = !!st.on;
  onSw.addEventListener('change', () => { st.on = onSw.checked; push({ on: onSw.checked }, true); });

  // presets
  const pres = h('div', { class: 'chips bg-presets' });
  presets.forEach((p) => pres.append(h('button', { class: 'chip', onclick: () => {
    st.mix = { ...p.mix }; st.on = true; onSw.checked = true; paint();
    push({ mix: p.mix, on: true }, true);
  } }, p.name)));

  // tiles, grouped
  const groups = h('div', { class: 'bg-groups' });
  const tiles = {};
  for (const g of [...new Set(sounds.map((s) => s.group))]) {
    const grid = h('div', { class: 'bg-tiles' });
    sounds.filter((s) => s.group === g).forEach((s) => {
      const lvl = h('i', { class: 'bg-lvl' });
      const t = h('button', { class: 'bg-tile', title: s.name, onclick: () => {
        const on = s.id in st.mix;
        if (on && Object.keys(st.mix).length === 1 && st.on) { onSw.checked = false; st.on = false; push({ on: false }, true); paint(); return; }
        if (on) delete st.mix[s.id];
        else { st.mix[s.id] = 70; const ks = Object.keys(st.mix); while (ks.length > max) delete st.mix[ks.shift()]; }
        st.on = true; onSw.checked = true; paint();
        push({ sound: s.id, toggle: true, on: true }, true);
      } }, icon(s.icon || 'waveform'), h('span', null, s.name), lvl);
      tiles[s.id] = t;
      grid.append(t);
    });
    groups.append(h('div', { class: 'bg-group' }, h('div', { class: 'bg-ghead' }, g), grid));
  }

  // your mix: one level per playing sound
  const mixBox = h('div', { class: 'bg-mix' });
  function paint() {
    for (const [id, t] of Object.entries(tiles)) {
      const on = id in st.mix;
      t.classList.toggle('on', on && st.on);
      t.classList.toggle('in', on);
      t.querySelector('.bg-lvl').style.width = on ? `${st.mix[id]}%` : '0';
    }
    mixBox.replaceChildren();
    const ids = Object.keys(st.mix);
    mixBox.append(h('div', { class: 'bg-ghead' }, `Your mix · up to ${max} at once`));
    ids.forEach((id) => {
      const s = byId[id];
      if (!s) return;
      const out = h('span', { class: 'sl-val' }, `${st.mix[id]}%`);
      const input = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, value: st.mix[id] });
      const pnt = () => input.style.setProperty('--p', `${input.value}%`);
      pnt();
      input.addEventListener('input', () => {
        st.mix[id] = +input.value; out.textContent = `${input.value}%`; pnt();
        tiles[id].querySelector('.bg-lvl').style.width = `${input.value}%`;
        push({ level: { [id]: +input.value } }, false, 'lvl-' + id);
      });
      mixBox.append(h('div', { class: 'bg-mixrow' }, icon(s.icon || 'waveform'), h('span', { class: 'bg-mixname' }, s.name), input, out,
        ids.length > 1 ? h('button', { class: 'ibtn sm', title: 'Take out of the mix', onclick: () => {
          delete st.mix[id]; paint(); push({ sound: id, toggle: true }, true);
        } }, icon('x')) : h('span', { class: 'ibtn sm' })));
    });
  }
  paint();

  const vol = slider({ label: 'Volume', min: 0, max: 100, step: 1, value: st.volume, fmt: (v) => `${v}%`, onInput: (v) => push({ volume: v }, false, 'vol') });
  const withMusic = slider({ label: 'Volume while music plays', min: 0, max: 100, step: 1, value: st.with_music, fmt: (v) => `${v}%`, onInput: (v) => push({ with_music: v }, false, 'wm') });
  const tog = (label, desc, key) => {
    const i = h('input', { type: 'checkbox' });
    i.checked = !!st[key];
    i.addEventListener('change', () => push({ [key]: i.checked }, true));
    return h('label', { class: 'set-row slim fx-pitch' }, h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, label), h('div', { class: 'set-desc' }, desc)), h('span', { class: 'switch' }, i, h('span')));
  };
  const body = h('div', { class: 'fx bgp' },
    h('label', { class: 'eq-on' }, h('span', { class: 'switch' }, onSw, h('span')), h('span', null, 'Play background sounds')),
    pres, groups, mixBox,
    h('div', { class: 'fx-sliders' }, vol, withMusic,
      tog('Stop when music plays', 'Only play the sounds while your music is paused or stopped.', 'stop_with_music'),
      tog('Turn off with the sleep timer', 'When the sleep timer ends, the sounds fade out too.', 'stop_with_sleep')),
    h('div', { class: 'set-desc' }, 'Click sounds to layer them. They keep playing while music is paused. Press B to turn them on or off.'));
  modal({ title: 'Background sounds', wide: true, body, actions: [{ label: 'Done', primary: true }] });
}
