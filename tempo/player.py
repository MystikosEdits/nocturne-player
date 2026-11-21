"""mpv as a headless audio engine, driven over its JSON IPC (named pipe on Windows, unix socket on macOS)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from typing import Any, Callable

from . import config

log = logging.getLogger("tempo.mpv")


class _Proto(asyncio.Protocol):
    def __init__(self, owner: "Mpv"):
        self.owner = owner
        self.buf = b""
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def data_received(self, data: bytes):
        self.buf += data
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            if line.strip():
                try:
                    self.owner._on_message(json.loads(line))
                except Exception as e:
                    log.debug("bad ipc line %r: %s", line[:200], e)

    def connection_lost(self, exc):
        self.owner._on_lost()


class Mpv:
    """Tiny async mpv client. `on_event(name, data)` gets every mpv event and property change."""

    OBSERVE = ["pause", "idle-active", "duration", "volume", "mute", "paused-for-cache",
               "playlist-pos", "playlist-count", "core-idle", "seeking", "audio-codec-name",
               "audio-params/samplerate", "loop-file"]

    def __init__(self, on_event: Callable[[str, Any], None], silent: bool = False, name: str = "",
                 extra_args: list[str] | None = None, client_name: str = "Nocturne"):
        self.on_event = on_event
        self.silent = silent
        self.name = name                      # "" = the music player, "-bg" = background sounds
        self.extra_args = extra_args or []
        self.client_name = client_name
        self.proc: subprocess.Popen | None = None
        self.proto: _Proto | None = None
        self._rid = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.connected = False
        self.loop: asyncio.AbstractEventLoop | None = None
        self._restarting = False
        self._ready = False       # only report "mpv went away" once it was properly running
        self._stopping = False
        self._job = None
        self.volume = 70

    # ---------------- lifecycle
    def _args(self) -> list[str]:
        a = [
            str(config.mpv_path()),
            "--idle=yes", "--no-video", "--vid=no", "--force-window=no", "--no-terminal", "--no-config",
            f"--input-ipc-server={config.ipc_path(self.name)}",
            "--gapless-audio=yes", "--prefetch-playlist=yes",
            "--ytdl=no", "--audio-display=no", "--keep-open=no", "--replaygain=no",
            f"--volume={self.volume}", "--volume-max=100",
            "--media-controls=no", "--input-media-keys=no", "--input-default-bindings=no",
            # 12 MiB is 6+ minutes of 256 kbps audio; bigger buffers just sat in RAM (287 MB -> ~100 MB on macOS)
            "--cache=yes", "--demuxer-max-bytes=12MiB", "--demuxer-max-back-bytes=4MiB",
            # 0.5 s of audio queued at the sound card (default 0.2 s): rides out CPU spikes (reverb, busy
            # laptop) that showed up as "Audio device underrun" = quarter-second gaps (Nov 20)
            "--audio-buffer=0.5",
            # none of mpv's built-in on-screen scripts are needed for a headless player
            "--load-scripts=no", "--osc=no", "--load-stats-overlay=no", "--load-console=no", "--load-osd-console=no",
            "--load-auto-profiles=no", "--load-select=no", "--load-positioning=no", "--load-commands=no", "--load-context-menu=no",
            "--network-timeout=20", f"--audio-client-name={self.client_name}",
            "--msg-level=all=warn",
            f"--log-file={config.LOGS / f'mpv{self.name}.log'}",
        ] + self.extra_args
        if config.IS_MAC:
            a.append("--macos-app-activation-policy=prohibited")
        if self.silent:
            a.append("--ao=null")
        return a

    async def start(self, volume: int = 70):
        self.loop = asyncio.get_running_loop()
        self.volume = volume
        self._ready = False
        self._stopping = False
        # an mpv left over from a crashed engine would hold the pipe name: ask it to quit first
        if await self._try_connect(attempts=1):
            try:
                await self.command("quit", timeout=2)
            except Exception:
                pass
            await asyncio.sleep(0.6)
        try:
            (config.LOGS / f"mpv{self.name}.log").unlink()
        except Exception:
            pass
        if not config.IS_WIN:
            try:
                os.unlink(config.ipc_path(self.name))
            except FileNotFoundError:
                pass
        flags = 0
        kw: dict[str, Any] = {}
        if config.IS_WIN:
            # CREATE_NO_WINDOW + ABOVE_NORMAL priority: the player must win against farm jobs / Blender,
            # or Windows starves it and the music stutters
            flags = 0x08000000 | 0x00008000
            kw["creationflags"] = flags
        else:
            kw["start_new_session"] = True
        if config.IS_MAC:
            # macOS malloc keeps freed large blocks dirty: mpv sat at ~200 MB instead of ~50 MB without this
            kw["env"] = {**os.environ, "MallocLargeCache": "0"}
        self.proc = subprocess.Popen(self._args(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, **kw)
        if config.IS_WIN:
            self._bind_to_job()
        if not await self._try_connect(attempts=60):
            raise RuntimeError("mpv didn't start")
        for i, prop in enumerate(self.OBSERVE, start=1):
            await self.command("observe_property", i, prop)
        self._ready = True
        log.info("mpv started pid=%s", self.proc.pid)

    def _bind_to_job(self):
        """Windows: put mpv in a job object that closes with us, so a crashed engine never leaves mpv behind."""
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            if self._job is None:
                job = k32.CreateJobObjectW(None, None)

                class BASIC(ctypes.Structure):
                    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

                class IO(ctypes.Structure):
                    _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

                class EXT(ctypes.Structure):
                    _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                                ("PeakJobMemoryUsed", ctypes.c_size_t)]
                info = EXT()
                info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
                self._job = job
            h = k32.OpenProcess(0x1F0FFF, False, self.proc.pid)
            if h:
                k32.AssignProcessToJobObject(self._job, h)
                k32.CloseHandle(h)
        except Exception as e:
            log.debug("job object failed: %s", e)

    async def _try_connect(self, attempts: int) -> bool:
        loop = asyncio.get_running_loop()
        for _ in range(attempts):
            try:
                proto = _Proto(self)
                if config.IS_WIN:
                    transport, _ = await loop.create_pipe_connection(lambda: proto, config.ipc_path(self.name))
                else:
                    transport, _ = await loop.create_unix_connection(lambda: proto, config.ipc_path(self.name))
                proto.transport = transport  # connection_made can land a tick later on Windows
                self.proto = proto
                self.connected = True
                return True
            except (FileNotFoundError, ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        return False

    def _on_lost(self):
        self.connected = False
        for f in self._pending.values():
            if not f.done():
                f.set_exception(ConnectionError("mpv went away"))
        self._pending.clear()
        if self.loop and self._ready and not self._restarting and not self._stopping:
            self._ready = False
            self.loop.call_soon(self.on_event, "mpv-lost", None)

    async def restart(self):
        self._restarting = True
        try:
            await self.shutdown()
            await asyncio.sleep(0.3)
            await self.start(self.volume)
        finally:
            self._restarting = False

    async def shutdown(self):
        self._stopping = True
        try:
            await self.command("quit", timeout=1.5)
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            for _ in range(15):
                await asyncio.sleep(0.1)
                if self.proc.poll() is not None:
                    break
            if self.proc.poll() is None:
                self.proc.kill()

    def kill(self):
        self._stopping = True
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    # ---------------- messages
    def _on_message(self, msg: dict):
        rid = msg.get("request_id")
        if rid is not None and rid in self._pending:
            fut = self._pending.pop(rid)
            if not fut.done():
                if msg.get("error") not in (None, "success"):
                    fut.set_exception(RuntimeError(f"mpv: {msg.get('error')}"))
                else:
                    fut.set_result(msg.get("data"))
            return
        ev = msg.get("event")
        if ev == "property-change":
            self.on_event("prop:" + msg.get("name", ""), msg.get("data"))
        elif ev:
            self.on_event(ev, msg)

    async def command(self, *args, timeout: float = 10) -> Any:
        if not self.connected or not self.proto:
            raise ConnectionError("mpv not connected")
        self._rid += 1
        rid = self._rid
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self.proto.transport.write((json.dumps({"command": list(args), "request_id": rid}) + "\n").encode())
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def get(self, prop: str, default=None):
        try:
            return await self.command("get_property", prop, timeout=3)
        except Exception:
            return default

    async def set(self, prop: str, value):
        return await self.command("set_property", prop, value)

    async def loadfile(self, url: str, mode: str = "replace", options: dict | None = None) -> int | None:
        """Returns mpv's playlist_entry_id for the new entry."""
        opts = ",".join(f"{k}={_escape(v)}" for k, v in (options or {}).items())
        if opts:
            res = await self.command("loadfile", url, mode, -1, opts)
        else:
            res = await self.command("loadfile", url, mode)
        if isinstance(res, dict):
            return res.get("playlist_entry_id")
        return None


def _escape(v) -> str:
    s = str(v)
    if any(c in s for c in ',="\\ '):
        # mpv's key=value list syntax: %<len>% prefix quotes a value exactly
        return f"%{len(s.encode('utf-8'))}%{s}"
    return s
