"""The background process: engine + local server + tray/menu-bar icon. Keeps playing when the window is closed."""
from __future__ import annotations

import asyncio
import logging
import logging.handlers
import os
import subprocess
import sys
import threading
import time

from . import config

VERSION = "1.0"
log = logging.getLogger("tempo")


def setup_logging():
    h = logging.handlers.RotatingFileHandler(config.LOGS / "engine.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


class AppContext:
    def __init__(self, silent: bool = False):
        from .engine import Engine
        from .offline import Offline
        from .spotify import Spotify
        self.version = VERSION
        self.engine = Engine(silent=silent)
        self.offline = Offline(self.engine)
        self.engine.offline = self.offline
        self.spotify = Spotify(self.engine)
        self.window_queues: set = set()   # event streams opened by a Tempo window (?shell=1)
        self.window_launched = 0.0
        self.window_ping = 0.0            # last ping from a window process
        self._show_pending = False
        self.loop: asyncio.AbstractEventLoop | None = None
        self.tray = None
        self.menu_helper = None           # macOS: the native menu-bar helper process (mac/menu)
        self._runner = None
        self._stopping = False

    def window_alive(self) -> bool:
        # a window process pinged in the last few seconds (it does every 1.5 s), or one is starting now.
        # Not the page's event stream: a closed window's stream can linger ~15 s and fake "open".
        now = time.time()
        return now - self.window_ping < 5 or now - self.window_launched < 10

    def take_show(self) -> bool:
        v, self._show_pending = self._show_pending, False
        return v

    def show_window(self):
        self._show_pending = True          # the window process picks this up within 1.5 s
        msg = b"event: show\ndata: {}\n\n"
        for q in list(self.window_queues):
            try:
                q.put_nowait(msg)
            except Exception:
                pass

    # ---------------- memory (shown in Settings so it's easy to check Tempo stays light)
    def memory_report(self) -> dict:
        out = {"engine": _rss(os.getpid()), "player": _rss(self.engine.mpv.proc.pid) if self.engine.mpv.proc else None}
        return out

    # ---------------- start at login
    def set_start_at_login(self, on: bool):
        try:
            if config.IS_WIN:
                _win_startup(on)
            elif config.IS_MAC:
                _mac_login_item(on)
        except Exception as e:
            log.warning("start at login change failed: %s", e)

    # ---------------- run
    async def serve(self):
        from aiohttp import web
        from .server import make_app
        from . import media
        self.loop = asyncio.get_running_loop()
        await self.engine.start()
        self.engine.media = media.create(self.engine)
        app = make_app(self)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, config.HOST, config.PORT)
        await site.start()
        log.info("%s engine up on %s:%s", config.NAME, config.HOST, config.PORT)
        self.engine.on_track_change.append(self._tray_title)
        self.engine.on_repeated_failures = lambda: self.loop.run_in_executor(None, update_components, True)
        self.loop.call_later(120, lambda: self.loop.run_in_executor(None, update_components))
        while not self._stopping:
            await asyncio.sleep(0.5)
        await self.engine.stop()
        if self.engine.media:
            self.engine.media.close()
        await self._runner.cleanup()

    def quit(self):
        self._stopping = True
        stop_menu_helper(self)
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass

    def _tray_title(self, t):
        if self.tray:
            try:
                self.tray.title = f"{t['title']} — {t.get('artist') or ''}"[:120]
            except Exception:
                pass

    def call(self, coro_fn):
        if self.loop:
            self.loop.call_soon_threadsafe(lambda: self.loop.create_task(coro_fn()))

    def open_window(self):
        if time.time() - self.window_ping < 5:
            self.loop.call_soon_threadsafe(self.show_window)
            return
        if time.time() - self.window_launched < 10:
            return  # one is already starting
        self.window_launched = time.time()
        launch_window()


UPDATE_STAMP = config.DATA / "last_update.txt"


def update_components(force: bool = False) -> bool:
    """YouTube changes things every few weeks and yt-dlp ships fixes just as often: keep yt-dlp +
    ytmusicapi current in the background (no window). Takes effect on the next engine start."""
    try:
        last = float(UPDATE_STAMP.read_text().strip()) if UPDATE_STAMP.exists() else 0
    except Exception:
        last = 0
    if not force and time.time() - last < 4 * 86400:
        return False
    if force and time.time() - last < 3600:
        return False
    UPDATE_STAMP.write_text(str(time.time()))
    pkgs = ["yt-dlp[default]", "yt-dlp-ejs", "ytmusicapi"]
    if config.IS_MAC:
        uv = os.path.expanduser("~/.local/bin/uv")
        venv_py = str(config.ROOT / ".venv" / "bin" / "python")
        cmd = [uv, "pip", "install", "--python", venv_py, "-U", *pkgs]
    else:
        py = sys.executable.replace("pythonw.exe", "python.exe")
        cmd = [py, "-m", "pip", "install", "-U", "--quiet", "--disable-pip-version-check", *pkgs]
    kw = {"creationflags": 0x08000000} if config.IS_WIN else {}
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=600, **kw)
        log.info("component update (%s): rc=%s %s", "forced" if force else "scheduled", res.returncode,
                 (res.stdout + res.stderr).strip()[-400:])
        return res.returncode == 0
    except Exception as e:
        log.warning("component update failed: %s", e)
        return False


def _rss(pid) -> int | None:
    """Resident memory in MB."""
    try:
        if config.IS_WIN:
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]
            h = ctypes.windll.kernel32.OpenProcess(0x1000 | 0x0400, False, pid)
            if not h:
                return None
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
            ctypes.windll.kernel32.CloseHandle(h)
            return round(pmc.PrivateUsage / 1048576)
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=3).stdout.strip()
        return round(int(out) / 1024) if out else None
    except Exception:
        return None


def python_gui() -> str:
    """pythonw on Windows (no console window, ever)."""
    exe = sys.executable
    if config.IS_WIN and exe.lower().endswith("python.exe"):
        w = exe[:-10] + "pythonw.exe"
        if os.path.exists(w):
            return w
    return exe


def launch_window():
    run = str(config.ROOT / "run.py")
    if config.IS_WIN:
        subprocess.Popen([python_gui(), run, "--window"], creationflags=0x08000000 | 0x00000008,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    elif config.IS_MAC:
        app = config.ROOT / "Nocturne.app"
        if app.exists():
            subprocess.Popen(["open", str(app)])
        else:
            subprocess.Popen([sys.executable, run, "--window"], start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _win_startup(on: bool):
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
    try:
        if on:
            for old in ("Tempo",):   # name before the rename
                try:
                    winreg.DeleteValue(key, old)
                except FileNotFoundError:
                    pass
            winreg.SetValueEx(key, config.NAME, 0, winreg.REG_SZ, f'"{python_gui()}" "{config.ROOT / "run.py"}" --background')
        else:
            try:
                winreg.DeleteValue(key, config.NAME)
            except FileNotFoundError:
                pass
    finally:
        winreg.CloseKey(key)


def _mac_login_item(on: bool):
    plist = os.path.expanduser("~/Library/LaunchAgents/com.tempo.engine.plist")
    if on:
        content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.tempo.engine</string>
<key>ProgramArguments</key><array><string>{sys.executable}</string><string>{config.ROOT / 'run.py'}</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key><dict><key>MallocLargeCache</key><string>0</string></dict>
</dict></plist>"""
        with open(plist, "w") as f:
            f.write(content)
    else:
        try:
            os.unlink(plist)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------- macOS menu-bar helper
def menu_helper_path():
    """The native helper built by mac/build.sh: inside Nocturne.app (install_mac.sh puts it there), else
    the build folder of this checkout. None = not built (no Command Line Tools) -> plain pystray icon."""
    exe = "NocturneMenu.app/Contents/MacOS/NocturneMenu"
    for p in (config.ROOT / "Nocturne.app" / "Contents" / "Helpers" / exe, config.ROOT / "mac" / "build" / exe):
        if p.exists():
            return p
    return None


def start_menu_helper(ctx: AppContext) -> bool:
    """macOS: the menu-bar icon is a small Swift app (click = now-playing panel, right-click = menu,
    optional desktop player). It quits by itself when this engine process ends."""
    if not config.IS_MAC or os.environ.get("TEMPO_NO_MENU_HELPER"):
        return False
    exe = menu_helper_path()
    if not exe:
        return False
    app_path = config.ROOT / "Nocturne.app"
    args = [str(exe), "--port", str(config.PORT), "--engine-pid", str(os.getpid())]
    if app_path.exists():
        args += ["--app", str(app_path)]
    try:
        err = open(config.LOGS / "menu.log", "ab")
        ctx.menu_helper = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=err, stderr=err, close_fds=True)
        log.info("menu-bar helper started (pid %s)", ctx.menu_helper.pid)
        return True
    except Exception as e:
        log.warning("menu-bar helper didn't start: %s", e)
        ctx.menu_helper = None
        return False


def stop_menu_helper(ctx: AppContext):
    p, ctx.menu_helper = ctx.menu_helper, None
    if p and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass


def keep_menu_helper(ctx: AppContext, icon):
    """Runs in pystray's setup thread: the pystray icon stays hidden while the helper lives; a helper
    that keeps dying (3 times in 2 minutes) hands the menu bar back to the plain pystray icon."""
    deaths = []
    while not ctx._stopping:
        p = ctx.menu_helper
        if p is None:
            break
        rc = p.wait()
        if ctx._stopping or ctx.menu_helper is not p:
            return
        now = time.time()
        deaths = [t for t in deaths if now - t < 120] + [now]
        log.warning("menu-bar helper exited (rc %s)", rc)
        if len(deaths) >= 3 or not start_menu_helper(ctx):
            break
        time.sleep(1)
    if not ctx._stopping:
        log.warning("menu-bar helper gave up: showing the plain menu-bar icon")
        ctx.menu_helper = None
        icon.visible = True


# ---------------------------------------------------------------- tray icon
def make_tray(ctx: AppContext):
    import pystray
    from PIL import Image
    icon_file = config.ASSETS / ("nocturne-tray-mac.png" if config.IS_MAC else "nocturne-tray.png")
    img = Image.open(icon_file)

    def act(fn):
        return lambda icon, item: fn()

    e = ctx.engine
    menu = pystray.Menu(
        pystray.MenuItem(f"Open {config.NAME}", act(ctx.open_window), default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(lambda item: "Pause" if not e.paused else "Play", act(lambda: ctx.call(e.toggle))),
        pystray.MenuItem("Next", act(lambda: ctx.call(e.next))),
        pystray.MenuItem("Previous", act(lambda: ctx.call(e.prev))),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(f"Quit {config.NAME}", act(ctx.quit)),
    )
    icon = pystray.Icon(config.NAME, img, config.NAME, menu)
    if config.IS_MAC:
        try:
            from AppKit import NSApplication
            NSApplication.sharedApplication().setActivationPolicy_(1)  # accessory: menu bar only, no Dock icon
        except Exception:
            pass
    return icon


def main(silent: bool = False):
    setup_logging()
    os.environ["PATH"] = str(config.venv_bin()) + os.pathsep + os.environ.get("PATH", "")
    if config.IS_WIN:
        try:
            import ctypes
            # same id as the Start menu shortcut -> media flyout says "Tempo" with its icon
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(config.APP_ID)
        except Exception:
            pass
    ctx = AppContext(silent=silent)

    def run_loop():
        try:
            asyncio.run(ctx.serve())
        except Exception:
            log.exception("engine crashed")
        finally:
            ctx._stopping = True
            stop_menu_helper(ctx)
            if ctx.tray:
                try:
                    ctx.tray.stop()
                except Exception:
                    pass

    t = threading.Thread(target=run_loop, name="tempo-engine", daemon=True)
    t.start()
    try:
        ctx.tray = make_tray(ctx)
    except Exception as e:
        log.warning("no tray icon: %s", e)
        ctx.tray = None
    if ctx.tray:
        if config.IS_MAC and start_menu_helper(ctx):
            # the native helper owns the menu bar; pystray's (hidden) icon still runs the main run loop,
            # which macOS Now Playing needs
            try:
                ctx.tray._status_item.button().setHidden_(True)   # pystray makes its item up front
            except Exception:
                pass
            ctx.tray.run(setup=lambda icon: keep_menu_helper(ctx, icon))
        else:
            ctx.tray.run()  # on macOS this needs the main thread; it also drives Now Playing
    else:
        while t.is_alive():
            t.join(1)
    ctx._stopping = True
    stop_menu_helper(ctx)
    t.join(5)
    os._exit(0)
