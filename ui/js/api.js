// Talking to the Tempo engine.
// the engine itself not answering (restarting after an update, or quit): say so instead of "Failed to fetch"
const DOWN = "Can't reach Nocturne's player right now (it may be restarting). Try again in a moment.";
const req = (path, opts) => fetch(path, opts).catch(() => { throw new Error(DOWN); });

export async function get(path) {
  const r = await req(path, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

export async function post(path, body = {}) {
  const r = await req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tempo': '1' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { error: text }; }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

export const cmd = (action, value) => post('/api/cmd', { action, value });

export function listen(handlers) {
  // EventSource reconnects by itself (the engine sends `retry: 1500`); JS timers would get
  // throttled while the window is in the background, so don't roll our own reconnect loop.
  const shell = new URLSearchParams(location.search).get('shell') ? '?shell=1' : '';
  let es = null;
  let timer = null;
  let lastMsg = performance.now();
  const connect = () => {
    clearTimeout(timer);
    if (es) es.close();
    lastMsg = performance.now();
    es = new EventSource('/api/events' + shell);
    es.addEventListener('ping', () => { lastMsg = performance.now(); });
    for (const [name, fn] of Object.entries(handlers)) {
      if (name === 'offline' || name === 'online') continue;
      es.addEventListener(name, (e) => { lastMsg = performance.now(); try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    es.onopen = () => { lastMsg = performance.now(); handlers.online && handlers.online(); };
    es.onerror = () => {
      handlers.offline && handlers.offline();
      // Chromium gives up for good if the engine was fully down during its retry
      if (es.readyState === EventSource.CLOSED) timer = setTimeout(connect, 2000);
    };
  };
  // the engine sends something at least every 15 s; silence for 40 s = a dead or frozen stream
  const revive = () => {
    if (!es || es.readyState === EventSource.CLOSED || performance.now() - lastMsg > 40000) connect();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) revive(); });
  window.addEventListener('focus', revive);
  setInterval(revive, 15000);
  window.__tempoReconnect = connect;
  connect();
}

// small in-memory cache so going back is instant
const cache = new Map();
export async function cached(path, ttl = 60000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await get(path);
  cache.set(path, { t: Date.now(), v });
  return v;
}
export function dropCache(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
