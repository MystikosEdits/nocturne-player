"""The brain: queue, playback, autoplay radio, sleep timer, history, state for the UI."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from . import config, fx as fxmod
from .bg import Background
from .player import Mpv
from .yt import YT

log = logging.getLogger("tempo.engine")


class Engine:
    def __init__(self, silent: bool = False):
        self.settings = config.Settings()
        self.yt = YT(self.settings)
        self.mpv = Mpv(self._on_mpv, silent=silent)
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tempo")
        self.prefetch_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tempo-pre")
        self._prefetching: set[str] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self.media = None            # OS media controls (set by app)
        self.offline = None          # offline downloads (set by app)
        self.on_track_change = []    # callbacks(track)
        self.on_repeated_failures = None  # set by app: refresh yt-dlp when YouTube changed something

        # queue
        self.items: list[dict] = []
        self.index = -1
        self.context: dict | None = None
        self.shuffle = False
        self.repeat = "off"          # off | all | one
        self._unshuffled: list[str] | None = None
        self._qid = 0
        self.qver = 0

        # playback
        self.paused = True
        self.loaded = False          # is the current track loaded in mpv
        self.loading = False
        self.buffering = False
        self.pos = 0.0
        self.pos_ts = time.time()
        self.dur = 0.0
        self.volume = int(self.settings.get("volume") or 70)
        self.muted = False
        self.stream_info: dict | None = None
        self.entry_map: dict[int, str] = {}     # mpv playlist_entry_id -> qid
        self.cur_entry: int | None = None
        self._next_qid_loaded: str | None = None
        self._sync_lock = asyncio.Lock()
        self._play_token = 0
        self.played_ids: list[str] = []
        self._logged_play = False
        self._autoplay_busy = False
        self.sleep: dict | None = None          # {"until": ts} or {"end_of_track": True}
        self._fade_task = None
        self.toast_seq = 0
        self._dirty = False
        self._last_save = 0.0
        self.errors_in_row = 0
        # effects currently set in mpv (only touch mpv when they change: rebuilding `af` = tiny dropout)
        self._af_now: str | None = None
        self._speed_now = 1.0
        self._pitch_now: bool | None = None
        self._rubberband = True      # mpv's rubberband filter for keep-pitch; off after mpv refuses it once
        self.versions: list[dict] = config.read_json(config.VERSIONS_FILE, []) or []
        # {playlistId: {setVideoId: version vid}}: a My version added to a YouTube playlist is stored there as its
        # original song (YouTube can't hold effects); this remembers which ENTRY is the version, so Nocturne shows and
        # plays it with its effects. The YouTube Music app shows the plain song.
        self.pl_versions: dict[str, dict[str, str]] = config.read_json(config.PL_VERSIONS_FILE, {}) or {}
        self.bg = Background(self)

    # ================================================================ lifecycle
    async def start(self):
        self.loop = asyncio.get_running_loop()
        self.mpv.volume = self.volume
        await self.mpv.start(self.volume)
        self._restore()
        await self._apply_fx(self.current)
        if self.bg.state()["on"]:
            self.loop.create_task(self.bg.apply())
        self.loop.create_task(self._ticker())
        self.loop.run_in_executor(self.pool, self._warm)

    def _warm(self):
        """The first stream lookup after a start costs ~8 s (yt-dlp loads its extractors, YouTube's
        player code, opens connections). Pay that in the background so the first click is quick."""
        try:
            self.yt.account_info()
        except Exception:
            pass
        warm_id = (self.current or {}).get("id") or "kJQP7kiw5Fk"   # any song that's on YouTube Music
        try:
            self.yt.resolve(warm_id, fast=True)
            if self.yt.wants_premium():
                self.yt.resolve(warm_id)
        except Exception:
            pass
        # pages you open first: served from the disk cache instantly, refreshed here in the background
        for fn in (self.yt.home, lambda: self.yt.library("playlists"), self.yt.explore):
            try:
                fn()
            except Exception:
                pass

    async def stop(self):
        self._save(force=True)
        await self.bg.stop()
        await self.mpv.shutdown()

    async def run_blocking(self, fn, *a):
        return await self.loop.run_in_executor(self.pool, fn, *a)

    def prefetch(self, ids: list[str]):
        """Hovering a song warms its stream URL so clicking it starts right away."""
        for vid in ids[:3]:
            if self.yt.stream_ready(vid) or vid in self._prefetching:
                continue
            if self.offline and self.offline.has(vid):
                continue
            self._prefetching.add(vid)

            def job(v=vid):
                try:
                    self.yt.prefetch(v)
                finally:
                    self._prefetching.discard(v)
            self.loop.run_in_executor(self.prefetch_pool, job)

    # ================================================================ state out
    def snapshot(self) -> dict:
        cur = self.current
        pos = self._live_pos()
        si = self.stream_info or {}
        return {
            "track": cur, "paused": self.paused, "loading": self.loading or self.buffering,
            "pos": round(pos, 2), "dur": self.dur or (cur or {}).get("dur") or 0, "ts": time.time(),
            "volume": self.volume, "muted": self.muted, "shuffle": self.shuffle, "repeat": self.repeat,
            "autoplay": bool(self.settings.get("autoplay")), "qver": self.qver, "index": self.index,
            "count": len(self.items), "context": self.context,
            "sleep": self._sleep_view(),
            "stream": {"codec": si.get("codec"), "abr": si.get("abr"), "format": si.get("format"), "offline": si.get("offline", False)} if si else None,
            "auth": {"yt": self.yt.authed, "premium": self.yt.premium, "account": self.yt.account},
            "eq": self.settings.get("eq"), "speed": self._speed_now,
            "global_fx": self.settings.get("global_fx"), "bg": self.bg.state(),
        }

    def queue_view(self) -> dict:
        return {"ver": self.qver, "index": self.index, "items": self.items, "context": self.context,
                "shuffle": self.shuffle, "repeat": self.repeat}

    def emit(self, kind: str = "state", data: Any = None):
        if data is None and kind == "state":
            data = self.snapshot()
        msg = f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
        for q in list(self.subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass
        if kind == "state" and self.media:
            try:
                self.media.update(self.current, not self.paused, self._live_pos(), self.dur)
            except Exception as e:
                log.debug("media update failed: %s", e)

    def toast(self, text: str, kind: str = "info"):
        self.toast_seq += 1
        self.emit("toast", {"id": self.toast_seq, "text": text, "kind": kind})

    def _queue_changed(self):
        self.qver += 1
        self._dirty = True
        self.emit("queue", {"ver": self.qver})
        self.emit()

    def _live_pos(self) -> float:
        # song time, so a slowed song (speed 0.85) advances 0.85 s per real second
        if not self.paused and self.loaded and not self.loading and not self.buffering:
            return self.pos + (time.time() - self.pos_ts) * self._speed_now
        return self.pos

    # ================================================================ queue helpers
    @property
    def current(self) -> dict | None:
        if 0 <= self.index < len(self.items):
            return self.items[self.index]
        return None

    def _new_item(self, t: dict, **flags) -> dict:
        self._qid += 1
        item = {k: v for k, v in t.items() if k not in ("qid", "added", "auto", "kind", "setVideoId")}
        item["qid"] = f"q{self._qid}"
        item.update(flags)
        return item

    def _find(self, qid: str) -> int:
        for i, it in enumerate(self.items):
            if it["qid"] == qid:
                return i
        return -1

    def _next_index(self) -> int | None:
        if not self.items:
            return None
        if self.index + 1 < len(self.items):
            return self.index + 1
        if self.repeat == "all":
            return 0
        return None

    # ================================================================ commands
    async def play_tracks(self, tracks: list[dict], start: int = 0, context: dict | None = None, shuffle: bool | None = None):
        tracks = [t for t in tracks if t and t.get("id") and not t.get("unavailable")]
        if not tracks:
            self.toast("Nothing playable here")
            return
        start = max(0, min(start, len(tracks) - 1))
        if shuffle is not None:
            self.shuffle = shuffle
        self.items = [self._new_item(t) for t in tracks]
        self.context = context
        self._unshuffled = None
        if self.shuffle:
            first = self.items[start]
            rest = self.items[:start] + self.items[start + 1:]
            self._unshuffled = [i["qid"] for i in self.items]
            random.shuffle(rest)
            self.items = [first] + rest
            start = 0
        self._queue_changed()
        await self.play_index(start)

    async def play_single(self, t: dict):
        """One song: play it, then let autoplay fill 'up next' with its radio (like YouTube Music)."""
        await self.play_tracks([t], 0, {"type": "radio", "id": t["id"], "title": f"{t['title']} radio"})
        self.loop.create_task(self._autoplay_fill(force=True))

    async def add(self, tracks: list[dict], next_: bool = False):
        tracks = [t for t in tracks if t and t.get("id")]
        if not tracks:
            return
        new = [self._new_item(t, added=True) for t in tracks]
        if self.index < 0 or not self.items:
            self.items = new
            self.index = 0
            self.loaded = False
            self.paused = True
            self._queue_changed()
            await self.play_index(0)
            return
        if next_:
            pos = self.index + 1
        else:
            # after the other songs you added (Spotify-style), before the rest of the album/playlist
            pos = self.index + 1
            while pos < len(self.items) and self.items[pos].get("added"):
                pos += 1
        self.items[pos:pos] = new
        self._queue_changed()
        n = len(new)
        what = new[0]["title"] if n == 1 else f"{n} songs"
        self.toast(f"{'Playing next' if next_ else 'Added to queue'}: {what}")
        await self.sync_next()

    async def remove(self, qids: list[str]):
        cur = self.current
        gone = set(qids)
        removing_current = cur and cur["qid"] in gone
        before = sum(1 for i in self.items[: max(self.index, 0)] if i["qid"] in gone)
        self.items = [i for i in self.items if i["qid"] not in gone]
        if cur and not removing_current:
            self.index = self._find(cur["qid"])
        elif removing_current:
            # the song that came after the removed one (removed songs before it shift it down)
            self.index = min(self.index - before, len(self.items) - 1)
            self._queue_changed()
            if self.index >= 0:
                await self.play_index(self.index, paused=self.paused)
            else:
                await self._stop_all()
            return
        self._queue_changed()
        await self.sync_next()

    async def move(self, qid: str, to: int):
        i = self._find(qid)
        if i < 0:
            return
        cur = self.current
        item = self.items.pop(i)
        to = max(0, min(to, len(self.items)))
        self.items.insert(to, item)
        if cur:
            self.index = self._find(cur["qid"])
        self._queue_changed()
        await self.sync_next()

    async def insert(self, tracks: list[dict], at: int):
        """Put songs back at a position (Undo of a queue removal / clear)."""
        new = [self._new_item(t, **{k: True for k in ("added", "auto") if t.get(k)}) for t in tracks if t and t.get("id")]
        if not new:
            return
        at = max(0, min(int(at), len(self.items)))
        if self.index >= 0 and at <= self.index:
            at = self.index + 1       # never in front of the song that's playing
        self.items[at:at] = new
        self._queue_changed()
        await self.sync_next()

    async def shuffle_upcoming(self):
        up = self.items[self.index + 1:]
        if len(up) < 2:
            return
        random.shuffle(up)
        self.items = self.items[: self.index + 1] + up
        self._queue_changed()
        await self.sync_next()

    async def clear_upcoming(self):
        if self.index >= 0:
            self.items = self.items[: self.index + 1]
        else:
            self.items = []
        self._queue_changed()
        await self.sync_next()

    async def jump(self, qid: str):
        i = self._find(qid)
        if i >= 0:
            await self.play_index(i)

    async def toggle(self):
        if self.paused:
            await self.play()
        else:
            await self.pause()

    async def play(self):
        if self.current is None:
            return
        if not self.loaded:
            await self.play_index(self.index, start=self.pos)
            return
        await self.mpv.set("pause", False)

    async def pause(self):
        if self.loaded:
            await self.mpv.set("pause", True)
        else:
            self.paused = True
            self.emit()

    async def next(self, user: bool = True):
        nxt = self._next_index()
        if nxt is None:
            if self.settings.get("autoplay"):
                await self._autoplay_fill(force=True)
                nxt = self._next_index()
            if nxt is None:
                await self._end_of_queue()
                return
        # the next song is already loaded into mpv -> instant, gapless switch
        if self.loaded and self._next_qid_loaded == self.items[nxt]["qid"] and self.repeat != "one":
            try:
                await self.mpv.command("playlist-next", "force")
                if self.paused:
                    await self.mpv.set("pause", False)
                return
            except Exception:
                pass
        await self.play_index(nxt)

    async def prev(self):
        if self._live_pos() > 4 or self.index <= 0:
            await self.seek(0)
            if self.paused and self.loaded:
                await self.mpv.set("pause", False)
            return
        await self.play_index(self.index - 1)

    async def seek(self, pos: float):
        pos = max(0.0, float(pos))
        if not self.loaded:
            self.pos = pos
            self.pos_ts = time.time()
            self.emit()
            return
        try:
            await self.mpv.command("seek", pos, "absolute+exact")
        except Exception:
            pass
        self.pos = pos
        self.pos_ts = time.time()
        self.emit()

    async def set_volume(self, v: int):
        self.volume = max(0, min(100, int(v)))
        self.mpv.volume = self.volume
        await self.mpv.set("volume", self.volume)
        self.settings.data["volume"] = self.volume
        self._dirty = True
        self.emit()

    async def set_mute(self, m: bool):
        self.muted = bool(m)
        await self.mpv.set("mute", self.muted)
        self.emit()

    async def set_shuffle(self, on: bool):
        if on == self.shuffle:
            return
        self.shuffle = on
        upcoming = self.items[self.index + 1:]
        if on:
            self._unshuffled = [i["qid"] for i in self.items]
            random.shuffle(upcoming)
            self.items = self.items[: self.index + 1] + upcoming
        elif self._unshuffled:
            order = {q: n for n, q in enumerate(self._unshuffled)}
            cur = self.current
            known = sorted([i for i in self.items if i["qid"] in order], key=lambda i: order[i["qid"]])
            extra = [i for i in self.items if i["qid"] not in order]
            self.items = known + extra
            if cur:
                self.index = self._find(cur["qid"])
            self._unshuffled = None
        self._queue_changed()
        await self.sync_next()

    async def set_repeat(self, mode: str):
        if mode not in ("off", "all", "one"):
            return
        self.repeat = mode
        try:
            await self.mpv.set("loop-file", "inf" if mode == "one" else "no")
        except Exception:
            pass
        self._dirty = True
        self.emit()
        await self.sync_next()

    async def set_autoplay(self, on: bool):
        self.settings.update({"autoplay": bool(on)})
        self.emit()
        if on:
            self.loop.create_task(self._autoplay_fill())

    async def set_sleep(self, minutes: float | None = None, end_of_track: bool = False):
        if end_of_track:
            self.sleep = {"end_of_track": True}
            self.toast("Stopping after this song")
        elif minutes:
            self.sleep = {"until": time.time() + minutes * 60, "minutes": minutes}
            self.toast(f"Sleep timer: {int(minutes)} min")
        else:
            self.sleep = None
            self.toast("Sleep timer off")
        if self._fade_task:            # turned off / changed while it was fading out: stop the fade, volume back
            self._fade_task.cancel()
            self._fade_task = None
            try:
                await self.mpv.set("volume", self.volume)
            except Exception:
                pass
        self.emit()
        await self.sync_next()

    def _sleep_view(self):
        if not self.sleep:
            return None
        if self.sleep.get("end_of_track"):
            return {"end_of_track": True}
        return {"left": max(0, int(self.sleep["until"] - time.time())), "minutes": self.sleep.get("minutes")}

    # ================================================================ loading tracks
    async def _source_for(self, t: dict, fast: bool = False) -> dict:
        if self.offline:
            local = self.offline.path_for(t["id"])
            if local:
                return {"url": str(local), "headers": {}, "offline": True, "codec": local.suffix.lstrip("."), "abr": None, "format": "file"}
        return await self.run_blocking(self.yt.resolve, t["id"], fast)

    def _file_opts(self, t: dict, src: dict, start: float = 0) -> dict:
        opts: dict[str, Any] = {"force-media-title": f"{t['title']} — {t.get('artist') or ''}".strip(" —")}
        if start and start > 1:
            opts["start"] = f"{start:.2f}"
        return opts

    async def play_index(self, i: int, start: float = 0, paused: bool = False):
        if not (0 <= i < len(self.items)):
            return
        self._play_token += 1
        token = self._play_token
        self.index = i
        t = self.items[i]
        self.loading = True
        self.pos = start or 0
        self.pos_ts = time.time()
        self.dur = t.get("dur") or 0
        self.paused = paused
        self._logged_play = False
        self._next_qid_loaded = None
        self._queue_changed()
        self._track_started(t)
        try:
            # something you just clicked starts on the quick stream unless Premium is already in hand;
            # the songs after it load Premium in the background (sync_next)
            src = await self._source_for(t, fast=not self.yt.has_premium(t["id"]))
        except Exception as e:
            if token != self._play_token:
                return
            log.warning("resolve failed %s: %s", t["id"], e)
            await self._track_failed(t, str(e))
            return
        if token != self._play_token:
            return  # the user already picked something else
        self.stream_info = src
        await self._apply_fx(t)
        try:
            opts = self._file_opts(t, src, start)
            if paused:
                opts["pause"] = "yes"
            entry = await self.mpv.loadfile(src["url"], "replace", opts)
            if not paused:
                await self.mpv.set("pause", False)
        except Exception as e:
            log.warning("mpv loadfile failed: %s", e)
            await self._track_failed(t, "player error")
            return
        self.entry_map = {entry: t["qid"]} if entry is not None else {}
        self.cur_entry = entry
        self.loaded = True
        self.loading = False
        self.pos = start or 0
        self.pos_ts = time.time()
        self._bg_sync()            # music just started: background sounds duck / stop
        self.errors_in_row = 0
        self.emit()
        self.loop.create_task(self.sync_next())
        if self.settings.get("autoplay"):
            self.loop.create_task(self._autoplay_fill())

    def _track_started(self, t: dict):
        if not self.played_ids or self.played_ids[-1] != t["id"]:
            self.played_ids.append(t["id"])
            self.played_ids = self.played_ids[-300:]
        for cb in self.on_track_change:
            try:
                cb(t)
            except Exception:
                pass

    async def _track_failed(self, t: dict, why: str):
        self.loading = False
        self.loaded = False
        t["unavailable"] = True
        self.errors_in_row += 1
        self.toast(f"Couldn't play “{t['title']}” — skipping", "error")
        self._queue_changed()
        if self.errors_in_row == 3 and self.on_repeated_failures:
            try:
                self.on_repeated_failures()
            except Exception:
                pass
        if self.errors_in_row >= 4:
            self.paused = True
            self.toast("Several songs in a row failed. Check your internet — Nocturne is also updating its YouTube downloader: if this keeps happening, quit Nocturne from the tray in a minute and open it again.", "error")
            self.emit()
            return
        nxt = self._next_index()
        if nxt is not None and nxt != self.index:
            await self.play_index(nxt)
        else:
            self.paused = True
            self.emit()

    async def sync_next(self):
        """Keep exactly [current, next] in mpv's playlist so the switch to the next song is gapless."""
        if not self.loaded or self.cur_entry is None:
            return
        async with self._sync_lock:
            want = None
            if self.repeat != "one" and not (self.sleep and self.sleep.get("end_of_track")):
                ni = self._next_index()
                if ni is not None and ni != self.index:
                    want = self.items[ni]
            if want and want.get("unavailable"):
                want = None
            cur = self.current
            if want and cur and self._effective_fx(want) != self._effective_fx(cur):
                # different speed/effects: a gapless hand-over would play its start with this song's
                # effects, so let it load fresh when this one ends instead
                want = None
            if want and self._next_qid_loaded == want["qid"]:
                return
            # drop whatever is queued after the current entry in mpv
            try:
                pl = await self.mpv.get("playlist", []) or []
            except Exception:
                pl = []
            cur_pos = next((n for n, e in enumerate(pl) if e.get("current") or e.get("playing")), 0)
            for n in range(len(pl) - 1, cur_pos, -1):
                try:
                    await self.mpv.command("playlist-remove", n)
                except Exception:
                    pass
            self._next_qid_loaded = None
            if not want:
                return
            try:
                src = await self._source_for(want)
            except Exception as e:
                log.info("prefetch resolve failed: %s", e)
                return
            # the queue may have changed while we waited
            ni = self._next_index()
            if ni is None or self.items[ni]["qid"] != want["qid"] or not self.loaded:
                return
            try:
                entry = await self.mpv.loadfile(src["url"], "append", self._file_opts(want, src))
            except Exception as e:
                log.info("append failed: %s", e)
                return
            if entry is not None:
                self.entry_map[entry] = want["qid"]
            want["_src"] = {k: src.get(k) for k in ("codec", "abr", "format", "offline")}
            self._next_qid_loaded = want["qid"]

    # ================================================================ mpv events
    def _on_mpv(self, name: str, data: Any):
        if name == "prop:pause":
            self.pos = self._live_pos() if not self.paused else self.pos
            self.pos_ts = time.time()
            self.paused = bool(data)
            self.emit()
            self._bg_sync()
        elif name == "prop:duration":
            if data:
                self.dur = float(data)
                self.emit()
        elif name == "prop:paused-for-cache":
            self.buffering = bool(data)
            self.loop.create_task(self._refresh_pos())
        elif name == "prop:volume":
            if data is not None and abs(float(data) - self.volume) > 0.5 and not self._fade_task:
                self.volume = int(round(float(data)))
                self.emit()
        elif name == "prop:mute":
            self.muted = bool(data)
            self.emit()
        elif name in ("seek", "playback-restart"):
            self.loop.create_task(self._refresh_pos())
        elif name == "start-file":
            entry = (data or {}).get("playlist_entry_id")
            self.loop.create_task(self._on_start_file(entry))
        elif name == "end-file":
            self.loop.create_task(self._on_end_file(data or {}))
        elif name == "mpv-lost":
            self.loop.create_task(self._recover_mpv())

    async def _refresh_pos(self):
        p = await self.mpv.get("time-pos")
        if p is not None:
            self.pos = float(p)
            self.pos_ts = time.time()
        self.emit()

    async def _on_start_file(self, entry):
        if entry is None or entry == self.cur_entry:
            return
        qid = self.entry_map.get(entry)
        if qid is None:
            return
        i = self._find(qid)
        if i < 0:
            return
        # mpv moved on by itself (end of song / playlist-next): follow it
        self.cur_entry = entry
        self.index = i
        t = self.items[i]
        await self._apply_fx(t)
        self.pos = 0
        self.pos_ts = time.time()
        self.dur = t.get("dur") or 0
        self.loading = False
        self._logged_play = False
        self._next_qid_loaded = None
        if t.get("_src"):
            self.stream_info = t.pop("_src")
        # remove finished entries from mpv's playlist
        try:
            pl = await self.mpv.get("playlist", []) or []
            cur_pos = next((n for n, e in enumerate(pl) if e.get("current") or e.get("playing")), 0)
            for _ in range(cur_pos):
                await self.mpv.command("playlist-remove", 0)
        except Exception:
            pass
        self.entry_map = {entry: qid}
        self._track_started(t)
        self._queue_changed()
        await self.sync_next()
        if self.settings.get("autoplay"):
            self.loop.create_task(self._autoplay_fill())

    async def _on_end_file(self, data: dict):
        reason = data.get("reason")
        entry = data.get("playlist_entry_id")
        if entry != self.cur_entry:
            return
        if reason == "error":
            cur = self.current
            log.warning("mpv error on %s: %s", cur and cur["id"], data.get("file_error"))
            if cur:
                # stream URL may have expired: re-resolve once
                if not cur.get("_retried"):
                    cur["_retried"] = True
                    self.yt._stream_cache.pop(cur["id"], None)
                    await self.play_index(self.index, start=self._live_pos())
                    return
                await self._track_failed(cur, data.get("file_error") or "error")
            return
        if reason == "eof":
            if self.sleep and self.sleep.get("end_of_track"):
                self.sleep = None
                self.loaded = False
                self.paused = True
                self.pos = 0
                nxt = self._next_index()
                if nxt is not None:
                    self.index = nxt
                self._queue_changed()
                self.toast("Sleep timer: stopped")
                self.loop.create_task(self.bg.sleep_fired())
                return
            await asyncio.sleep(0.25)
            idle = await self.mpv.get("idle-active", False)
            if idle:
                # nothing was preloaded (queue ended or prefetch failed)
                nxt = self._next_index()
                if nxt is None and self.settings.get("autoplay"):
                    await self._autoplay_fill(force=True)
                    nxt = self._next_index()
                if nxt is not None:
                    await self.play_index(nxt)
                else:
                    await self._end_of_queue()

    def _bg_sync(self):
        if self.bg.state()["on"]:
            self.loop.create_task(self.bg.apply())

    async def _end_of_queue(self):
        self.loaded = False
        self.paused = True
        self.pos = 0
        self.pos_ts = time.time()
        self.emit()
        self._bg_sync()

    async def _stop_all(self):
        try:
            await self.mpv.command("stop")
        except Exception:
            pass
        self.loaded = False
        self.paused = True
        self.index = -1
        self.cur_entry = None
        self.entry_map = {}
        self._queue_changed()
        self._bg_sync()

    async def _recover_mpv(self):
        log.warning("mpv went away, restarting")
        pos = self._live_pos()
        was_playing = not self.paused
        self.loaded = False
        self.paused = True
        self.emit()
        for n, wait in enumerate((0, 2, 5, 15)):
            await asyncio.sleep(wait)
            try:
                await self.mpv.restart()
                break
            except Exception as e:
                log.error("mpv restart %d failed: %s", n + 1, e)
        else:
            self.toast("The player stopped working. Quit Nocturne from the tray and open it again.", "error")
            return
        # a new mpv knows none of the settings: effects, mute and repeat-one go in again
        self._af_now, self._speed_now, self._pitch_now = None, 1.0, None
        self.cur_entry, self.entry_map, self._next_qid_loaded = None, {}, None
        try:
            await self.mpv.set("mute", self.muted)
            if self.repeat == "one":
                await self.mpv.set("loop-file", "inf")
        except Exception:
            pass
        if self.current:
            await self.play_index(self.index, start=pos, paused=not was_playing)

    # ================================================================ autoplay
    async def _autoplay_fill(self, force: bool = False):
        if self._autoplay_busy or not self.items or self.repeat == "all":
            return
        remaining = len(self.items) - 1 - self.index
        if remaining > 2 and not force:
            return
        if remaining > 8:
            return
        self._autoplay_busy = True
        try:
            seed = self.items[-1]
            try:
                radio = await self.run_blocking(lambda: self.yt.radio(video_id=seed["id"], limit=40))
            except Exception as e:
                log.info("autoplay radio failed: %s", e)
                return
            seen = set(self.played_ids[-80:]) | {i["id"] for i in self.items}
            fresh = [t for t in radio if t["id"] not in seen]
            if not fresh:
                return
            self.items.extend(self._new_item(t, auto=True) for t in fresh[:25])
            self._queue_changed()
            await self.sync_next()
        finally:
            self._autoplay_busy = False

    async def start_radio(self, video_id: str | None = None, playlist_id: str | None = None, title: str = "Radio"):
        tracks = await self.run_blocking(lambda: self.yt.radio(video_id=video_id, playlist_id=playlist_id, limit=50))
        if not tracks:
            self.toast("No radio for this one")
            return
        await self.play_tracks(tracks, 0, {"type": "radio", "id": video_id or playlist_id, "title": title}, shuffle=False)

    # ================================================================ ticker
    async def _ticker(self):
        n = 0
        while True:
            await asyncio.sleep(1)
            n += 1
            try:
                await self._tick(n)
            except Exception as e:
                log.debug("tick error: %s", e)

    async def _tick(self, n: int):
        if self.loaded and not self.paused:
            if n % 5 == 0:
                p = await self.mpv.get("time-pos")
                if p is not None:
                    self.pos = float(p)
                    self.pos_ts = time.time()
                    self._dirty = True
            # count the play in YouTube Music history after 30 s (that's what teaches its recommendations)
            cur = self.current
            if cur and not self._logged_play and self._live_pos() > min(30, (self.dur or 60) * 0.5):
                self._logged_play = True
                if self.settings.get("log_history") and self.yt.authed:
                    self.loop.run_in_executor(self.pool, self.yt.log_play, cur["id"])
        # sleep timer
        if self.sleep and self.sleep.get("until"):
            left = self.sleep["until"] - time.time()
            if left <= 0 and not self._fade_task:
                self._fade_task = self.loop.create_task(self._fade_out_and_pause())
            elif n % 15 == 0:
                self.emit()
        if self.media and n % 5 == 0 and self.loaded:
            try:
                self.media.update(self.current, not self.paused, self._live_pos(), self.dur)
            except Exception:
                pass
        if self._dirty and time.time() - self._last_save > 3:
            self._save()

    async def _fade_out_and_pause(self):
        me = asyncio.current_task()
        try:
            start = self.volume
            for k in range(20):
                await self.mpv.set("volume", start * (1 - (k + 1) / 20))
                await asyncio.sleep(0.4)
            await self.mpv.set("pause", True)
            await self.mpv.set("volume", start)
            self.sleep = None
            self.toast("Sleep timer: paused")
            await self.bg.sleep_fired()
            self.emit()
        finally:
            if self._fade_task is me:
                self._fade_task = None

    # ================================================================ effects: EQ + song versions
    async def _apply_fx(self, t: dict | None):
        """Speed/pitch + one filter chain (EQ, the song's effects, volume levelling, limiter).
        mpv is only touched when something actually changes."""
        f = self._effective_fx(t) or {}
        speed = f.get("speed", 1.0)
        keep_pitch = bool(f.get("keep_pitch")) if f else True
        af = fxmod.build_af(self.settings.get("eq"), f, bool(self.settings.get("normalize")),
                            str(config.ASSETS / "reverb_ir.wav"), rubberband=self._rubberband)
        try:
            if keep_pitch != self._pitch_now:
                await self.mpv.set("audio-pitch-correction", keep_pitch)
                self._pitch_now = keep_pitch
            # filters before speed: with rubberband in the chain mpv never inserts scaletempo2 first
            if af != self._af_now:
                await self.mpv.set("af", af)
                self._af_now = af
            if abs(speed - self._speed_now) > 0.0005:
                self.pos = self._live_pos()          # bank the time played at the old speed
                self.pos_ts = time.time()
                await self.mpv.set("speed", speed)
                self._speed_now = speed
        except Exception as e:
            if af.startswith("rubberband") and self._rubberband:
                # this mpv has no librubberband (e.g. the official msvc Windows build): use scaletempo2
                log.info("mpv has no rubberband filter (%s), keep-pitch uses scaletempo2", e)
                self._rubberband = False
                return await self._apply_fx(t)
            log.warning("applying effects failed (%s): %s", af[:120], e)
            if af:
                try:   # never leave the player silent because of a bad filter
                    await self.mpv.set("af", "")
                    self._af_now = ""
                except Exception:
                    pass

    def _effective_fx(self, t: dict | None) -> dict | None:
        own = fxmod.clean_fx((t or {}).get("fx"))
        if own:
            return own
        g = self.settings.get("global_fx") or {}
        return fxmod.clean_fx(g.get("fx")) if g.get("on") and t else None

    async def set_global_fx(self, patch: dict) -> dict:
        g = dict(self.settings.get("global_fx") or {})
        if "on" in patch:
            g["on"] = bool(patch["on"])
        if patch.get("fx"):
            g["fx"] = fxmod.clean_fx(patch["fx"]) or g.get("fx")
        self.settings.update({"global_fx": g})
        await self._apply_fx(self.current)
        self.emit()
        await self.sync_next()
        return g

    async def set_eq(self, eq: dict) -> dict:
        cur = dict(self.settings.get("eq") or {})
        cur.update({k: v for k, v in eq.items() if k in ("on", "preset", "bands", "preamp")})
        cur["bands"] = [max(-12.0, min(12.0, float(x))) for x in (cur.get("bands") or [0] * 10)][:10]
        cur["preamp"] = max(-12.0, min(6.0, float(cur.get("preamp") or 0)))
        self.settings.update({"eq": cur})
        await self._apply_fx(self.current)
        self.emit()
        return cur

    async def set_live_fx(self, f: dict | None):
        """Effects on the song that's playing right now (the effects panel's live preview)."""
        cur = self.current
        if not cur:
            return
        clean = fxmod.clean_fx(f)
        if clean:
            cur["fx"] = clean
        else:
            cur.pop("fx", None)
        await self._apply_fx(cur)
        self._queue_changed()
        await self.sync_next()

    # ---------------- saved versions ("My versions")
    def _save_versions(self):
        config.write_json(config.VERSIONS_FILE, self.versions)
        if self.settings.on_change:
            self.settings.on_change(["versions"])

    def _save_pl_versions(self):
        config.write_json(config.PL_VERSIONS_FILE, self.pl_versions)
        if self.settings.on_change:
            self.settings.on_change(["pl_versions"])

    def version_track(self, v: dict) -> dict:
        t = dict(v["track"])
        t["fx"] = v["fx"]
        t["version_id"] = v["vid"]
        t["title"] = v["title"]
        return t

    def save_version(self, track: dict, f: dict, title: str | None = None) -> dict:
        clean = fxmod.clean_fx(f)
        if not clean:
            raise ValueError("Pick an effect first")
        base = {k: v for k, v in track.items() if k in ("id", "title", "artists", "artist", "album", "dur", "thumb", "explicit", "type")}
        if track.get("version_id"):   # saving a version of a version: start from the original
            orig = next((v for v in self.versions if v["vid"] == track["version_id"]), None)
            if orig:
                base = dict(orig["track"])
        name = (title or "").strip() or f"{base.get('title')} ({fxmod.describe(clean)})"
        v = {"vid": f"v{int(time.time() * 1000)}", "title": name, "track": base, "fx": clean, "created": time.time()}
        self.versions.insert(0, v)
        self._save_versions()
        self.emit("versions", {"count": len(self.versions)})
        return v

    def link_pl_version(self, pid: str, set_video_id: str, vid: str):
        self.pl_versions.setdefault(pid, {})[set_video_id] = vid
        self._save_pl_versions()

    def unlink_pl_entries(self, pid: str, set_video_ids: list[str]):
        m = self.pl_versions.get(pid) or {}
        if any(m.pop(sv, None) for sv in set_video_ids):
            if not m:
                self.pl_versions.pop(pid, None)
            self._save_pl_versions()

    def forget_playlist(self, pid: str):
        if self.pl_versions.pop(pid, None) is not None:
            self._save_pl_versions()

    def pl_overlay(self, p: dict) -> dict:
        """A playlist with its My-version entries swapped in (a copy: the cached playlist is never changed)."""
        m = self.pl_versions.get(p.get("id") or "") or {}
        if not m:
            return p
        by_vid = {v["vid"]: v for v in self.versions}
        tracks = []
        for t in p.get("tracks") or []:
            v = by_vid.get(m.get(t.get("setVideoId") or "", ""))
            if v:
                nt = self.version_track(v)
                nt["setVideoId"] = t["setVideoId"]
                tracks.append(nt)
            else:
                tracks.append(t)
        return {**p, "tracks": tracks}

    def delete_version(self, vid: str) -> dict | None:
        gone = next((v for v in self.versions if v["vid"] == vid), None)
        self.versions = [v for v in self.versions if v["vid"] != vid]
        if gone and getattr(self, "cloud", None):
            self.cloud.meta["vdel"][vid] = time.time()      # so the other machine's copy doesn't bring it back
        self._save_versions()
        self.emit("versions", {"count": len(self.versions)})
        return gone          # the UI keeps it for Undo

    def restore_version(self, v: dict):
        if not (isinstance(v, dict) and v.get("vid") and v.get("track") and fxmod.clean_fx(v.get("fx"))):
            raise ValueError("Nothing to restore")
        if not any(x["vid"] == v["vid"] for x in self.versions):
            self.versions.append(v)
            self.versions.sort(key=lambda x: -(x.get("created") or 0))
            self._save_versions()
        self.emit("versions", {"count": len(self.versions)})

    def rename_version(self, vid: str, title: str):
        for v in self.versions:
            if v["vid"] == vid and title.strip():
                v["title"] = title.strip()
                v["mtime"] = time.time()                      # newest rename wins across machines
        self._save_versions()
        self.emit("versions", {"count": len(self.versions)})

    async def update_settings(self, changes: dict) -> dict:
        before_quality = self.settings.get("quality")
        data = self.settings.update(changes)
        if "normalize" in changes:
            await self._apply_fx(self.current)
        if "quality" in changes and changes["quality"] != before_quality:
            self.yt._stream_cache.clear()
        if "country" in changes:
            self.yt.reload_auth()
        self.emit()
        return data

    # ================================================================ persistence
    def _save(self, force: bool = False):
        self._dirty = False
        self._last_save = time.time()
        offset = max(0, min(self.index - 300, len(self.items) - 1500))
        keep = [{k: v for k, v in i.items() if not k.startswith("_")} for i in self.items[offset:offset + 1500]]
        state = {"items": keep, "index": self.index - offset, "pos": round(self._live_pos(), 1),
                 "shuffle": self.shuffle, "repeat": self.repeat, "context": self.context,
                 "played": self.played_ids[-100:]}
        try:
            config.write_json(config.STATE_FILE, state)
            config.write_json(config.SETTINGS_FILE, self.settings.data)
        except Exception as e:
            log.warning("save failed: %s", e)

    def _restore(self):
        st = config.read_json(config.STATE_FILE, {}) or {}
        items = st.get("items") or []
        for it in items:
            self._qid += 1
            it["qid"] = f"q{self._qid}"
            it.pop("unavailable", None)
        self.items = items
        self.index = st.get("index", -1) if items else -1
        if not (0 <= self.index < len(self.items)):
            self.index = 0 if self.items else -1
        self.pos = float(st.get("pos") or 0)
        self.shuffle = bool(st.get("shuffle"))
        self.repeat = st.get("repeat") or "off"
        self.context = st.get("context")
        self.played_ids = st.get("played") or []
        self.paused = True
        self.loaded = False
        if self.current:
            self.dur = self.current.get("dur") or 0
        if self.repeat == "one":
            self.loop.create_task(self.mpv.set("loop-file", "inf"))
        self.qver += 1
