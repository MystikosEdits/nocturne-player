"""Nocturne's icon in any hue (Grant, Nov 22: "add hue control to the icon in settings").

settings.icon_hue = degrees 0..359 (0 = the original violet moon). The recolour is a pure HUE shift in HSV (saturation
and brightness kept), so every hue is as vivid as the original. Rendered once per hue into DATA/icon/h<hue>/ (512 png,
multi-size .ico, tray png, .icns) and applied everywhere the OS shows Nocturne:
  Windows  tray (engine), window + taskbar button (window process, JsApi.set_app_icon), Start menu + Desktop shortcuts
           (their icon = what the media panel and a pinned taskbar button show)
  macOS    Nocturne.app's icon in Finder / Dock / Launchpad (NSWorkspace custom icon), the running app's Dock icon
           (window process). The menu-bar icon is a monochrome template image: macOS draws it, no hue.
"""
from __future__ import annotations

import logging
import shutil
import sys
import threading
from pathlib import Path

from . import config

log = logging.getLogger("tempo.appicon")
DIR = config.DATA / "icon"
_lock = threading.Lock()
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def clamp(h) -> int:
    try:
        return int(round(float(h))) % 360
    except (TypeError, ValueError):
        return 0


def current() -> int:
    return clamp(config.Settings().get("icon_hue") or 0)


def _shift(img, hue: int):
    """Rotate the hue of an RGBA image by `hue` degrees (alpha and S/V untouched)."""
    from PIL import Image
    img = img.convert("RGBA")
    if not hue:
        return img
    a = img.getchannel("A")
    h, s, v = img.convert("RGB").convert("HSV").split()
    off = int(round(hue * 256 / 360)) % 256
    h = h.point(lambda x: (x + off) % 256)
    out = Image.merge("HSV", (h, s, v)).convert("RGB")
    out.putalpha(a)
    return out


def paths(hue: int | None = None) -> dict:
    """{png, ico, tray, icns} for a hue (rendered on first use); hue 0 = the shipped originals."""
    hue = current() if hue is None else clamp(hue)
    orig = {"png": config.ASSETS / "nocturne-512.png", "ico": config.ASSETS / "nocturne.ico",
            "tray": config.ASSETS / "nocturne-tray.png", "icns": config.ASSETS / "nocturne.icns"}
    if not hue:
        return orig
    d = DIR / f"h{hue}"
    out = {"png": d / "nocturne-512.png", "ico": d / "nocturne.ico", "tray": d / "nocturne-tray.png", "icns": d / "nocturne.icns"}
    with _lock:
        if not all(p.exists() for p in out.values()):
            from PIL import Image
            d.mkdir(parents=True, exist_ok=True)
            big = _shift(Image.open(orig["png"]), hue)
            big.save(out["png"])
            big.save(out["ico"], sizes=[(s, s) for s in ICO_SIZES])
            _shift(Image.open(orig["tray"]), hue).save(out["tray"])
            try:
                big.resize((1024, 1024), Image.LANCZOS).save(out["icns"])
            except Exception as e:      # noqa: BLE001
                log.info("no .icns for hue %s: %s", hue, e)
                shutil.copyfile(orig["icns"], out["icns"])
    return out


def base_hue() -> int:
    """The original icon's main hue (saturated pixels' average), so the UI can offer 'match my accent colour'."""
    from PIL import Image
    im = Image.open(config.ASSETS / "nocturne-512.png").convert("RGBA").resize((64, 64))
    import colorsys
    import math
    x = y = n = 0.0
    for r, g, b, a in im.getdata():
        if a < 128:
            continue
        hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if ss > 0.35 and vv > 0.25:
            w = ss * vv
            x += math.cos(hh * 2 * math.pi) * w
            y += math.sin(hh * 2 * math.pi) * w
            n += w
    if not n:
        return 270
    return int(round(math.degrees(math.atan2(y, x)))) % 360


def prune(keep: int):
    """Drop renders of hues no longer in use (each is ~2.5 MB) - but only ones older than 10 minutes: Explorer and the
    taskbar can still be drawing a hue picked a moment ago (deleting it at once = a blank icon, Grant Nov 22)."""
    import time
    keep = clamp(keep)
    for d in DIR.glob("h*"):
        try:
            if d.is_dir() and d.name != f"h{keep}" and time.time() - d.stat().st_mtime > 600:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ------------------------------------------------------------------ applying it (engine process)
def apply_engine(ctx, hue: int):
    """Tray + shortcuts (Windows) / the app bundle's icon (macOS). Runs in a worker thread."""
    p = paths(hue)
    if config.IS_WIN:
        try:
            if ctx and ctx.tray:
                from PIL import Image
                ctx.tray.icon = Image.open(p["tray"])
        except Exception as e:          # noqa: BLE001
            log.info("tray icon: %s", e)
        _shortcuts(p["ico"])
    elif config.IS_MAC:
        _mac_bundle(p["png"] if hue else None)


def _shortcuts(ico: Path):
    """Point Nocturne's Start menu + Desktop shortcuts at the recoloured .ico (only shortcuts that launch THIS run.py)."""
    try:
        import pythoncom
        from win32com.shell import shell, shellcon
        pythoncom.CoInitialize()
        run_py = str(config.ROOT / "run.py").lower()
        changed = []
        for folder in (shellcon.CSIDL_PROGRAMS, shellcon.CSIDL_DESKTOPDIRECTORY):
            lnk = Path(shell.SHGetFolderPath(0, folder, None, 0)) / f"{config.NAME}.lnk"
            if not lnk.exists():
                continue
            link = pythoncom.CoCreateInstance(shell.CLSID_ShellLink, None, pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink)
            pf = link.QueryInterface(pythoncom.IID_IPersistFile)
            pf.Load(str(lnk))
            if run_py not in (link.GetArguments() or "").lower():
                continue
            link.SetIconLocation(str(ico), 0)
            pf.Save(str(lnk), 0)
            changed.append(str(lnk))
        # refresh just these shortcuts (ASSOCCHANGED made Explorer redraw EVERY icon: the taskbar flickered)
        for path in changed:
            shell.SHChangeNotify(shellcon.SHCNE_UPDATEITEM, shellcon.SHCNF_PATHW, path, None)
    except Exception as e:              # noqa: BLE001
        log.info("shortcut icons: %s", e)


def _mac_bundle(png: Path | None):
    """Custom icon on Nocturne.app (None = back to its own). The bundle = the folder holding sys.executable."""
    try:
        exe = Path(sys.executable).resolve()
        app = next((q for q in exe.parents if q.suffix == ".app"), None)
        if not app:
            return
        import AppKit
        img = AppKit.NSImage.alloc().initWithContentsOfFile_(str(png)) if png else None
        AppKit.NSWorkspace.sharedWorkspace().setIcon_forFile_options_(img, str(app), 0)
    except Exception as e:              # noqa: BLE001
        log.info("mac bundle icon: %s", e)
