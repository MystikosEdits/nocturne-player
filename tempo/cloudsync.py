"""Settings sync through the YouTube Music account (Grant, Nov 22: "make all settings and everything tied to the google
account or something so it saves across both machines" -> picked "YouTube account").

Storage = the DESCRIPTION of a private playlist on the signed-in account, "Nocturne settings (don't delete)" (Nocturne
hides it from its own lists). Payload = zlib + base64 JSON, written as "NSYNC1 <i>/<n> <sig> <chunk>"; one playlist holds
~4,800 chars (Grant's settings + 6 versions = ~2,500), more spill into "... 2", "... 3". Measured Nov 22: write 0.6 s,
read 0.3 s, a 4,891-char description read back byte-identical, privacy PRIVATE.

Merge rules (each machine can change things while the other is off):
  settings keys   last writer wins, per key (timestamps in DATA/sync.json, set when the key is saved)
  My versions     union by id; a deletion leaves a tombstone so it doesn't come back; renames: newest `mtime` wins
  version links   union (a stale link is harmless: the overlay needs the entry to exist in the playlist)
Every sync PULLS first, merges, then pushes only if this machine has something newer. Pull: at start, every 60 s while a
window is open, every 5 min otherwise. Push: 4 s after the last local change.
Per machine (never synced): window size/position, volume, the Size zoom (theme.scale), start at login, this toggle.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
import zlib

from . import config

log = logging.getLogger("tempo.sync")
import os as _os
TITLE = _os.environ.get("TEMPO_SYNC_TITLE") or "Nocturne settings (don't delete)"   # tests use their own playlist
MAGIC = "NSYNC1"
PART = 4700                     # chars of payload per playlist description (limit 5,000 with the header)
META_FILE = config.DATA / "sync.json"
SYNC_KEYS = ["theme", "sidebar", "eq", "global_fx", "bg_sound", "icon_hue", "quality", "autoplay", "normalize",
             "log_history", "keep_playing_on_close", "country", "recent"]
LOCAL_THEME_KEYS = ("scale",)   # theme fields that stay per machine


def is_sync_title(title: str) -> bool:
    return (title or "").startswith(TITLE)


class CloudSync:
    def __init__(self, engine):
        self.e = engine
        m = config.read_json(META_FILE, {}) or {}
        self.meta = {"enabled": m.get("enabled", True), "ts": m.get("ts") or {}, "pids": m.get("pids") or [],
                     "vdel": m.get("vdel") or {}, "last": m.get("last") or 0, "error": None, "remote_sig": m.get("remote_sig")}
        if not m:
            # FIRST RUN on this machine: settings made before sync existed get a time stamp = when the settings file was
            # last saved, so a fresh install takes the account's look, and between two set-up machines (laptop + Mac)
            # the one changed more recently wins. Defaults get no stamp (they never override anything).
            try:
                mt = config.SETTINGS_FILE.stat().st_mtime
            except OSError:
                mt = 0
            for k in SYNC_KEYS:
                v = engine.settings.get(k)
                if mt and v not in (None, [], {}, "") and v != config.DEFAULTS.get(k):
                    self.meta["ts"][k] = mt
        self._lock = asyncio.Lock()
        self._applying = False
        self._push_handle = None
        engine.settings.on_change = self.touch          # every settings.update() reports its keys here

    # ------------------------------------------------------------------ bookkeeping
    def _save_meta(self):
        config.write_json(META_FILE, {k: v for k, v in self.meta.items() if k != "error"})

    def touch(self, keys):
        """A local change: stamp it and push a few seconds later."""
        if self._applying:
            return
        now = time.time()
        hit = False
        for k in keys:
            if k in SYNC_KEYS or k in ("versions", "pl_versions"):
                self.meta["ts"][k] = now
                hit = True
        if not hit:
            return
        self._save_meta()
        if self.meta["enabled"] and self.e.yt.authed:
            loop = self.e.loop
            def arm():
                if self._push_handle:
                    self._push_handle.cancel()
                self._push_handle = loop.call_later(4, lambda: loop.create_task(self.sync()))
            loop.call_soon_threadsafe(arm)

    def version_deleted(self, vid: str):
        self.meta["vdel"][vid] = time.time()
        self.touch(["versions"])

    def status(self) -> dict:
        return {"enabled": self.meta["enabled"], "signed_in": bool(self.e.yt.authed), "last": self.meta["last"],
                "error": self.meta["error"], "parts": len(self.meta["pids"])}

    async def set_enabled(self, on: bool):
        self.meta["enabled"] = bool(on)
        self._save_meta()
        if on:
            await self.sync()

    # ------------------------------------------------------------------ payload
    def _payload(self) -> dict:
        s = {}
        for k in SYNC_KEYS:
            v = self.e.settings.get(k)
            if k == "theme" and isinstance(v, dict):
                v = {kk: vv for kk, vv in v.items() if kk not in LOCAL_THEME_KEYS}
            s[k] = v
        return {"v": 1, "ts": self.meta["ts"], "s": s, "versions": self.e.versions, "vdel": self.meta["vdel"],
                "plv": self.e.pl_versions}

    @staticmethod
    def _encode(payload: dict) -> list[str]:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        b = base64.b64encode(zlib.compress(raw, 9)).decode()
        sig = hashlib.sha1(b.encode()).hexdigest()[:10]
        chunks = [b[i:i + PART] for i in range(0, len(b), PART)] or [""]
        return [f"{MAGIC} {i + 1}/{len(chunks)} {sig} {c}" for i, c in enumerate(chunks)]

    @staticmethod
    def _decode(descs: list[str]) -> tuple[dict | None, str | None]:
        parts = {}
        for d in descs:
            bits = (d or "").split(" ", 3)
            if len(bits) == 4 and bits[0] == MAGIC and "/" in bits[1]:
                i, n = bits[1].split("/")
                parts[int(i)] = (int(n), bits[2], bits[3])
        if 1 not in parts:
            return None, None
        n, sig, _ = parts[1]
        if any(i not in parts or parts[i][1] != sig for i in range(1, n + 1)):
            return None, None                     # a half-written set: try again next time
        b = "".join(parts[i][2] for i in range(1, n + 1))
        return json.loads(zlib.decompress(base64.b64decode(b))), sig

    # ------------------------------------------------------------------ YouTube side (blocking: run in the pool)
    def _find(self) -> list[str]:
        """Playlist ids of the sync parts, in order (looked up once, then remembered)."""
        api = self.e.yt.api
        found = {}
        for p in api.get_library_playlists(limit=None) or []:
            t = p.get("title") or ""
            if is_sync_title(t):
                suffix = t[len(TITLE):].strip()
                found[int(suffix) if suffix.isdigit() else 1] = p.get("playlistId")
        return [found[i] for i in sorted(found)]

    def _read(self) -> tuple[dict | None, str | None]:
        api = self.e.yt.api
        pids = self.meta["pids"] or self._find()
        descs = []
        for pid in pids:
            try:
                descs.append(api.get_playlist(pid, limit=1).get("description") or "")
            except Exception:                     # a part was deleted on YouTube: look them up again next time
                self.meta["pids"] = []
                pids = self._find()
                descs = [api.get_playlist(p, limit=1).get("description") or "" for p in pids]
                break
        self.meta["pids"] = pids
        return self._decode(descs)

    def _write(self, descs: list[str]):
        api = self.e.yt.api
        pids = list(self.meta["pids"])
        for i, d in enumerate(descs):
            if i < len(pids):
                api.edit_playlist(pids[i], description=d)
            else:
                title = TITLE if i == 0 else f"{TITLE} {i + 1}"
                pid = api.create_playlist(title, d, privacy_status="PRIVATE")
                pid = pid if isinstance(pid, str) else (pid or {}).get("playlistId")
                pids.append(pid)
        self.meta["pids"] = pids

    # ------------------------------------------------------------------ merge + apply
    def _merge(self, remote: dict) -> tuple[list[str], bool]:
        """-> (keys taken from the remote, whether this machine has something the remote lacks)."""
        took, ours_newer = [], False
        rts = remote.get("ts") or {}
        lts = self.meta["ts"]
        for k in SYNC_KEYS:
            r, l = float(rts.get(k) or 0), float(lts.get(k) or 0)
            if r > l and k in (remote.get("s") or {}):
                took.append(k)
            elif l > r:
                ours_newer = True
        # versions: union, tombstones, newest mtime per id
        vdel = dict(self.meta["vdel"])
        for vid, t in (remote.get("vdel") or {}).items():
            vdel[vid] = max(float(t), float(vdel.get(vid) or 0))
        mine = {v["vid"]: v for v in self.e.versions}
        theirs = {v["vid"]: v for v in remote.get("versions") or []}
        merged = {}
        for vid in set(mine) | set(theirs):
            a, b = mine.get(vid), theirs.get(vid)
            pick = a if b is None else b if a is None else (a if (a.get("mtime") or a.get("created") or 0) >= (b.get("mtime") or b.get("created") or 0) else b)
            if vid in vdel and vdel[vid] >= (pick.get("mtime") or pick.get("created") or 0):
                continue
            merged[vid] = pick
        order = sorted(merged.values(), key=lambda v: -(v.get("created") or 0))
        if [v["vid"] for v in order] != [v["vid"] for v in self.e.versions] or any(mine.get(v["vid"]) is not v for v in order):
            took.append("versions")
        stamp = lambda v: v.get("mtime") or v.get("created") or 0     # noqa: E731
        if set(mine) - set(theirs) or any(vid not in (remote.get("vdel") or {}) for vid in self.meta["vdel"]) \
                or any(vid in theirs and stamp(v) > stamp(theirs[vid]) for vid, v in mine.items()):
            ours_newer = True
        self._merged_versions, self.meta["vdel"] = order, vdel
        # version links: union
        plv = {pid: dict(m) for pid, m in self.e.pl_versions.items()}
        for pid, m in (remote.get("plv") or {}).items():
            cur = plv.setdefault(pid, {})
            for sv, vid in m.items():
                if sv not in cur:
                    cur[sv] = vid
                    if "pl_versions" not in took:
                        took.append("pl_versions")
        for pid, m in self.e.pl_versions.items():
            if any(sv not in ((remote.get("plv") or {}).get(pid) or {}) for sv in m):
                ours_newer = True
        self._merged_plv = plv
        return took, ours_newer

    async def _apply(self, remote: dict, took: list[str]):
        e = self.e
        rs = remote.get("s") or {}
        self._applying = True
        try:
            patch = {}
            for k in took:
                if k in SYNC_KEYS:
                    v = rs.get(k)
                    if k == "theme" and isinstance(v, dict):
                        local = e.settings.get("theme") or {}
                        v = {**v, **{kk: local[kk] for kk in LOCAL_THEME_KEYS if kk in local}}
                    patch[k] = v
                    self.meta["ts"][k] = float((remote.get("ts") or {}).get(k) or time.time())
            if patch:
                await e.update_settings(patch)          # quality / country / normalize side effects
                if "eq" in patch or "global_fx" in patch:
                    await e._apply_fx(e.current)
                if "bg_sound" in patch:
                    await e.bg.apply()
                if "icon_hue" in patch:
                    from . import appicon
                    hue = appicon.clamp(patch["icon_hue"])
                    await e.loop.run_in_executor(e.pool, appicon.paths, hue)
                    await e.loop.run_in_executor(e.pool, appicon.apply_engine, getattr(e, "app_ctx", None), hue)
                    e.emit("icon", {"hue": hue})
            if "versions" in took:
                e.versions = self._merged_versions
                e._save_versions()
                e.emit("versions", {"count": len(e.versions)})
            if "pl_versions" in took:
                e.pl_versions = self._merged_plv
                config.write_json(config.PL_VERSIONS_FILE, e.pl_versions)
            if took:
                e.emit("synced", {"keys": took})
        finally:
            self._applying = False

    # ------------------------------------------------------------------ the round
    async def sync(self, force_push: bool = False) -> dict:
        e = self.e
        if not (self.meta["enabled"] and e.yt.authed):
            return self.status()
        async with self._lock:
            try:
                remote, sig = await e.loop.run_in_executor(e.pool, self._read)
                push = force_push
                if remote is None:
                    push = True                                     # nothing on the account yet: put ours there
                else:
                    took, ours_newer = self._merge(remote)
                    if took:
                        await self._apply(remote, took)
                        log.info("sync: took %s from the account", ", ".join(took))
                    push = push or ours_newer
                if push:
                    descs = self._encode(self._payload())
                    await e.loop.run_in_executor(e.pool, self._write, descs)
                    log.info("sync: pushed %d chars in %d part(s)", sum(len(d) for d in descs), len(descs))
                self.meta["last"] = time.time()
                self.meta["error"] = None
            except Exception as ex:                                 # noqa: BLE001
                self.meta["error"] = str(ex)[:200]
                log.warning("sync failed: %s", ex)
            self._save_meta()
        return self.status()

    async def loop_forever(self, window_open):
        await asyncio.sleep(6)
        while True:
            try:
                await self.sync()
            except Exception as ex:                                 # noqa: BLE001
                log.debug("sync loop: %s", ex)
            await asyncio.sleep(60 if window_open() else 300)
