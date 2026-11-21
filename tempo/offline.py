"""Offline downloads: keep songs on disk so they play without internet (and start instantly)."""
from __future__ import annotations

import asyncio
import logging
import time
import urllib.request
from pathlib import Path

from . import config

log = logging.getLogger("tempo.offline")


class Offline:
    def __init__(self, engine):
        self.engine = engine
        self.index: dict[str, dict] = config.read_json(config.OFFLINE_INDEX, {}) or {}
        self.queue: list[dict] = []
        self.active: dict | None = None
        self.progress = 0.0
        self.failed: list[str] = []
        self._worker: asyncio.Task | None = None
        # drop entries whose file vanished
        for vid in list(self.index):
            if not self.path_for(vid):
                self.index.pop(vid, None)

    def path_for(self, vid: str) -> Path | None:
        e = self.index.get(vid)
        if not e:
            return None
        p = config.OFFLINE / e["file"]
        return p if p.exists() else None

    def has(self, vid: str) -> bool:
        return vid in self.index

    def list(self) -> list[dict]:
        out = []
        for vid, e in sorted(self.index.items(), key=lambda kv: -kv[1].get("added", 0)):
            t = dict(e.get("track") or {"id": vid, "title": vid})
            t["size"] = e.get("size")
            out.append(t)
        return out

    def status(self) -> dict:
        size = sum(e.get("size") or 0 for e in self.index.values())
        return {"count": len(self.index), "bytes": size, "queued": len(self.queue),
                "active": self.active and {"id": self.active["id"], "title": self.active["title"], "progress": round(self.progress, 2)},
                "ids": list(self.index.keys())}

    def add(self, tracks: list[dict]):
        known = {t["id"] for t in self.queue} | set(self.index) | ({self.active["id"]} if self.active else set())
        new = [t for t in tracks if t.get("id") and t["id"] not in known]
        self.queue.extend(new)
        if new:
            self.engine.toast(f"Downloading {len(new)} song{'s' if len(new) != 1 else ''}")
        if not self._worker or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._run())
        self._emit()

    def remove(self, ids: list[str]):
        for vid in ids:
            e = self.index.pop(vid, None)
            if e:
                try:
                    (config.OFFLINE / e["file"]).unlink()
                except FileNotFoundError:
                    pass
        self.queue = [t for t in self.queue if t["id"] not in ids]
        config.write_json(config.OFFLINE_INDEX, self.index)
        self._emit()

    def _emit(self):
        self.engine.emit("downloads", self.status())

    async def _run(self):
        while self.queue:
            t = self.queue.pop(0)
            self.active = t
            self.progress = 0.0
            self._emit()
            try:
                await self.engine.run_blocking(self._download, t)
            except Exception as e:
                log.warning("download failed %s: %s", t["id"], e)
                self.failed.append(t["id"])
            self.active = None
            self._emit()
        self.engine.toast("Downloads finished")

    def _download(self, t: dict):
        src = self.engine.yt.resolve(t["id"])
        ext = "m4a" if src.get("format") in ("140", "141") or (src.get("codec") or "").startswith("mp4a") else "webm"
        name = f"{t['id']}.{ext}"
        dest = config.OFFLINE / name
        tmp = dest.with_suffix(".part")
        headers = {k: v for k, v in (src.get("headers") or {}).items() if k.lower() in ("user-agent", "accept", "accept-language")}
        total = None
        got = 0
        chunk = 1024 * 1024
        last_emit = 0.0
        with open(tmp, "wb") as f:
            while True:
                req = urllib.request.Request(src["url"], headers={**headers, "Range": f"bytes={got}-{got + chunk * 4 - 1}"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    cr = r.headers.get("Content-Range")
                    if cr and "/" in cr and cr.split("/")[1].isdigit():
                        total = int(cr.split("/")[1])
                    data = r.read()
                if not data:
                    break
                f.write(data)
                got += len(data)
                if total:
                    self.progress = got / total
                    if time.time() - last_emit > 0.5:
                        last_emit = time.time()
                        self.engine.loop.call_soon_threadsafe(self._emit)
                if total is None or got >= total:
                    break
        tmp.replace(dest)
        track = {k: v for k, v in t.items() if k in ("id", "title", "artists", "artist", "album", "dur", "thumb", "explicit", "type")}
        self.index[t["id"]] = {"file": name, "size": got, "added": time.time(), "track": track}
        config.write_json(config.OFFLINE_INDEX, self.index)
