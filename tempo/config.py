"""Paths, settings and small helpers shared by every part of Tempo."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

APP = "Tempo"            # internal: data folder name (%APPDATA%\Tempo) - never rename, it holds sign-in/settings
NAME = "Nocturne"        # what Grant sees everywhere (picked Nov 20)
APP_ID = "Nocturne.MusicPlayer"   # Windows AppUserModelID: taskbar grouping + media flyout name
# TEMPO_PORT / TEMPO_DATA let a second, silent test copy run beside the real one
PORT = int(os.environ.get("TEMPO_PORT") or 8737)
HOST = "127.0.0.1"
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

ROOT = Path(__file__).resolve().parent.parent          # the tempo/ project folder
UI_DIR = ROOT / "ui"
ASSETS = ROOT / "assets"
BIN = ROOT / "bin"

if os.environ.get("TEMPO_DATA"):
    DATA = Path(os.environ["TEMPO_DATA"])
elif IS_WIN:
    DATA = Path(os.environ.get("APPDATA", Path.home())) / APP
elif IS_MAC:
    DATA = Path.home() / "Library" / "Application Support" / APP
else:
    DATA = Path.home() / ".local" / "share" / APP

AUTH_DIR = DATA / "auth"
CACHE = DATA / "cache"
OFFLINE = DATA / "offline"
LOGS = DATA / "logs"
BACKGROUNDS = DATA / "backgrounds"
VERSIONS_FILE = DATA / "versions.json"
PL_VERSIONS_FILE = DATA / "playlist_versions.json"
for _d in (DATA, AUTH_DIR, CACHE, OFFLINE, LOGS, BACKGROUNDS, CACHE / "api"):
    _d.mkdir(parents=True, exist_ok=True)

YT_AUTH = AUTH_DIR / "browser.json"       # ytmusicapi browser auth
YT_COOKIES = AUTH_DIR / "cookies.txt"     # same cookies for yt-dlp (Netscape format)
SPOTIFY_FILE = AUTH_DIR / "spotify.json"
SETTINGS_FILE = DATA / "settings.json"
STATE_FILE = DATA / "state.json"
OFFLINE_INDEX = OFFLINE / "index.json"


def mpv_path() -> Path:
    if os.environ.get("TEMPO_MPV"):      # tests: try another mpv build without touching bin/
        return Path(os.environ["TEMPO_MPV"])
    if IS_WIN:
        return BIN / "mpv" / "mpv.exe"
    if IS_MAC:
        return BIN / "mpv.app" / "Contents" / "MacOS" / "mpv"
    return Path("mpv")


def ipc_path(suffix: str = "") -> str:
    if IS_WIN:
        return r"\\.\pipe\tempo-mpv" + suffix + ("" if PORT == 8737 else f"-{PORT}")
    return str(DATA / f"mpv{suffix}.sock")


def venv_bin() -> Path:
    return Path(sys.executable).resolve().parent if not IS_MAC else Path(sys.executable).parent


DEFAULTS = {
    "quality": "best",            # best | normal
    "normalize": False,           # even out loudness between songs
    "autoplay": True,             # keep playing similar songs when the queue ends
    "log_history": True,          # count plays in YouTube Music history (teaches recommendations)
    "keep_playing_on_close": True,
    "start_at_login": False,
    "volume": 70,
    "window": None,               # {x, y, w, h}
    "country": "US",
    "eq": {"on": False, "preset": "Flat", "bands": [0] * 10, "preamp": 0},
    # effects on every song (a song's own saved version still wins)
    "global_fx": {"on": False, "fx": {"speed": 0.85, "reverb": 55, "bass": 2, "muffle": 0, "keep_pitch": False}},
    # iPhone-style background sounds, played by a second little player
    "sidebar": {"pinned": [], "folders": []},   # playlist pins + folders (Nocturne only; YouTube has neither)
    "bg_sound": {"on": False, "mix": {"rain_roof": 100}, "volume": 40, "with_music": 25, "stop_with_music": False, "stop_with_sleep": True},
    "theme": None,                # appearance (the UI owns its shape; stored here so it survives)
}


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


_write_lock = threading.Lock()


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with _write_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)


class Settings:
    def __init__(self):
        self.data = dict(DEFAULTS)
        self.data.update(read_json(SETTINGS_FILE, {}) or {})

    def get(self, key):
        return self.data.get(key, DEFAULTS.get(key))

    def update(self, changes: dict):
        for k, v in changes.items():
            if k in DEFAULTS:
                self.data[k] = v
        write_json(SETTINGS_FILE, self.data)
        return self.data
