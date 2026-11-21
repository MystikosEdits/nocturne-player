"""The Tempo window: a native window (WebView2 on Windows, WebKit on macOS) showing the UI the engine serves.
Closing it frees its memory; the music keeps playing in the background engine."""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
import webbrowser

import webview

from . import config

BG = "#0b0b0e"
URL = f"http://{config.HOST}:{config.PORT}/"


def api(path, data=None, timeout=30):
    req = urllib.request.Request(URL.rstrip("/") + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json", "X-Tempo": "1"},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class JsApi:
    """Things the UI can't do from inside the page."""

    def __init__(self):
        self._window = None  # private: pywebview walks every PUBLIC attribute of this object on each page load (a window reference = the whole WinForms tree = "Not responding")
        self._signin = None
        self._pre_mini = None   # the window's frame / minimum size before the mini player (private, same reason)
        self._keeper = None     # winscale.DpiKeeper (Windows), private for the same reason

    def mini(self, on, w=440, h=136, dpr=1):
        """Mini player: shrink the window to a small always-on-top player, or put it back exactly where it was.
        Native calls on the UI thread (BeginInvoke / callAfter): pywebview's own resize() waits on that thread."""
        win = self._window
        if not win:
            return False
        try:
            if config.IS_WIN:
                from System import Action
                from System.Drawing import Size
                from System.Windows.Forms import FormWindowState
                form = win.native

                def go():
                    if self._keeper:
                        self._keeper.hold()      # this size change is ours, not a move to another monitor
                    if on:
                        if self._pre_mini is None:
                            self._pre_mini = (form.Bounds, form.MinimumSize, form.WindowState)
                        form.WindowState = FormWindowState.Normal
                        form.MinimumSize = Size(int(300 * dpr), int(90 * dpr))
                        cw, ch = int(round(w * dpr)), int(round(h * dpr))
                        form.ClientSize = Size(cw, ch)
                        # WinForms sizes the title bar for 96 DPI: on a 125% monitor the client came out 8 px short
                        # (and its ClientSize getter repeats the mistake): measure the real client area with Win32
                        import ctypes
                        from ctypes import wintypes
                        rc = wintypes.RECT()
                        ctypes.windll.user32.GetClientRect(ctypes.c_void_p(form.Handle.ToInt64()), ctypes.byref(rc))
                        if rc.right != cw or rc.bottom != ch:
                            form.Size = Size(form.Size.Width + cw - rc.right, form.Size.Height + ch - rc.bottom)
                        form.TopMost = True
                    else:
                        form.TopMost = False
                        if self._pre_mini:
                            bounds, min_size, state = self._pre_mini
                            self._pre_mini = None
                            form.MinimumSize = min_size
                            form.Bounds = bounds
                            form.WindowState = state
                form.BeginInvoke(Action(go))
            elif config.IS_MAC:
                from PyObjCTools import AppHelper
                import AppKit

                def go_mac():
                    nw = win.native
                    if on:
                        if self._pre_mini is None:
                            self._pre_mini = (nw.frame(), nw.minSize())
                        nw.setMinSize_((300, 90))
                        nw.setContentSize_((w, h))
                        nw.setLevel_(AppKit.NSFloatingWindowLevel)
                    else:
                        nw.setLevel_(AppKit.NSNormalWindowLevel)
                        if self._pre_mini:
                            frame, min_size = self._pre_mini
                            self._pre_mini = None
                            nw.setMinSize_(min_size)
                            nw.setFrame_display_(frame, True)
                AppHelper.callAfter(go_mac)
            return True
        except Exception as e:      # noqa: BLE001
            return {"error": str(e)}

    def platform(self):
        return "mac" if config.IS_MAC else "win"

    def bring_to_front(self):
        """Called by the page when the engine says 'show' (tray icon / launching Tempo again)."""
        if self._window:
            _bring_to_front(self._window)
        return True

    def open_external(self, url):
        if url.startswith("https://") or url.startswith("http://127.0.0.1"):
            webbrowser.open(url)
        return True

    def sign_in_google(self):
        """Open a Google sign-in window; when it lands on YouTube Music signed in, hand the cookies to the engine."""
        if self._signin:
            return {"error": "already open"}
        url = ("https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true"
               "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop"
               "%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F")
        x, y = None, None
        try:
            x = self._window.x + 120
            y = self._window.y + 60
        except Exception:
            pass
        w = webview.create_window("Sign in to YouTube Music", url, width=500, height=720, x=x, y=y,
                                  background_color="#ffffff")
        self._signin = w
        done = {"closed": False}
        w.events.closed += lambda: done.__setitem__("closed", True)
        result = {"error": "Sign-in window was closed"}
        deadline = time.time() + 900
        while time.time() < deadline and not done["closed"]:
            time.sleep(1.0)
            try:
                cur = w.get_current_url() or ""
            except Exception:
                continue
            if "music.youtube.com" not in cur and "www.youtube.com" not in cur:
                continue
            try:
                raw = w.get_cookies()
            except Exception:
                continue
            cookies = []
            for c in raw or []:
                for name, m in c.items():
                    cookies.append({"name": name, "value": m.value, "domain": m["domain"]})
            if any(c["name"] in ("SAPISID", "__Secure-3PAPISID") for c in cookies):
                try:
                    res = api("/api/auth/youtube/cookies", {"cookies": cookies})
                    result = {"ok": True, "account": res.get("account")}
                except urllib.error.HTTPError as e:
                    try:
                        result = json.loads(e.read())
                    except Exception:
                        result = {"error": f"sign-in failed ({e.code})"}
                except Exception as e:
                    result = {"error": str(e)[:200]}
                break
        try:
            w.destroy()
        except Exception:
            pass
        self._signin = None
        return result


def _style_windows(win):
    """Dark native title bar that matches the app background."""
    try:
        import ctypes
        hwnd = win.native.Handle.ToInt32()
        dwm = ctypes.windll.dwmapi

        def setattr_(attr, val):
            v = ctypes.c_int(val)
            dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), 4)
        setattr_(20, 1)                # immersive dark mode
        r, g, b = int(BG[1:3], 16), int(BG[3:5], 16), int(BG[5:7], 16)
        setattr_(35, r | (g << 8) | (b << 16))          # caption colour
        setattr_(36, 0x00D8D8DC)                         # caption text colour
        setattr_(34, 0x002A2A2E)                         # border colour
    except Exception:
        pass


def _style_mac(win):
    try:
        from PyObjCTools import AppHelper

        def go():
            import AppKit
            w = win.native
            # transparent title bar in the app's colour (not full-size content: the web view would swallow window drags)
            w.setTitlebarAppearsTransparent_(True)
            w.setTitleVisibility_(1)                       # hidden title text
            w.setAppearance_(AppKit.NSAppearance.appearanceNamed_("NSAppearanceNameDarkAqua"))
            w.setBackgroundColor_(AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(11 / 255, 11 / 255, 14 / 255, 1))
            try:
                w.contentView().superview().subviews().lastObject().setBackgroundColor_(AppKit.NSColor.clearColor())
            except Exception:
                pass
            icon = config.ASSETS / "nocturne.icns"
            if icon.exists():
                img = AppKit.NSImage.alloc().initWithContentsOfFile_(str(icon))
                AppKit.NSApplication.sharedApplication().setApplicationIconImage_(img)
        AppHelper.callAfter(go)
    except Exception:
        pass


def _bring_to_front(win):
    # plain OS calls only: pywebview's restore()/show() wait on the UI thread and could hang the caller
    if config.IS_WIN:
        try:
            import ctypes
            hwnd = win.native.Handle.ToInt32()
            u = ctypes.windll.user32
            u.ShowWindow(hwnd, 9 if u.IsIconic(hwnd) else 5)   # SW_RESTORE / SW_SHOW
            # Windows only lets a background app take focus while ALT is "pressed"
            u.keybd_event(0x12, 0, 0, 0)
            u.SetForegroundWindow(hwnd)
            u.keybd_event(0x12, 0, 2, 0)
        except Exception:
            pass
    elif config.IS_MAC:
        try:
            from PyObjCTools import AppHelper
            import AppKit
            AppHelper.callAfter(lambda: (AppKit.NSApplication.sharedApplication().activateIgnoringOtherApps_(True),
                                         win.native.makeKeyAndOrderFront_(None)))
        except Exception:
            pass


def main():
    settings = config.Settings()
    geo = settings.get("window") or {}
    if config.IS_WIN:
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(config.APP_ID)
        except Exception:
            pass
    if config.IS_MAC:
        try:
            from Foundation import NSBundle
            info = NSBundle.mainBundle().localizedInfoDictionary() or NSBundle.mainBundle().infoDictionary()
            if info is not None:
                info["CFBundleName"] = config.NAME
        except Exception:
            pass

    js = JsApi()
    screen = None
    min_size = (960, 640)
    plan = None
    if config.IS_WIN:
        # Sharp on every monitor (was: blurry, bitmap-stretched on the 125% laptop panel) - see tempo/winscale.py
        from . import winscale
        winscale.enable_per_monitor()
        try:
            plan = winscale.plan(geo, winscale.monitors())
        except Exception:       # noqa: BLE001
            plan = None
    if plan:
        # Opens on the MAIN monitor (Grant, Nov 20: "it should open on main monitor"), fully inside it, never bigger.
        # pywebview multiplies x/y/w/h by the scale of the monitor the window is created on (the main one).
        s_ = plan["scale"]
        w, h, x, y = plan["w_log"], plan["h_log"], plan["x"] / s_, plan["y"] / s_
        min_size = plan["min"]
    else:
        w = int(geo.get("w") or 1280)
        h = int(geo.get("h") or 820)
        x = geo.get("x")
        y = geo.get("y")
        try:
            screens = list(webview.screens)
        except Exception:
            screens = []
        # Keep the last position only if it was on the main monitor; otherwise centre it there. Never bigger than it.
        main = next((s for s in screens if (s.x, s.y) == (0, 0)), screens[0] if screens else None)
        on_main = main is not None and x is not None and y is not None and \
            main.x <= x + 60 < main.x + main.width and main.y <= y + 16 < main.y + main.height
        if main:
            w = min(w, main.width - 40)
            h = min(h, main.height - 60)
            min_size = (min(960, w), min(640, h))
        if not on_main:
            x = y = None
            screen = main
    os_name = "mac" if config.IS_MAC else "win"
    # --quiet (used when an update reopens the window): start minimised and never take focus, so it can't pull Grant
    # out of a game (Nov 21: "its really fucking annoying that im trying to play a game and you are opening random
    # terminals and it tabs me out")
    import sys as _sys
    quiet = "--quiet" in _sys.argv
    win = webview.create_window(config.NAME, f"{URL}?shell=1&os={os_name}", js_api=js, width=w, height=h, x=x, y=y,
                                screen=screen, min_size=min_size, background_color=BG, text_select=False,
                                minimized=quiet, focus=not quiet)
    js._window = win
    state = {"closing": False, "hwnd": None}

    def remember_geometry():
        try:
            if js._pre_mini is not None:     # never remember the mini player's size
                return
            if config.IS_WIN and state["hwnd"]:
                from . import winscale
                g = winscale.geometry_to_save(state["hwnd"])
            elif win.width and win.height and win.width > 500:
                g = {"x": win.x, "y": win.y, "w": win.width, "h": win.height}
            else:
                g = None
            if g:
                config.Settings().update({"window": g})
        except Exception:
            pass

    def keep_scale():
        # per-monitor DPI: fix the opening rect if Windows put the window on another monitor first, then keep its
        # logical size when it's dragged between monitors with different scaling (WinForms doesn't)
        from . import winscale
        form = win.native
        hwnd = form.Handle.ToInt64()
        state["hwnd"] = hwnd
        if plan and not winscale.u.IsIconic(winscale.W.HWND(hwnd)):     # --quiet starts minimised: leave it alone
            l, t, r, b = winscale.window_rect(hwnd)
            if abs(l - plan["x"]) > 4 or abs(t - plan["y"]) > 4 or abs(r - l - plan["w"]) > 4 or abs(b - t - plan["h"]) > 4:
                import ctypes
                ctypes.windll.user32.SetWindowPos(ctypes.c_void_p(hwnd), None, plan["x"], plan["y"], plan["w"], plan["h"], 0x0014)
        keeper = winscale.DpiKeeper(form, hwnd, mini_min=lambda: (300, 90) if js._pre_mini is not None else None)
        js._keeper = keeper
        form.Move += keeper.check
        form.Resize += keeper.check

    def on_shown():
        if config.IS_WIN:
            _style_windows(win)
            try:
                keep_scale()
            except Exception:
                pass
        elif config.IS_MAC:
            _style_mac(win)

    def on_closing():
        state["closing"] = True
        remember_geometry()

    def on_closed():
        try:
            api("/api/window/closed", {}, timeout=2)
        except Exception:
            pass
        os._exit(0)

    win.events.shown += on_shown
    win.events.closing += on_closing
    win.events.closed += on_closed

    def watch_engine():
        # Runs in this (never-frozen) process: tells the engine a window is open, brings the window
        # forward when asked (tray / launching Tempo again), and reloads the page if the engine
        # restarted (a minimized window's page can be frozen and miss the reconnect).
        last_pid, fails = None, 0
        me = os.getpid()
        while not state["closing"]:
            time.sleep(1.5)
            try:
                res = api(f"/api/ping?window={me}", timeout=3)
                pid = res.get("pid")
                if res.get("show"):
                    _bring_to_front(win)
            except Exception:
                fails += 1
                continue
            if last_pid is not None and (pid != last_pid or fails >= 2):
                try:
                    win.load_url(f"{URL}?shell=1&os={os_name}")
                except Exception:
                    pass
            last_pid, fails = pid, 0

    def started():
        threading.Thread(target=watch_engine, daemon=True, name="tempo-watch").start()
        if config.IS_MAC:
            _style_mac(win)

    icon = config.ASSETS / ("nocturne.ico" if config.IS_WIN else "nocturne.png")
    webview.start(started, private_mode=False, storage_path=str(config.DATA / "webview"),
                  icon=str(icon) if icon.exists() else None, debug=os.environ.get("TEMPO_DEBUG") == "1")
