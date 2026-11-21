"""Windows: the Nocturne window on monitors with different scaling (Nov 21, Grant: "fix all of the sizing issues with
scaling on different monitors and window sizes").

Before: pywebview makes the process "system DPI aware" (SetProcessDPIAware). On Grant's laptop the system DPI is the
main monitor's (100%), so on the 125% laptop panel Windows bitmap-stretched the whole window: blurry text and icons.

Now: the window process is per-monitor DPI aware (v2), so WebView2 renders sharp at each monitor's own scale
(devicePixelRatio 1.25 on the panel). WinForms (.NET Framework, no app.config) does NOT resize the window when it
crosses to a monitor with another scale (measured: no DpiChanged event, size kept in physical pixels, so the app
would lose 20% of its room on the panel and the 960x640 minimum would shrink to 768x512). `DpiKeeper` does that resize
itself, keeping the window's size in logical pixels the same, like a normal Windows app.

Units: every rect here is PHYSICAL pixels (that's what a per-monitor-aware process sees). Saved window size is
LOGICAL (physical / scale), saved position physical ("v": 2 in settings.window).
"""
from __future__ import annotations

import ctypes
import time
from ctypes import wintypes as W

MIN_W, MIN_H = 960, 640          # logical; shrunk only if a monitor's work area is smaller than that
DEFAULT_W, DEFAULT_H = 1280, 820

u = ctypes.windll.user32
u.GetDpiForWindow.argtypes = [W.HWND]
u.GetDpiForWindow.restype = W.UINT
u.MonitorFromWindow.argtypes = [W.HWND, W.DWORD]
u.MonitorFromWindow.restype = W.HMONITOR
u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
u.IsIconic.argtypes = [W.HWND]
u.IsZoomed.argtypes = [W.HWND]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("rcMonitor", W.RECT), ("rcWork", W.RECT), ("dwFlags", W.DWORD)]


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", W.UINT), ("flags", W.UINT), ("showCmd", W.UINT), ("ptMinPosition", W.POINT),
                ("ptMaxPosition", W.POINT), ("rcNormalPosition", W.RECT)]


def enable_per_monitor() -> bool:
    """Call before any window exists. pywebview's later SetProcessDPIAware() then fails quietly (already set)."""
    try:
        u.SetProcessDpiAwarenessContext.argtypes = [W.HANDLE]
        u.SetProcessDpiAwarenessContext.restype = W.BOOL
        return bool(u.SetProcessDpiAwarenessContext(W.HANDLE(-4)))     # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    except Exception:       # noqa: BLE001  (Windows < 10 1703)
        return False


def _rect(r):
    return (r.left, r.top, r.right, r.bottom)


def _monitor_info(hmon):
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(mi)
    u.GetMonitorInfoW(hmon, ctypes.byref(mi))
    dx, dy = W.UINT(96), W.UINT(96)
    try:
        ctypes.windll.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy))
    except Exception:       # noqa: BLE001
        pass
    return {"rect": _rect(mi.rcMonitor), "work": _rect(mi.rcWork), "scale": (dx.value or 96) / 96,
            "primary": bool(mi.dwFlags & 1)}


def monitors() -> list[dict]:
    out = []
    proc = ctypes.WINFUNCTYPE(W.BOOL, W.HMONITOR, W.HDC, ctypes.POINTER(W.RECT), W.LPARAM)

    def cb(h, hdc, rc, lp):
        out.append(_monitor_info(h))
        return True
    u.EnumDisplayMonitors(None, None, proc(cb), 0)
    return out


def main_monitor(mons):
    return next((m for m in mons if m["primary"]), None) or next((m for m in mons if m["rect"][:2] == (0, 0)), None) \
        or (mons[0] if mons else {"rect": (0, 0, 1920, 1080), "work": (0, 0, 1920, 1040), "scale": 1.0, "primary": True})


def min_size_for(work, scale):
    """The 960x640 minimum, in logical px, but never bigger than the monitor's work area (a 1366x768 screen at 150%
    has only 910x512 logical pixels)."""
    ww, wh = (work[2] - work[0]) / scale, (work[3] - work[1]) / scale
    return int(min(MIN_W, ww - 16)), int(min(MIN_H, wh - 16))


def plan(geo: dict, mons: list[dict]) -> dict:
    """Where and how big the window opens: always on the MAIN monitor (Grant, Nov 20), the saved size if it fits there
    (else shrunk to fit), the saved position if it was on the main monitor (pulled fully inside its work area), else
    centred. Returns physical x/y/w/h + the main monitor's scale + the logical minimum."""
    m = main_monitor(mons)
    s, work, rect = m["scale"], m["work"], m["rect"]
    min_w, min_h = min_size_for(work, s)
    ww, wh = work[2] - work[0], work[3] - work[1]
    w_log = int(geo.get("w") or DEFAULT_W)
    h_log = int(geo.get("h") or DEFAULT_H)
    # never bigger than the screen it opens on (16 px of air), never smaller than the minimum
    w_log = max(min_w, min(w_log, int(ww / s) - 16))
    h_log = max(min_h, min(h_log, int(wh / s) - 16))
    pw, ph = round(w_log * s), round(h_log * s)
    x, y = geo.get("x"), geo.get("y")
    on_main = x is not None and y is not None and rect[0] <= x + 60 < rect[2] and rect[1] <= y + 16 < rect[3]
    if on_main:
        x = max(work[0], min(int(x), work[2] - pw))
        y = max(work[1], min(int(y), work[3] - ph))
    else:
        x = work[0] + (ww - pw) // 2
        y = work[1] + (wh - ph) // 2
    return {"x": x, "y": y, "w": pw, "h": ph, "scale": s, "w_log": w_log, "h_log": h_log, "min": (min_w, min_h)}


def window_rect(hwnd):
    r = W.RECT()
    u.GetWindowRect(W.HWND(hwnd), ctypes.byref(r))
    return _rect(r)


def normal_rect(hwnd):
    """The window's normal (not minimized / maximized) rect, physical."""
    h = W.HWND(hwnd)
    if u.IsIconic(h) or u.IsZoomed(h):
        wp = WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(wp)
        if u.GetWindowPlacement(h, ctypes.byref(wp)):
            return _rect(wp.rcNormalPosition)   # workspace coords = screen coords with the taskbar at the bottom
    return window_rect(hwnd)


def dpi_of(hwnd) -> int:
    return u.GetDpiForWindow(W.HWND(hwnd)) or 96


def geometry_to_save(hwnd) -> dict | None:
    l, t, r, b = normal_rect(hwnd)
    if r - l < 50 or l <= -30000:
        return None
    s = dpi_of(hwnd) / 96
    return {"x": l, "y": t, "w": round((r - l) / s), "h": round((b - t) / s), "v": 2}


class DpiKeeper:
    """Keeps the window's LOGICAL size when it moves to a monitor with another scale (see the module docstring).
    Its handlers are hooked straight onto the WinForms Form's Move / Resize events, so they run on the UI thread."""

    def __init__(self, form, hwnd, mini_min=lambda: None):
        self.form, self.hwnd = form, hwnd
        self.mini_min = mini_min            # () -> (w, h) logical minimum while the mini player is on, else None
        self.dpi = dpi_of(hwnd)
        l, t, r, b = normal_rect(hwnd)       # (normal_rect: a window that starts minimised has a 160x28 rect)
        self.log = ((r - l) * 96 / self.dpi, (b - t) * 96 / self.dpi)
        self.skip_until = 0.0
        self.busy = False
        self.log_lines = []

    def hold(self, seconds=1.0):
        """The mini player is changing the size itself: don't treat that as a monitor change."""
        self.skip_until = time.time() + seconds

    def _min_physical(self, dpi):
        hmon = u.MonitorFromWindow(W.HWND(self.hwnd), 2)
        work = _monitor_info(hmon)["work"]
        mm = self.mini_min()
        lw, lh = mm if mm else min_size_for(work, dpi / 96)
        return round(lw * dpi / 96), round(lh * dpi / 96), work

    def check(self, *_):
        if self.busy:
            return
        try:
            from System.Drawing import Size
            from System.Windows.Forms import FormWindowState
            dpi = dpi_of(self.hwnd)
            l, t, r, b = window_rect(self.hwnd)
            normal = self.form.WindowState == FormWindowState.Normal
            if dpi == self.dpi or time.time() < self.skip_until:
                if normal and r - l > 0:
                    self.log = ((r - l) * 96 / dpi, (b - t) * 96 / dpi)
                self.dpi = dpi
                return
            old, self.dpi = self.dpi, dpi
            self.busy = True
            mw, mh, work = self._min_physical(dpi)
            if not normal:      # maximized: Windows sizes it; only the minimum needs the new scale
                self.form.MinimumSize = Size(mw, mh)
                return
            tw = round(self.log[0] * dpi / 96)
            th = round(self.log[1] * dpi / 96)
            tw = min(tw, work[2] - work[0])
            th = min(th, work[3] - work[1])
            if dpi < old:       # shrinking: lower the minimum first, or WinForms clamps the new size to the old one
                self.form.MinimumSize = Size(mw, mh)
                self.form.Size = Size(tw, th)
            else:
                self.form.Size = Size(tw, th)
                self.form.MinimumSize = Size(mw, mh)
            self.log_lines.append(f"dpi {old}->{dpi}: {r - l}x{b - t} -> {tw}x{th}, min {mw}x{mh}")
        except Exception as e:      # noqa: BLE001
            self.log_lines.append(f"error {e!r}")
        finally:
            self.busy = False
