"""Read EVERY song of a public Spotify playlist or album, beyond the embed page's 100.

Spotify's embed page (spotify.read_public) only carries the first 100 songs. The normal public page
open.spotify.com/playlist/<id>, opened in a real browser engine WITHOUT signing in and scrolled, lazy-loads
every row (measured Nov 21: 500/500, 152/152; albums too: a 150-song album's embed also stops at 100).
This module is that browser, reading the rows the way a person scrolling the page would: a HEADLESS Chromium
browser that's already installed, driven over its local DevTools port. Windows = Microsoft Edge (on every Windows
10/11), else Chrome/Brave; macOS = Chrome / Edge / Brave / Chromium. No window exists at all, so nothing can appear
or take focus. No such browser = no full read (the first 100 + the Ctrl+A song-links route still work).
Dead ends (Nov 21): a pywebview/WebView2 window off-screen + out of the taskbar + disabled still became the
FOREGROUND window in Grant's session while WebView2 started (= steals focus, e.g. from a game); a hidden pywebview
WKWebView on the Mac loaded the page but never rendered the song rows.

It runs as its OWN short-lived process (`python -m tempo.spotify_full <playlist|album> <id> [total] [timeout]`),
started by the engine:
- a hang inside the browser can never freeze the Nocturne window or the engine (the engine just kills it),
- it works with the Nocturne window closed,
- all its memory is gone the moment it's done (Edge is in a job object: it dies with this process).
It prints one JSON object per line on stdout: {"progress": n, "total": N} ... then {"result": {...}} or {"error": "..."}.

Nothing is signed in (its own browser profile in DATA/cache/spotify-headless), no API, no token: only the rendered
page is read.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time

# the rows Spotify has rendered right now (it's a virtual list: only ~30-60 exist at a time)
COLLECT_JS = r"""(() => {
  const out = [];
  const txt = el => ((el && (el.textContent || el.innerText)) || '').trim();
  // ONLY the list's own grid: under a playlist Spotify adds a "Recommended" grid whose rows are numbered 1..10 too
  const grid = document.querySelector(GRID);
  const rows = grid ? grid.querySelectorAll('[data-testid="tracklist-row"]') : [];
  const rowcount = grid ? parseInt(grid.getAttribute('aria-rowcount') || '0', 10) : 0;   // songs + the header row
  for (const r of rows) {
    // position: the "#" cell, else the grid row number (row 1 = the header)
    let idx = txt(r.querySelector('[aria-colindex="1"]')).replace(/\D+/g, '');
    if (!idx) {
      const ri = (r.closest('[aria-rowindex]') || r).getAttribute('aria-rowindex');
      if (ri) idx = String(parseInt(ri, 10) - 1);
    }
    // songs "unavailable" in this country have no link, just their name: keep them (often on YouTube anyway)
    const t = r.querySelector('a[href*="/track/"]') || r.querySelector('[aria-colindex="2"] [dir="auto"]');
    if (!idx || !t || !txt(t)) continue;
    const href = t.getAttribute('href') || '';
    const m = href.match(/track\/([A-Za-z0-9]{22})/);
    const artists = [...r.querySelectorAll('a[href*="/artist/"]')].map(txt).filter(Boolean);
    const al = r.querySelector('a[href*="/album/"]');
    let dur = '';
    for (const c of r.querySelectorAll('[aria-colindex]')) {
      const s = txt(c);
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) dur = s;
    }
    out.push([idx, txt(t), m ? m[1] : null, [...new Set(artists)], txt(al), dur]);
  }
  if (rows.length) rows[rows.length - 1].scrollIntoView({block: 'start'});
  return JSON.stringify({rows: out, rendered: rows.length, title: grid ? (grid.getAttribute('aria-label') || '') : '',
                         size: rowcount > 0 ? rowcount - 1 : 0,
                         sample: (rows.length && !out.length) ? rows[0].outerHTML.slice(0, 2500) : undefined,
                         ready: document.readyState, blocked: !!document.querySelector('[data-testid="error-page"]')});
})()"""


def _ms(dur: str) -> int:
    try:
        parts = [int(p) for p in dur.split(":")]
    except ValueError:
        return 0
    s = 0
    for p in parts:
        s = s * 60 + p
    return s * 1000


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


GRIDS = {"playlist": '[data-testid="playlist-tracklist"]', "album": '[data-testid="track-list"]'}


def scroll_collect(evaluate, kind: str, total: int, timeout: float, t0: float) -> dict:
    """The shared loop: evaluate(js) -> JSON text from the page. Scroll, collect, stop at the end. Raises on failure."""
    collect = COLLECT_JS.replace("GRID", json.dumps(GRIDS[kind]))
    seen: dict[int, list] = {}
    title = ""
    stall, last_say, d = 0, 0.0, {}
    t_load = time.time()
    say({"loaded": round(t_load - t0, 1)})
    while time.time() - t0 < timeout:
        try:
            raw = evaluate(collect)
        except Exception as e:   # noqa: BLE001  (bridge not ready yet / page navigating)
            if time.time() - t0 > timeout * 0.8:
                raise
            say({"note": str(e)[:120]})
            time.sleep(1)
            continue
        d = json.loads(raw) if isinstance(raw, str) else (raw or {})
        if d.get("blocked"):
            raise RuntimeError("Spotify didn't show that " + kind)
        title = d.get("title") or title
        if d.get("size"):          # the page's own count (grid aria-rowcount - header)
            total = int(d["size"])
        if d.get("sample") and not seen and stall == 3:
            say({"note": "rows not understood", "sample": d["sample"]})
        before = len(seen)
        for idx, name, sid, artists, album, dur in d.get("rows") or []:
            if idx.isdigit():
                k = int(idx)
                if k not in seen or (sid and not seen[k][1]):   # a linked row beats a name-only one
                    seen[k] = [name, sid, artists, album or (title if kind == "album" else ""), dur]
        stall = stall + 1 if len(seen) == before else 0
        if total and len(seen) >= total:
            break
        if seen and stall >= 9:       # no new row for ~6 s: the end (or Spotify stopped giving rows)
            break
        if not seen and time.time() - t_load > 45:
            raise RuntimeError("Spotify's page never showed any songs")
        if time.time() - last_say > 0.5:
            say({"progress": len(seen), "total": total, "rendered": d.get("rendered")})
            last_say = time.time()
        time.sleep(0.6)
    say({"progress": len(seen), "total": total, "rendered": d.get("rendered")})
    rows = [{"sid": v[1], "name": v[0], "artists": v[2], "album": v[3], "ms": _ms(v[4]), "n": k}
            for k, v in sorted(seen.items())]
    return {"title": title, "rows": rows, "total": total, "seconds": round(time.time() - t0, 1),
            "complete": bool(total) and len(rows) >= total, "loaded_after": round(t_load - t0, 1),
            "timed_out": time.time() - t0 >= timeout}


def _watchdog(timeout: float, cleanup=None):
    def run():   # browser calls can block forever: never outlive the deadline (the engine kills us at +30 s)
        time.sleep(timeout + 15)
        say({"error": "timed out"})
        if cleanup:
            try:
                cleanup()
            except Exception:   # noqa: BLE001
                pass
        os._exit(3)
    threading.Thread(target=run, daemon=True).start()


# ---------------- headless Chromium (Edge / Chrome / Brave) over the DevTools protocol: no window at all
def find_browser() -> str | None:
    if os.environ.get("TEMPO_FULL_READ_BROWSER"):            # tests
        b = os.environ["TEMPO_FULL_READ_BROWSER"]
        return None if b == "none" else b
    if sys.platform == "win32":
        rel = [("Microsoft", "Edge", "Application", "msedge.exe"), ("Google", "Chrome", "Application", "chrome.exe"),
               ("BraveSoftware", "Brave-Browser", "Application", "brave.exe")]
        bases = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        for r in rel:
            for base in bases:
                if base and os.path.isfile(os.path.join(base, *r)):
                    return os.path.join(base, *r)
    elif sys.platform == "darwin":
        for app, exe in (("Google Chrome", "Google Chrome"), ("Microsoft Edge", "Microsoft Edge"),
                         ("Brave Browser", "Brave Browser"), ("Chromium", "Chromium")):
            for root in ("/Applications", os.path.expanduser("~/Applications")):
                path = f"{root}/{app}.app/Contents/MacOS/{exe}"
                if os.path.isfile(path):
                    return path
    return None


find_edge = find_browser   # old name


def _job_kill_on_close(proc):
    """Put the Edge process tree in a job object that dies with THIS process (timeout, crash or kill)."""
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        k32.OpenProcess.restype = ctypes.c_void_p
        job = k32.CreateJobObjectW(None, None)

        class LIMIT(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32),
                        ("SchedulingClass", ctypes.c_uint32)]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class EXT(ctypes.Structure):
            _fields_ = [("Basic", LIMIT), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]
        info = EXT()
        info.Basic.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(ctypes.c_void_p(job), 9, ctypes.byref(info), ctypes.sizeof(info))
        h = k32.OpenProcess(0x1F0FFF, False, proc.pid)
        k32.AssignProcessToJobObject(ctypes.c_void_p(job), ctypes.c_void_p(h))
        return job   # keep the handle open for as long as this process lives
    except Exception as e:   # noqa: BLE001
        say({"note": f"job object: {e}"[:120]})
        return None


def read_headless(browser: str, kind: str, pid: str, total: int, timeout: float) -> dict:
    import asyncio
    import subprocess
    import urllib.request

    import aiohttp

    import signal

    t0 = time.time()
    profile = _profile_dir("spotify-headless")
    port_file = profile / "DevToolsActivePort"
    try:
        port_file.unlink()
    except OSError:
        pass
    args = [browser, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
            "--mute-audio", "--window-size=1200,1600", "--lang=en-US"]
    kw = {}
    if sys.platform == "win32":
        kw["creationflags"] = 0x08000000   # CREATE_NO_WINDOW
    else:
        # macOS: never touch the login keychain (that could pop a password prompt); own process group = killable
        args += ["--use-mock-keychain", "--password-store=basic"]
        kw["start_new_session"] = True
    proc = subprocess.Popen(args + ["about:blank"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, **kw)

    def kill_tree():
        if sys.platform == "win32":
            proc.kill()      # + the job object below takes the children
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:   # noqa: BLE001
                proc.kill()
    _watchdog(timeout, kill_tree)
    job = _job_kill_on_close(proc) if sys.platform == "win32" else None   # noqa: F841  (held open on purpose)
    try:
        while not port_file.exists() or len(port_file.read_text().split()) < 2:
            if proc.poll() is not None:
                raise RuntimeError("the browser didn't start")
            if time.time() - t0 > 60:
                raise RuntimeError("the browser didn't start in time")
            time.sleep(0.2)
        port = port_file.read_text().split()[0]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as r:
            pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("the browser has no page")
        ws_url = pages[0]["webSocketDebuggerUrl"]
        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, daemon=True).start()
        state = {"n": 0, "ws": None, "session": None}

        async def connect():
            state["session"] = aiohttp.ClientSession()
            state["ws"] = await state["session"].ws_connect(ws_url, max_msg_size=0)

        async def cmd(method, **params):
            state["n"] += 1
            n = state["n"]
            await state["ws"].send_json({"id": n, "method": method, "params": params})
            while True:
                msg = await state["ws"].receive_json(timeout=30)
                if msg.get("id") == n:
                    if "error" in msg:
                        raise RuntimeError(str(msg["error"])[:200])
                    return msg.get("result") or {}

        def run(coro, wait=40):
            return asyncio.run_coroutine_threadsafe(coro, loop).result(wait)

        run(connect())
        run(cmd("Page.navigate", url=f"https://open.spotify.com/{kind}/{pid}"))
        # wait for the list to exist (or give up after 90 s: a slow first start)
        probe = "!!document.querySelector(" + json.dumps(GRIDS[kind]) + ") || !!document.querySelector('[data-testid=\"error-page\"]')"
        while True:
            r = run(cmd("Runtime.evaluate", expression=probe, returnByValue=True))
            if (r.get("result") or {}).get("value"):
                break
            if time.time() - t0 > min(90, timeout * 0.6):
                break   # scroll_collect reports "never showed any songs"
            time.sleep(0.4)
        time.sleep(0.8)

        def evaluate(js):
            r = run(cmd("Runtime.evaluate", expression=js, returnByValue=True))
            if r.get("exceptionDetails"):
                raise RuntimeError(str(r["exceptionDetails"].get("text"))[:120])
            return (r.get("result") or {}).get("value")

        res = scroll_collect(evaluate, kind, total, timeout, t0)
        try:
            run(cmd("Browser.close"), wait=5)
        except Exception:   # noqa: BLE001
            pass
        try:
            run(state["session"].close(), wait=5)
        except Exception:   # noqa: BLE001
            pass
        return res
    finally:
        try:
            proc.wait(timeout=5)
        except Exception:   # noqa: BLE001
            kill_tree()


def read(kind: str, pid: str, total: int = 0, timeout: float = 240) -> None:
    browser = find_browser()
    if not browser:
        # no web-view window instead, on purpose: WebView2 took the foreground even off-screen + disabled (Windows),
        # and a hidden WKWebView never rendered the rows (macOS, Nov 21)
        say({"error": "no Edge/Chrome/Brave to read it with"})
        os._exit(0)
    try:
        say({"result": read_headless(browser, kind, pid, total, timeout)})
    except Exception as e:   # noqa: BLE001
        say({"error": str(e)[:300]})
    os._exit(0)


def _profile_dir(name: str):
    try:
        from tempo import config
        d = config.CACHE / name
    except Exception:   # noqa: BLE001
        from pathlib import Path
        d = Path(tempfile.gettempdir()) / ("nocturne-" + name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def main(argv):
    if len(argv) < 2 or argv[0] not in GRIDS:
        say({"error": "usage: python -m tempo.spotify_full <playlist|album> <id> [total] [timeout]"})
        return 2
    kind, pid = argv[0], argv[1]
    total = int(argv[2]) if len(argv) > 2 else 0
    timeout = float(argv[3]) if len(argv) > 3 else 240
    read(kind, pid, total, timeout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
