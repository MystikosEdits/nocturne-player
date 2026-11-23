"""Windows taskbar hover buttons (previous / play-pause / next), like Spotify's (Grant, Nov 22: "when you hover over the
app in the taskbar on the bottom you can pause/play/skip/back i want that as well").

ITaskbarList3 thumbnail toolbar on the window's HWND, through raw ctypes COM (no comtypes dependency). Clicks arrive as
WM_COMMAND with HIWORD(wParam) == THBN_CLICKED; the window is subclassed (SetWindowSubclass) to catch them, and to
re-add the buttons when Explorer restarts ("TaskbarButtonCreated"). Every COM / window call runs on the window's UI
thread (WinForms BeginInvoke): the taskbar object is single-threaded COM.
"""
from __future__ import annotations

import ctypes
import logging
import threading
import uuid
from ctypes import wintypes

from . import config

log = logging.getLogger("tempo.thumbbar")

WM_COMMAND = 0x0111
WM_NCDESTROY = 0x0082
THBN_CLICKED = 0x1800
THB_ICON, THB_TOOLTIP, THB_FLAGS = 0x2, 0x4, 0x8
THBF_ENABLED = 0x0
IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
SM_CXSMICON = 49
IDS = {1: "prev", 2: "toggle", 3: "next"}

LRESULT = ctypes.c_ssize_t
SUBCLASSPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                  ctypes.c_size_t, ctypes.c_size_t)


class THUMBBUTTON(ctypes.Structure):
    _fields_ = [("dwMask", wintypes.DWORD), ("iId", wintypes.UINT), ("iBitmap", wintypes.UINT),
                ("hIcon", wintypes.HICON), ("szTip", wintypes.WCHAR * 260), ("dwFlags", wintypes.DWORD)]


def _guid(s: str):
    return (ctypes.c_ubyte * 16).from_buffer_copy(uuid.UUID(s).bytes_le)


CLSID_TaskbarList = _guid("56FDF344-FD6D-11d0-958A-006097C9A090")
IID_ITaskbarList3 = _guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF")

user32 = ctypes.windll.user32
comctl32 = ctypes.windll.comctl32
ole32 = ctypes.windll.ole32
comctl32.SetWindowSubclass.argtypes = [wintypes.HWND, SUBCLASSPROC, ctypes.c_size_t, ctypes.c_size_t]
comctl32.RemoveWindowSubclass.argtypes = [wintypes.HWND, SUBCLASSPROC, ctypes.c_size_t]
comctl32.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
comctl32.DefSubclassProc.restype = LRESULT
user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.LoadImageW.restype = wintypes.HANDLE
user32.RegisterWindowMessageW.restype = wintypes.UINT


class ThumbBar:
    def __init__(self, win, on_click):
        self.win = win                 # the pywebview window (its .native = the WinForms form)
        self.on_click = on_click       # called with "prev" / "toggle" / "next" (off the UI thread)
        self.playing = False
        self.hwnd = None
        self.tbl = None                # ITaskbarList3*
        self.added = False
        self.inited = False
        self.icons = {}
        self._proc = SUBCLASSPROC(self._wndproc)    # keep a reference: ctypes callbacks die with their object
        self.msg_created = user32.RegisterWindowMessageW("TaskbarButtonCreated")

    # ------------------------------------------------------------------ COM plumbing
    def _vcall(self, index, argtypes, *args):
        vtbl = ctypes.cast(self.tbl, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
        fn = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)(vtbl[index])
        return fn(self.tbl, *args)

    def _ui(self, fn):
        """Run fn on the window's UI thread, without waiting."""
        try:
            from System import Action
            self.win.native.BeginInvoke(Action(fn))
        except Exception as e:      # noqa: BLE001
            log.debug("thumbbar: no UI thread: %s", e)

    def _icon(self, name: str, size: int):
        key = (name, size)
        if key not in self.icons:
            path = str(config.ASSETS / "thumbbar" / f"{name}.ico")
            self.icons[key] = user32.LoadImageW(None, path, IMAGE_ICON, size, size, LR_LOADFROMFILE)
        return self.icons[key]

    def _buttons(self):
        try:
            dpi = user32.GetDpiForWindow(self.hwnd) or 96
            size = user32.GetSystemMetricsForDpi(SM_CXSMICON, dpi) or 16
        except Exception:           # noqa: BLE001
            size = 16
        spec = [(1, "prev", "Previous"), (2, "pause" if self.playing else "play", "Pause" if self.playing else "Play"),
                (3, "next", "Next")]
        arr = (THUMBBUTTON * 3)()
        for b, (i, ico, tip) in zip(arr, spec):
            b.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
            b.iId = i
            b.hIcon = self._icon(ico, size)
            b.szTip = tip
            b.dwFlags = THBF_ENABLED
        return arr

    def _add(self):
        """On the UI thread: create the taskbar object (once) and add / refresh the three buttons."""
        try:
            if not self.tbl:
                p = ctypes.c_void_p()
                hr = ole32.CoCreateInstance(ctypes.byref(CLSID_TaskbarList), None, 1, ctypes.byref(IID_ITaskbarList3), ctypes.byref(p))
                if hr != 0 or not p:
                    log.info("thumbbar: no ITaskbarList3 (hr=%#x)", hr & 0xFFFFFFFF)
                    return
                self.tbl = p
            if not self.inited:
                self._vcall(3, [])                                                          # HrInit (no taskbar yet = raises; retried later)
                self.inited = True
            arr = self._buttons()
            idx = 16 if self.added else 15                                                  # Update / Add
            hr = self._vcall(idx, [wintypes.HWND, wintypes.UINT, ctypes.c_void_p], self.hwnd, 3, ctypes.cast(arr, ctypes.c_void_p))
            if hr == 0:
                self.added = True
        except OSError as e:        # ctypes raises the HRESULT: no taskbar button yet -> TaskbarButtonCreated retries
            log.debug("thumbbar: not added yet: %s", e)
        except Exception as e:      # noqa: BLE001
            log.info("thumbbar: add failed: %s", e)

    # ------------------------------------------------------------------ window hook
    def _wndproc(self, hwnd, msg, wp, lp, uid, ref):
        try:
            if msg == WM_COMMAND and (wp >> 16) & 0xFFFF == THBN_CLICKED:
                action = IDS.get(wp & 0xFFFF)
                if action:
                    if action == "toggle":                  # flip the icon at once; the page confirms it a moment later
                        self.playing = not self.playing
                        self._add()
                    threading.Thread(target=self.on_click, args=(action,), daemon=True).start()
                    return 0
            elif msg == self.msg_created and hwnd == self.hwnd:     # Explorer (re)made our taskbar button
                self.added = False
                self._add()
            elif msg == WM_NCDESTROY:
                comctl32.RemoveWindowSubclass(hwnd, self._proc, 1)
        except Exception as e:      # noqa: BLE001
            log.debug("thumbbar wndproc: %s", e)
        return comctl32.DefSubclassProc(hwnd, msg, wp, lp)

    def install(self):
        """Hook the window and add the buttons (call after the window is shown). Re-hooks if WinForms recreates the
        window handle (it does when some form properties change)."""
        def go():
            try:
                h = self.win.native.Handle.ToInt64()
                if h == self.hwnd:
                    return
                self.hwnd = h
                self.added = False
                comctl32.SetWindowSubclass(h, self._proc, 1, 0)
                self._add()
            except Exception as e:  # noqa: BLE001
                log.info("thumbbar: install failed: %s", e)
        self._ui(go)
        try:
            self.win.native.HandleCreated += lambda s, e: self._ui(go)
        except Exception:           # noqa: BLE001
            pass

    def set_playing(self, playing: bool):
        playing = bool(playing)
        if playing == self.playing and self.added:
            return
        self.playing = playing
        if self.hwnd:
            self._ui(self._add)
