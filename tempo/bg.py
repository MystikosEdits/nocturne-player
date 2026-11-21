"""Background sounds: a mixer of real-sounding loops (rain, thunder, ocean, fire, crickets, cafe, train, noise...).

Each sound playing is its own tiny mpv (`Mpv(name="-bg-<id>")`, ~13 MB): up to MAX_LAYERS at once, each with its own
level, all under one master volume. The loops come from tools/make_ambience.py (assets/sounds/sounds.json lists them,
with a per-sound `gain_db` for the one the limiter left quiet). They keep going while music is paused, duck (or stop)
while music plays, and can fade out with the sleep timer. A sound switched off = its process shut down."""
from __future__ import annotations

import asyncio
import json
import logging

from . import config
from .player import Mpv

log = logging.getLogger("tempo.bg")
MAX_LAYERS = 4
LEGACY = {"rain": "rain_roof"}          # ids before Nov 20 evening


def _catalog() -> list[dict]:
    try:
        return json.loads((config.ASSETS / "sounds" / "sounds.json").read_text("utf-8"))
    except Exception as e:      # noqa: BLE001
        log.warning("no sounds.json: %s", e)
        return []


SOUNDS_FULL = _catalog()
_BY_ID = {s["id"]: s for s in SOUNDS_FULL}

# ready-made mixes for the panel (id -> level)
PRESETS = [
    {"name": "Rainy cabin", "mix": {"rain_window": 80, "fire": 55, "wind": 30}},
    {"name": "Stormy night", "mix": {"thunder": 85, "rain_roof": 45}},
    {"name": "Beach at night", "mix": {"ocean": 85, "night": 30}},
    {"name": "Forest morning", "mix": {"birds": 75, "stream": 50}},
    {"name": "Winter cabin", "mix": {"snowstorm": 70, "fire": 60}},
    {"name": "Study café", "mix": {"cafe": 80, "rain_window": 35}},
    {"name": "Night train", "mix": {"train": 85, "rain_window": 30}},
    {"name": "Deep focus", "mix": {"dark": 70}},
]


class Background:
    def __init__(self, engine):
        self.e = engine
        self.players: dict[str, Mpv] = {}
        self._lock = asyncio.Lock()
        self._fading = False

    # ------------------------------------------------------------------ state
    def state(self) -> dict:
        st = dict(config.DEFAULTS["bg_sound"])
        st.update(self.e.settings.get("bg_sound") or {})
        mix = st.get("mix")
        if not isinstance(mix, dict) or not mix:
            old = LEGACY.get(st.get("sound"), st.get("sound")) or "rain_roof"
            mix = {old: 100}
        mix = {k: max(0, min(100, int(v))) for k, v in mix.items() if k in _BY_ID}
        if not mix and SOUNDS_FULL:
            mix = {SOUNDS_FULL[0]["id"]: 100}
        st["mix"] = mix
        st["sound"] = next(iter(st["mix"]), "")          # the first one, for the settings row
        return st

    def _music_playing(self) -> bool:
        return bool(self.e.loaded and not self.e.paused)

    def _vol(self, st: dict, sid: str, music: bool) -> float:
        master = st["with_music"] if music else st["volume"]
        return round(master * st["mix"].get(sid, 0) / 100, 1)

    # ------------------------------------------------------------------ players
    async def _start(self, sid: str, vol: float) -> Mpv:
        gain = float(_BY_ID[sid].get("gain_db") or 0)
        args = ["--loop-playlist=inf", "--audio-buffer=0.5"]
        if gain:
            args.append(f"--af=lavfi=[volume={gain}dB]")
        mpv = Mpv(lambda n, d, s=sid: self._on_event(s, n, d), silent=self.e.mpv.silent, name=f"-bg-{sid}",
                  client_name="Nocturne background sounds", extra_args=args)
        await mpv.start(int(round(vol)))
        path = str(config.ASSETS / "sounds" / _BY_ID[sid]["file"])
        # two copies of the loop on repeat = mpv hands over gaplessly, no click at the loop point
        await mpv.loadfile(path, "replace")
        await mpv.loadfile(path, "append")
        return mpv

    async def apply(self):
        """Bring the players in line with the settings and whether music is playing."""
        if self._fading:
            return
        async with self._lock:
            st = self.state()
            music = self._music_playing()
            want = st["on"] and not (st["stop_with_music"] and music)
            wanted = {k for k, v in st["mix"].items() if v > 0} if st["on"] else set()
            # sounds taken out of the mix (or everything, when off): free their memory entirely
            for sid in [s for s in self.players if s not in wanted]:
                await self.players.pop(sid).shutdown()
            for sid in wanted:
                p = self.players.get(sid)
                if p is None or not p.connected:
                    if not want:
                        continue
                    try:
                        p = self.players[sid] = await self._start(sid, self._vol(st, sid, music))
                    except Exception as e:      # noqa: BLE001
                        log.warning("background sound %s failed to start: %s", sid, e)
                        self.players.pop(sid, None)
                        continue
                await p.set("volume", self._vol(st, sid, music))
                await p.set("pause", not want)          # paused = just waiting for the music to stop

    def _on_event(self, sid: str, name, data):
        if name == "mpv-lost":
            self.players.pop(sid, None)
            if self.state()["on"]:
                self.e.loop.create_task(self.apply())

    # ------------------------------------------------------------------ API
    async def set(self, patch: dict) -> dict:
        st = self.state()
        for k in ("on", "volume", "with_music", "stop_with_music", "stop_with_sleep"):
            if k in patch:
                st[k] = patch[k]
        mix = dict(st["mix"])
        if isinstance(patch.get("mix"), dict):          # a whole mix (a preset)
            mix = {k: v for k, v in patch["mix"].items() if k in _BY_ID}
        if "sound" in patch:                            # one tile: on / off (older UI: replace)
            sid = LEGACY.get(patch["sound"], patch["sound"])
            if sid in _BY_ID:
                if patch.get("toggle"):
                    if sid in mix and len(mix) > 1:
                        mix.pop(sid)
                    elif sid not in mix:
                        mix[sid] = 70
                        while len(mix) > MAX_LAYERS:
                            mix.pop(next(iter(mix)))    # the oldest layer makes room
                else:
                    mix = {sid: 100}
        if isinstance(patch.get("level"), dict):         # {"id": level}
            for k, v in patch["level"].items():
                if k in mix:
                    mix[k] = max(0, min(100, int(v)))
        st["mix"] = {k: max(0, min(100, int(v))) for k, v in mix.items()} or {"rain_roof": 100}
        st["volume"] = max(0, min(100, int(st["volume"])))
        st["with_music"] = max(0, min(100, int(st["with_music"])))
        st.pop("sound", None)
        self.e.settings.update({"bg_sound": st})
        await self.apply()
        self.e.emit()
        return self.state()

    async def sleep_fired(self):
        """Sleep timer ran out: fade the sounds away too (if that's what the setting says)."""
        st = self.state()
        if not (st["on"] and st["stop_with_sleep"] and self.players):
            return
        self._fading = True
        try:
            music = self._music_playing()
            start = {sid: self._vol(st, sid, music) for sid in self.players}
            for k in range(20):
                for sid, p in list(self.players.items()):
                    if p.connected:
                        await p.set("volume", start.get(sid, 0) * (1 - (k + 1) / 20))
                await asyncio.sleep(0.4)
        finally:
            self._fading = False
        await self.set({"on": False})

    async def stop(self):
        for p in list(self.players.values()):
            await p.shutdown()
        self.players.clear()
