// Snow, Starfield and Embers: ported from the Reaction Desk's Themes menu (rig index.html, SNOW / STARS / EMBERS,
// Sep 2026), same tuning, same knobs (every knob is a % of the desk's tuning, 100 = how the desk looks by default).
// Two changes for a music player that should stay light:
//   - drawn at 30 fps by default, 60 if you pick Smooth (the laptop's screen runs at 239 Hz; measured Nov 20 at 1920x1040
//     in headless Edge, 60 fps: snow 13%, starfield 23%, embers 13% of a core; rainbow 2%)
//   - every loop stops dead when the window is hidden / minimised, and an effect that is off has no canvas at all.
// pointer-events: none on every canvas, so they never get in the way of a click.

const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
let MIN_FRAME = 32.5;        // ms between frames: 30 fps by default ("Light"), 15.5 = 60 fps ("Smooth")
const M = (v) => (v === undefined ? 100 : v) / 100;

export function rbRGB(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
// An effect's rainbow is a band across the screen that drifts sideways (a lap in 20 s): colour by position, not per particle.
const rbSweep = (x, w, clk) => ((((x / Math.max(1, w)) * 360 + clk * 18) % 360) + 360) % 360;

const zoomOf = () => parseFloat(document.documentElement.style.zoom || '1') || 1;
function fit(c, w, h) { const z = zoomOf(); c.style.width = `${w / z}px`; c.style.height = `${h / z}px`; }
function canvas(id) {
  let c = document.getElementById(id);
  if (!c) {
    c = document.createElement('canvas');
    c.id = id;
    c.className = 'fx-canvas';
    c.setAttribute('aria-hidden', 'true');
    document.body.append(c);
  }
  return c;
}

// ------------------------------------------------------------------ snow (with the settling drift + shovel)
const SNOW = (() => {
  let c = null, ctx = null, flakes = [], w = 0, h = 0, raf = 0, last = 0, clk = 0;
  const opt = { on: false, pile: false, amount: 100, size: 100, speed: 100, sway: 100, bright: 100, depth: 30, rainbow: false };
  const COL = 6;
  let target = null, shown = null, smooth = null, maxDrift = 0;
  // THE DRIFT SETTLES ON TOP OF THE PLAYER BAR, not the window's bottom edge: a drift on the bottom edge would bury
  // the play controls. floor = where the bar starts (as a share of the window, so the page zoom doesn't matter).
  let floor = 0;
  const floorOf = () => { const bar = document.getElementById('bar'), de = document.documentElement;
    return bar && !document.body.classList.contains('mini') && de.clientHeight ? h * (1 - bar.offsetHeight / de.clientHeight) : h; };
  const DEPTH_SHARE = 0.2, DEPTH_MAX = 170;
  const depthFor = () => Math.min(h * DEPTH_SHARE * M(opt.depth), DEPTH_MAX);
  // the full drift is an undulating ridge, not a ruler-straight line
  const CAP_PH = [Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283];
  const capAt = (i) => {
    const x = i * COL;
    const n = Math.sin(x * 0.0042 + CAP_PH[0]) * 0.55 + Math.sin(x * 0.0111 + CAP_PH[1]) * 0.3 + Math.sin(x * 0.0233 + CAP_PH[2]) * 0.15;
    return maxDrift * (0.78 + 0.22 * n);
  };
  function heap(i, amt) {
    if (i < 0 || i >= target.length) return;
    const cap = capAt(i);
    if (target[i] >= cap) return;
    target[i] += amt * Math.max(0.06, 1 - target[i] / cap);
    if (target[i] > cap) target[i] = cap;
  }
  function flake(y) {
    const d = Math.random();
    return { x: Math.random() * w, y, r: (0.7 + d * 2.0) * M(opt.size), fall: (12 + d * 30) * M(opt.speed),
      drift: (Math.random() - 0.5) * 14 * M(opt.sway), ph: Math.random() * 6.283, sway: (0.4 + Math.random() * 0.9) * M(opt.sway),
      a: Math.min(0.95, (0.16 + d * 0.3) * M(opt.bright)) };
  }
  const count = () => Math.min(900, Math.round(Math.max(30, Math.min(150, Math.round((w * h) / 16000))) * M(opt.amount)));
  function size() {
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); fit(c, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#D8E3F0';
    floor = floorOf();
    maxDrift = depthFor();
    const cols = Math.ceil(w / COL) + 1;
    if (!target || target.length !== cols) { target = new Float32Array(cols); shown = new Float32Array(cols); smooth = new Float32Array(cols); }
    flakes = [];
    for (let i = 0, n = count(); i < n; i++) flakes.push(flake(Math.random() * h));
    if (STILL) draw(0);
  }
  // the angle of repose: mass runs downhill over +/-6 columns, so the surface reads as snow, not spikes
  function settle(i) {
    const lo = Math.max(0, i - 6), hi = Math.min(target.length, i + 7);
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (let j = lo; j < hi; j++) {
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const k = j + sgn;
          if (k < 0 || k >= target.length) continue;
          if (target[j] - target[k] > 1.2) { const d = (target[j] - target[k]) * 0.35; target[j] -= d; target[k] += d; moved = true; }
        }
      }
      if (!moved) break;
    }
    for (let m = lo; m < hi; m++) { const cm = capAt(m); if (target[m] > cm) target[m] = cm; }
  }
  function land(f) {
    let i = Math.floor(f.x / COL);
    if (i < 0) i = 0; else if (i >= target.length) i = target.length - 1;
    if (f.y + f.r < floor - shown[i]) return false;
    const add = f.r * 7;
    heap(i, add * 0.5); heap(i - 1, add * 0.25); heap(i + 1, add * 0.25);
    settle(i);
    return true;
  }
  function ease(dt) {
    if (!target) return;
    const e = 1 - Math.exp(-dt * 2.5);
    for (let i = 0; i < target.length; i++) shown[i] += (target[i] - shown[i]) * e;
  }
  function drawDrift() {
    if (!opt.pile || !shown) return;
    const n = shown.length;
    let any = false;
    for (let k = 0; k < n; k++) if (shown[k] > 0.2) { any = true; break; }
    if (!any) return;
    for (let i = 0; i < n; i++) {
      const a = shown[i > 1 ? i - 2 : 0], b = shown[i > 0 ? i - 1 : 0], c0 = shown[i], d = shown[i < n - 1 ? i + 1 : n - 1], e2 = shown[i < n - 2 ? i + 2 : n - 1];
      smooth[i] = (a + 2 * b + 3 * c0 + 2 * d + e2) / 9;
    }
    ctx.beginPath();
    ctx.moveTo(0, floor);
    ctx.lineTo(0, floor - smooth[0]);
    for (let i = 0; i < n - 1; i++) {
      const x = i * COL, y = floor - smooth[i], nx = (i + 1) * COL, ny = floor - smooth[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(w, floor - smooth[n - 1]);
    ctx.lineTo(w, floor);
    ctx.closePath();
    let g;
    if (opt.rainbow) {
      g = ctx.createLinearGradient(0, 0, w, 0);
      for (let s = 0; s <= 6; s++) g.addColorStop(s / 6, `hsla(${Math.round(rbSweep((s / 6) * w, w, clk))},90%,78%,.9)`);
    } else {
      g = ctx.createLinearGradient(0, floor - maxDrift - 6, 0, floor);
      g.addColorStop(0, 'rgba(226,235,246,.95)');
      g.addColorStop(1, 'rgba(190,204,222,.80)');
    }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = '#D8E3F0';
  }
  function draw(dt) {
    ctx.clearRect(0, 0, w, h);
    clk += dt || 0;
    if (!opt.rainbow) ctx.fillStyle = '#D8E3F0';
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      if (dt) {
        f.y += f.fall * dt;
        f.ph += f.sway * dt;
        f.x += (f.drift + Math.sin(f.ph) * 10) * dt;
        if (opt.pile && land(f)) { flakes[i] = flake(-4); continue; }
        if (f.y - f.r > h) { flakes[i] = flake(-4); continue; }
        if (f.x < -8) f.x = w + 8; else if (f.x > w + 8) f.x = -8;
      }
      if (opt.rainbow) ctx.fillStyle = `hsl(${Math.round(rbSweep(f.x, w, clk))},100%,70%)`;
      ctx.globalAlpha = opt.rainbow ? Math.min(1, f.a * 1.5) : f.a;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ease(dt || 0.016);
    drawDrift();
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (last && t - last < MIN_FRAME) return;
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0.016;
    last = t;
    draw(dt);
  }
  const start = () => { if (STILL || raf || !opt.on || document.hidden) return; last = 0; raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  addEventListener('resize', () => { if (opt.on) size(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  return {
    set(o) {
      const was = opt.depth, sig = [opt.amount, opt.size, opt.speed, opt.sway, opt.bright].join(','), wasOn = opt.on;
      Object.assign(opt, o);
      if (!opt.on) { stop(); if (c) { c.remove(); c = null; ctx = null; } return; }
      if (!c) { c = canvas('fx-snow'); ctx = c.getContext('2d'); size(); }
      else if (!wasOn) size();
      if (opt.depth !== was) maxDrift = depthFor();
      if ([opt.amount, opt.size, opt.speed, opt.sway, opt.bright].join(',') !== sig) {
        const want = count();
        while (flakes.length > want) flakes.pop();
        while (flakes.length < want) flakes.push(flake(Math.random() * h));
        for (let i = 0; i < flakes.length; i++) flakes[i] = flake(flakes[i].y);
      }
      start();
    },
    clear() { if (target) { target.fill(0); shown.fill(0); } },
    floorY() { const bar = document.getElementById('bar'); return bar && !document.body.classList.contains('mini') ? bar.getBoundingClientRect().top : innerHeight; },
    // THE SHOVEL: take height out of the columns under the cursor, with a round (not square) bite
    dig(x, r) {
      if (!target) return;
      const cc = x / COL, span = Math.max(1, r / COL);
      for (let i = Math.floor(cc - span); i <= Math.ceil(cc + span); i++) {
        if (i < 0 || i >= target.length) continue;
        const d = Math.abs(i - cc) / span;
        if (d > 1) continue;
        target[i] *= 1 - 0.55 * (1 - d * d);
        if (shown[i] > target[i]) shown[i] = target[i];
      }
    },
  };
})();

// ------------------------------------------------------------------ embers
const EMBERS = (() => {
  let c = null, ctx = null, w = 0, h = 0, raf = 0, last = 0, clk = 0, bits = [];
  const opt = { on: false, amount: 100, size: 100, speed: 100, drift: 100, glow: 100, flicker: 100, bright: 100, heat: 50, rainbow: false };
  const RBN = 24, rbSprites = [], BASE = 0.000055, MAXBITS = 1400, SPR = 64;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = SPR;
  const sctx = sprite.getContext('2d');
  let spriteSig = '';
  const HEATS = [[214, 74, 28], [242, 160, 61], [255, 244, 214]];
  function heatRGB() {
    const t = Math.max(0, Math.min(1, M(opt.heat)));
    const a = HEATS[t < 0.5 ? 0 : 1], b = HEATS[t < 0.5 ? 1 : 2], k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return a.map((v, i) => Math.round(v + (b[i] - v) * k));
  }
  const halo = () => M(opt.glow);
  function paintSprite(sx, rgb) {
    const g = halo(), mid = SPR / 2, core = mid / (1 + g);
    sx.clearRect(0, 0, SPR, SPR);
    if (g > 0.001) {
      const grd = sx.createRadialGradient(mid, mid, core * 0.6, mid, mid, mid);
      grd.addColorStop(0, `rgba(${rgb},1)`);
      grd.addColorStop(core / mid, `rgba(${rgb},0.55)`);
      grd.addColorStop(0.55, `rgba(${rgb},0.16)`);
      grd.addColorStop(1, `rgba(${rgb},0)`);
      sx.fillStyle = grd;
      sx.fillRect(0, 0, SPR, SPR);
    }
    sx.fillStyle = `rgb(${rgb})`;
    sx.beginPath(); sx.arc(mid, mid, core, 0, 6.283); sx.fill();
  }
  function buildSprite() {
    const sig = `${opt.glow}/${opt.heat}/${!!opt.rainbow}`;
    if (sig === spriteSig) return;
    spriteSig = sig;
    paintSprite(sctx, heatRGB().join(','));
    if (opt.rainbow) for (let i = 0; i < RBN; i++) {
      let s = rbSprites[i];
      if (!s) { s = rbSprites[i] = document.createElement('canvas'); s.width = s.height = SPR; }
      paintSprite(s.getContext('2d'), rbRGB((i * 360) / RBN, 1, 0.6).join(','));
    }
  }
  function spark(atBottom) {
    const d = Math.random();
    return { x: Math.random() * w, y: atBottom ? h + Math.random() * 40 : Math.random() * h, r: (0.6 + d * 1.6) * M(opt.size),
      vy: -(9 + d * 26) * M(opt.speed), drift: (Math.random() - 0.5) * 10 * M(opt.drift), ph: Math.random() * 6.283,
      sway: (0.4 + Math.random() * 0.9) * M(opt.drift), a: (0.2 + d * 0.5) * M(opt.bright), tw: (0.7 + Math.random() * 1.6) * M(opt.flicker) };
  }
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); fit(c, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bits = [];
    for (let i = 0, n = Math.min(MAXBITS, Math.round(w * h * BASE * M(opt.amount))); i < n; i++) bits.push(spark(false));
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (last && ts - last < MIN_FRAME) return;
    const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0.016;
    last = ts;
    ctx.clearRect(0, 0, w, h);
    clk += dt;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      b.y += b.vy * dt;
      b.ph += dt * b.tw;
      b.x += (b.drift + Math.sin(b.ph) * 7 * M(opt.drift)) * dt;
      if (b.y < -12 || b.x < -20 || b.x > w + 20) bits[i] = spark(true);
      const climb = 1 - b.y / Math.max(1, h);
      const alpha = b.a * (0.35 + 0.65 * Math.sin(b.ph) * 0.5 + 0.5) * (0.25 + climb * 0.9);
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      const rr = b.r * (1 + halo());
      const img = opt.rainbow ? rbSprites[Math.floor(rbSweep(b.x, w, clk) / (360 / RBN)) % RBN] : sprite;
      ctx.drawImage(img, b.x - rr, b.y - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
  }
  const start = () => { if (STILL || raf || !opt.on || document.hidden) return; last = 0; raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  addEventListener('resize', () => { if (opt.on && c) size(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  return {
    set(o) {
      Object.assign(opt, o);
      if (!opt.on) { stop(); if (c) { c.remove(); c = null; ctx = null; } return; }
      if (!c) { c = canvas('fx-embers'); ctx = c.getContext('2d'); }
      buildSprite();
      size();
      start();
    },
  };
})();

// ------------------------------------------------------------------ starfield (+ meteors)
const STARS = (() => {
  let c = null, ctx = null, w = 0, h = 0, raf = 0, last = 0, clk = 0, field = [], meteors = [], nextMet = 0;
  const opt = { on: false, amount: 100, size: 100, speed: 100, twinkle: 100, bright: 100, warmth: 0, meteors: 2, metlen: 100, rainbow: false };
  const BASE = 0.00014, MAXSTARS = 2400, METGAP = [0, 90, 38, 16, 6];
  let STARCOL = '226,238,255';
  const starCol = () => { const k = M(opt.warmth); return [226 + 29 * k, 238 - 12 * k, 255 - 67 * k].map(Math.round).join(','); };
  function build() {
    field = [];
    for (let i = 0, n = Math.min(MAXSTARS, Math.round(w * h * BASE * M(opt.amount))); i < n; i++) {
      const d = Math.random();
      field.push({ x: Math.random() * w, y: Math.random() * h, r: (0.4 + d * 1.3) * M(opt.size), vx: -(2 + d * 9) * M(opt.speed),
        a: Math.min(1, (0.25 + d * 0.55) * M(opt.bright)), ph: Math.random() * 6.283, tw: (0.6 + Math.random() * 1.7) * M(opt.twinkle) });
    }
  }
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); fit(c, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }
  function meteor() {
    const fromTop = Math.random() < 0.75;
    return { x: Math.random() * w * 0.9 + w * 0.1, y: fromTop ? -20 : Math.random() * h * 0.4, vx: -(280 + Math.random() * 260), vy: 190 + Math.random() * 200,
      life: 0, max: 0.75 + Math.random() * 0.5, len: (90 + Math.random() * 110) * M(opt.metlen), hue: Math.random() * 360 };
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (last && ts - last < MIN_FRAME) return;
    const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0.016;
    last = ts;
    ctx.clearRect(0, 0, w, h);
    clk += dt;
    // one colour set once + alpha per star (no colour string per star per frame); tiny stars are squares, not arcs
    if (!opt.rainbow) ctx.fillStyle = `rgb(${STARCOL})`;
    for (const s of field) {
      s.x += s.vx * dt;
      if (s.x < -2) { s.x = w + 2; s.y = Math.random() * h; }
      s.ph += dt * s.tw;
      ctx.globalAlpha = s.a * (0.72 + 0.28 * Math.sin(s.ph));
      if (opt.rainbow) ctx.fillStyle = `hsl(${Math.round(rbSweep(s.x, w, clk))},100%,68%)`;
      if (s.r < 1.1) ctx.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
      else { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    if (opt.meteors > 0) {
      nextMet -= dt;
      if (nextMet <= 0) { meteors.push(meteor()); nextMet = METGAP[opt.meteors] * (0.45 + Math.random() * 1.1); }
    }
    for (let m = meteors.length - 1; m >= 0; m--) {
      const t2 = meteors[m];
      t2.life += dt; t2.x += t2.vx * dt; t2.y += t2.vy * dt;
      if (t2.life > t2.max || t2.y > h + 40 || t2.x < -140) { meteors.splice(m, 1); continue; }
      const k = Math.hypot(t2.vx, t2.vy) || 1, tx = t2.x - (t2.vx / k) * t2.len, ty = t2.y - (t2.vy / k) * t2.len, fade = 1 - t2.life / t2.max;
      const g = ctx.createLinearGradient(t2.x, t2.y, tx, ty);
      g.addColorStop(0, `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`);
      if (opt.rainbow) {
        for (let q = 1; q <= 5; q++) g.addColorStop(q / 5, `hsla(${Math.round(t2.hue + q * 60) % 360},100%,65%,${(0.7 * fade * (1 - q / 5)).toFixed(3)})`);
      } else {
        g.addColorStop(0.35, `rgba(190,215,255,${(0.35 * fade).toFixed(3)})`);
        g.addColorStop(1, 'rgba(160,190,255,0)');
      }
      ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(t2.x, t2.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${(0.95 * fade).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(t2.x, t2.y, 1.7, 0, 6.283); ctx.fill();
    }
  }
  const start = () => { if (STILL || raf || !opt.on || document.hidden) return; last = 0; nextMet = 2; raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  addEventListener('resize', () => { if (opt.on && c) size(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  return {
    set(o) {
      const sig = [opt.amount, opt.size, opt.speed, opt.twinkle, opt.bright].join(',');
      Object.assign(opt, o);
      if (!opt.on) { stop(); meteors = []; if (c) { c.remove(); c = null; ctx = null; } return; }
      STARCOL = starCol();
      if (!c) { c = canvas('fx-stars'); ctx = c.getContext('2d'); size(); }
      else if ([opt.amount, opt.size, opt.speed, opt.twinkle, opt.bright].join(',') !== sig) build();
      start();
    },
  };
})();

// ------------------------------------------------------------------ the knobs (the desk's table, same ranges)
export const FX_DEF = {
  snow: { pile: false, shovel: false, amount: 100, size: 100, speed: 100, sway: 100, bright: 100, depth: 30, rainbow: false },
  stars: { amount: 100, size: 100, speed: 100, twinkle: 100, bright: 100, warmth: 0, meteors: 2, metlen: 100, rainbow: false },
  embers: { amount: 100, size: 100, speed: 100, drift: 100, glow: 100, flicker: 100, bright: 100, heat: 50, rainbow: false },
};
export const FX_KNOBS = {
  snow: [
    { k: 'amount', n: 'Snowfall', lo: 5, hi: 400, st: 5 }, { k: 'size', n: 'Flake size', lo: 20, hi: 400, st: 5 },
    { k: 'speed', n: 'Fall speed', lo: 10, hi: 400, st: 5 }, { k: 'sway', n: 'Sway', lo: 0, hi: 400, st: 5 },
    { k: 'bright', n: 'Brightness', lo: 20, hi: 300, st: 5 }, { k: 'depth', n: 'Drift depth', lo: 0, hi: 100, st: 1, f: 'depth', pile: true },
  ],
  stars: [
    { k: 'amount', n: 'Stars', lo: 5, hi: 400, st: 5 }, { k: 'size', n: 'Star size', lo: 20, hi: 400, st: 5 },
    { k: 'speed', n: 'Drift speed', lo: 0, hi: 400, st: 5 }, { k: 'twinkle', n: 'Twinkle', lo: 0, hi: 400, st: 5 },
    { k: 'bright', n: 'Brightness', lo: 20, hi: 300, st: 5 }, { k: 'warmth', n: 'Warmth', lo: 0, hi: 100, st: 1, f: 'warm' },
    { k: 'meteors', n: 'Meteors', lo: 0, hi: 4, st: 1, f: 'met' }, { k: 'metlen', n: 'Meteor trail', lo: 20, hi: 300, st: 5 },
  ],
  embers: [
    { k: 'amount', n: 'Embers', lo: 5, hi: 400, st: 5 }, { k: 'size', n: 'Spark size', lo: 20, hi: 400, st: 5 },
    { k: 'speed', n: 'Rise speed', lo: 10, hi: 400, st: 5 }, { k: 'drift', n: 'Drift', lo: 0, hi: 400, st: 5 },
    { k: 'glow', n: 'Glow', lo: 0, hi: 400, st: 5 }, { k: 'flicker', n: 'Flicker', lo: 0, hi: 400, st: 5 },
    { k: 'bright', n: 'Brightness', lo: 20, hi: 300, st: 5 }, { k: 'heat', n: 'Heat', lo: 0, hi: 100, st: 1, f: 'heat' },
  ],
};
const MET = ['never', 'rare', 'now and then', 'often', 'a shower'];
const HEATN = ['coal', 'deep red', 'ember', 'amber', 'bright', 'white-hot'];
const WARMN = ['starlight', 'cool', 'neutral', 'warm', 'golden', 'candle'];
const DEPTHN = ['none', 'dusting', 'ankle', 'shin', 'knee', 'deep'];
const band = (names, v, hi) => names[Math.min(names.length - 1, Math.floor(v / (hi / names.length)))];
export function fmtKnob(s, v) {
  if (s.f === 'met') return MET[v] || '';
  if (s.f === 'heat') return band(HEATN, v, 101);
  if (s.f === 'warm') return band(WARMN, v, 101);
  if (s.f === 'depth') return `${band(DEPTHN, v, 101)} · ${v}%`;
  return `×${(v / 100).toFixed(2)}`;
}

// ------------------------------------------------------------------ the shovel (a mode: Esc or the pill puts it down)
let shovelOn = false, digging = false, shovelUi = null;
const DIG_ZONE = 190;
function shovelMode(on) {
  if (on === shovelOn) return;
  shovelOn = on;
  document.body.classList.toggle('shovel', on);
  if (on) {
    shovelUi = document.createElement('div');
    shovelUi.className = 'shovel-layer';
    const pill = document.createElement('button');
    pill.className = 'shovel-pill';
    pill.textContent = 'Put the shovel down (Esc)';
    pill.onclick = (e) => { e.stopPropagation(); putDown(); };
    shovelUi.append(pill);
    const inDrift = (e) => { const fy = SNOW.floorY(); return e.clientY <= fy + 6 && fy - e.clientY <= DIG_ZONE; };
    shovelUi.addEventListener('pointerdown', (e) => { if (inDrift(e)) { digging = true; SNOW.dig(e.clientX, 46); } });
    shovelUi.addEventListener('pointermove', (e) => { if (digging && inDrift(e)) SNOW.dig(e.clientX, 46); });
    document.body.append(shovelUi);
  } else if (shovelUi) { shovelUi.remove(); shovelUi = null; }
}
let onPutDown = null;
function putDown() { shovelMode(false); if (onPutDown) onPutDown(); }
addEventListener('pointerup', () => { digging = false; });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && shovelOn) putDown(); }, true);

// ------------------------------------------------------------------ the one entry point
let lastBack = null, lastZoom = null;
export function applyEffects(fx, putDownCb) {
  const z = zoomOf();
  if (lastZoom !== null && z !== lastZoom) dispatchEvent(new Event('resize'));   // Size changed: refit the canvases
  lastZoom = z;
  const type = (fx && fx.type) || 'off';
  MIN_FRAME = fx && +fx.fps === 60 ? 15.5 : 32.5;
  if (putDownCb) onPutDown = putDownCb;
  const back = !!(fx && fx.back);
  if (back !== lastBack) { document.body.classList.toggle('fx-back', back); lastBack = back; }
  const snow = { ...FX_DEF.snow, ...(fx?.snow || {}) };
  SNOW.set({ ...snow, on: type === 'snow' });
  STARS.set({ ...FX_DEF.stars, ...(fx?.stars || {}), on: type === 'stars' });
  EMBERS.set({ ...FX_DEF.embers, ...(fx?.embers || {}), on: type === 'embers' });
  shovelMode(type === 'snow' && snow.pile && snow.shovel);
}
export const clearSnow = () => SNOW.clear();
