"""HTTP API + live event stream the window talks to. Bound to 127.0.0.1 only."""
from __future__ import annotations

import asyncio
import logging
import os
import time
import webbrowser

from aiohttp import web

from . import config, yt as ytmod

log = logging.getLogger("tempo.server")
ALLOWED_HOSTS = {f"127.0.0.1:{config.PORT}", f"localhost:{config.PORT}"}


def make_app(app_ctx) -> web.Application:
    eng = app_ctx.engine

    @web.middleware
    async def guard(request, handler):
        # block other websites (DNS rebinding / cross-site POSTs) from driving the player
        if request.host not in ALLOWED_HOSTS:
            return web.Response(status=403, text="forbidden")
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("X-Tempo") != "1":
            return web.Response(status=403, text="forbidden")
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except Exception as e:
            log.exception("API error on %s", request.path)
            return web.json_response({"error": str(e)[:400]}, status=500)

    app = web.Application(middlewares=[guard], client_max_size=40 * 1024 * 1024)   # background image uploads
    r = app.router

    def ok(data=None):
        return web.json_response(data if data is not None else {"ok": True})

    async def body(request) -> dict:
        try:
            return await request.json()
        except Exception:
            return {}

    async def blocking(fn, *a):
        return await eng.run_blocking(fn, *a)

    # ---------------- static UI
    async def index(request):
        resp = web.FileResponse(config.UI_DIR / "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    r.add_get("/", index)
    r.add_static("/ui/", config.UI_DIR, append_version=False)
    r.add_static("/assets/", config.ASSETS, append_version=False)

    @web.middleware
    async def nocache(request, handler):
        resp = await handler(request)
        if request.path.startswith("/ui/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp
    app.middlewares.append(nocache)

    # ---------------- state + events
    async def ping(request):
        # the window process pings with ?window=<pid> every 1.5 s: that (not the page, which Windows
        # freezes while minimized) is what tells the engine a window is open, and carries "come forward"
        show = False
        if request.query.get("window"):
            app_ctx.window_ping = time.time()
            show = app_ctx.take_show()
        return ok({"app": "tempo", "pid": os.getpid(), "window": app_ctx.window_alive(), "show": show})

    async def state(request):
        return ok(eng.snapshot())

    async def events(request):
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                           "X-Accel-Buffering": "no"})
        await resp.prepare(request)
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        eng.subscribers.add(q)
        is_window = request.query.get("shell") == "1"
        if is_window:
            app_ctx.window_queues.add(q)
        try:
            snap = eng.snapshot()
            import json as _j
            await resp.write(b"retry: 1500\n\n")
            await resp.write(f"event: state\ndata: {_j.dumps(snap, ensure_ascii=False)}\n\n".encode())
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), 15)
                except asyncio.TimeoutError:
                    await resp.write(b"event: ping\ndata: {}\n\n")   # lets the page notice a dead stream
                    continue
                await resp.write(msg)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            eng.subscribers.discard(q)
            app_ctx.window_queues.discard(q)
        return resp

    r.add_get("/api/ping", ping)
    r.add_get("/api/state", state)
    r.add_get("/api/events", events)

    # ---------------- playback
    async def cmd(request):
        b = await body(request)
        a = b.get("action")
        v = b.get("value")
        if a == "toggle": await eng.toggle()
        elif a == "play": await eng.play()
        elif a == "pause": await eng.pause()
        elif a == "next": await eng.next()
        elif a == "prev": await eng.prev()
        elif a == "seek": await eng.seek(float(v))
        elif a == "volume": await eng.set_volume(int(v))
        elif a == "mute": await eng.set_mute(bool(v))
        elif a == "shuffle": await eng.set_shuffle(bool(v))
        elif a == "repeat": await eng.set_repeat(str(v))
        elif a == "autoplay": await eng.set_autoplay(bool(v))
        elif a == "sleep":
            if v == "track": await eng.set_sleep(end_of_track=True)
            else: await eng.set_sleep(minutes=float(v) if v else None)
        else:
            return web.json_response({"error": "unknown action"}, status=400)
        return ok(eng.snapshot())

    async def play(request):
        """Play a list of tracks, or something by id (playlist/album/artist/radio/song)."""
        b = await body(request)
        kind = b.get("kind")
        shuffle = b.get("shuffle")
        if b.get("tracks") is not None:
            await eng.play_tracks(b["tracks"], int(b.get("index") or 0), b.get("context"), shuffle)
            return ok()
        id_ = b.get("id")
        if kind in ("song", "video"):
            t = b.get("track") or await blocking(eng.yt.song_meta, id_)
            if not t:
                return web.json_response({"error": "Couldn't find that song"}, status=404)
            await eng.play_single(t)
        elif kind == "playlist":
            p = eng.pl_overlay(await blocking(eng.yt.playlist, id_))
            await eng.play_tracks(p["tracks"], 0, {"type": "playlist", "id": id_, "title": p["title"]}, shuffle)
        elif kind == "album":
            a = await blocking(eng.yt.album, id_)
            await eng.play_tracks(a["tracks"], 0, {"type": "album", "id": a["id"], "title": a["title"]}, shuffle)
        elif kind == "artist":
            a = await blocking(eng.yt.artist, id_)
            if shuffle and a.get("shuffleId"):
                await eng.start_radio(playlist_id=a["shuffleId"], title=f"{a['name']} shuffle")
            elif a.get("radioId") and b.get("radio"):
                await eng.start_radio(playlist_id=a["radioId"], title=f"{a['name']} radio")
            else:
                await eng.play_tracks(a["songs"], 0, {"type": "artist", "id": id_, "title": a["name"]}, shuffle)
        elif kind == "radio":
            await eng.start_radio(video_id=b.get("videoId"), playlist_id=b.get("playlistId"), title=b.get("title") or "Radio")
        elif kind == "offline":
            await eng.play_tracks(app_ctx.offline.list(), int(b.get("index") or 0), {"type": "offline", "id": "offline", "title": "Downloads"}, shuffle)
        elif kind == "versions":
            await eng.play_tracks([eng.version_track(v) for v in eng.versions], int(b.get("index") or 0),
                                  {"type": "versions", "id": "versions", "title": "My versions"}, shuffle)
        else:
            return web.json_response({"error": "unknown kind"}, status=400)
        return ok()

    async def queue_get(request):
        return ok(eng.queue_view())

    async def queue_add(request):
        b = await body(request)
        tracks = b.get("tracks")
        if tracks is None and b.get("kind"):
            kind, id_ = b["kind"], b.get("id")
            if kind == "playlist":
                tracks = eng.pl_overlay(await blocking(eng.yt.playlist, id_))["tracks"]
            elif kind == "album":
                tracks = (await blocking(eng.yt.album, id_))["tracks"]
            elif kind == "artist":
                tracks = (await blocking(eng.yt.artist, id_))["songs"]
        await eng.add(tracks or [], bool(b.get("next")))
        return ok()

    async def queue_op(request):
        b = await body(request)
        op = request.match_info["op"]
        if op == "remove": await eng.remove(b.get("qids") or [b.get("qid")])
        elif op == "move": await eng.move(b["qid"], int(b["to"]))
        elif op == "jump": await eng.jump(b["qid"])
        elif op == "clear": await eng.clear_upcoming()
        else:
            return web.json_response({"error": "unknown op"}, status=400)
        return ok(eng.queue_view())

    async def prefetch(request):
        b = await body(request)
        eng.prefetch([i for i in (b.get("ids") or []) if isinstance(i, str)])
        return ok()

    # ---------------- equalizer + song effects + saved versions
    from . import fx as fxmod

    async def eq_get(request):
        return ok({"eq": eng.settings.get("eq"), "bands": fxmod.EQ_LABELS, "presets": fxmod.EQ_PRESETS})

    async def eq_set(request):
        return ok({"eq": await eng.set_eq(await body(request))})

    async def fx_presets(request):
        return ok({"presets": fxmod.PRESETS})

    async def fx_live(request):
        b = await body(request)
        await eng.set_live_fx(b.get("fx"))
        return ok()

    async def versions_get(request):
        return ok({"items": [eng.version_track(v) for v in eng.versions]})

    async def versions_save(request):
        b = await body(request)
        try:
            v = eng.save_version(b["track"], b.get("fx") or {}, b.get("title"))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        eng.toast(f"Saved “{v['title']}” to My versions")
        return ok({"version": eng.version_track(v)})

    async def versions_delete(request):
        b = await body(request)
        eng.delete_version(b.get("vid", ""))
        return ok()

    async def versions_rename(request):
        b = await body(request)
        eng.rename_version(b.get("vid", ""), b.get("title", ""))
        return ok()

    async def fx_global(request):
        return ok({"global_fx": await eng.set_global_fx(await body(request))})

    from .bg import SOUNDS_FULL as BG_SOUNDS, PRESETS as BG_PRESETS, MAX_LAYERS as BG_MAX

    async def bg_get(request):
        return ok({"state": eng.bg.state(), "sounds": BG_SOUNDS, "presets": BG_PRESETS, "max": BG_MAX})

    async def bg_set(request):
        return ok({"state": await eng.bg.set(await body(request))})

    r.add_post("/api/fx/global", fx_global)
    r.add_get("/api/bg", bg_get)
    r.add_post("/api/bg", bg_set)
    r.add_get("/api/eq", eq_get)
    r.add_post("/api/eq", eq_set)
    r.add_get("/api/fx/presets", fx_presets)
    r.add_post("/api/fx/live", fx_live)
    r.add_get("/api/versions", versions_get)
    r.add_post("/api/versions/save", versions_save)
    r.add_post("/api/versions/delete", versions_delete)
    r.add_post("/api/versions/rename", versions_rename)

    # ---------------- custom background images (Settings -> Appearance)
    async def bg_upload(request):
        import base64
        import hashlib
        b = await body(request)
        data = b.get("data") or ""
        if "," in data:
            data = data.split(",", 1)[1]
        raw = base64.b64decode(data)
        if len(raw) > 25 * 1024 * 1024:
            return web.json_response({"error": "That image is over 25 MB"}, status=400)
        ext = {"image/png": "png", "image/webp": "webp", "image/gif": "gif"}.get(b.get("type"), "jpg")
        name = hashlib.sha1(raw).hexdigest()[:16] + "." + ext
        (config.BACKGROUNDS / name).write_bytes(raw)
        return ok({"url": f"/bg/{name}"})

    async def bg_file(request):
        name = request.match_info["name"]
        p = config.BACKGROUNDS / name
        if "/" in name or "\\" in name or not p.exists():
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Cache-Control": "max-age=31536000"})

    r.add_post("/api/theme/background", bg_upload)
    r.add_get("/bg/{name}", bg_file)

    r.add_post("/api/prefetch", prefetch)
    r.add_post("/api/cmd", cmd)
    r.add_post("/api/play", play)
    r.add_get("/api/queue", queue_get)
    r.add_post("/api/queue/add", queue_add)
    r.add_post("/api/queue/{op}", queue_op)

    # ---------------- browse
    async def home(request):
        return ok({"shelves": await blocking(eng.yt.home), "authed": eng.yt.authed})

    async def explore(request):
        return ok(await blocking(eng.yt.explore))

    async def mood(request):
        return ok({"items": await blocking(eng.yt.mood, request.query["params"])})

    async def search(request):
        q = (request.query.get("q") or "").strip()
        f = request.query.get("filter") or None
        if not q:
            return ok({"shelves": []})
        link = ytmod.parse_link(q)
        if link:
            return ok({"link": link})
        if f == "youtube":
            return ok({"filter": "youtube", "tracks": await blocking(eng.yt.youtube_search, q)})
        return ok(await blocking(eng.yt.search, q, f))

    async def suggest(request):
        q = (request.query.get("q") or "").strip()
        return ok({"items": await blocking(eng.yt.suggest, q) if q else []})

    async def playlist(request):
        return ok(eng.pl_overlay(await blocking(eng.yt.playlist, request.match_info["id"])))

    async def album(request):
        return ok(await blocking(eng.yt.album, request.match_info["id"]))

    async def artist(request):
        return ok(await blocking(eng.yt.artist, request.match_info["id"]))

    async def library(request):
        kind = request.match_info["kind"]
        if kind == "offline":
            return ok({"items": app_ctx.offline.list()})
        return ok({"items": await blocking(eng.yt.library, kind), "authed": eng.yt.authed})

    async def lyrics(request):
        try:
            return ok({"lyrics": await blocking(eng.yt.lyrics, request.match_info["id"])})
        except Exception as e:
            return ok({"lyrics": None, "error": str(e)[:200]})

    async def color(request):
        u = request.query.get("u")
        try:
            return ok({"rgb": await blocking(ytmod.accent_color, u)})
        except Exception:
            return ok({"rgb": None})

    r.add_get("/api/home", home)
    r.add_get("/api/explore", explore)
    r.add_get("/api/mood", mood)
    r.add_get("/api/search", search)
    r.add_get("/api/suggest", suggest)
    r.add_get("/api/playlist/{id}", playlist)
    r.add_get("/api/album/{id}", album)
    r.add_get("/api/artist/{id}", artist)
    r.add_get("/api/library/{kind}", library)
    r.add_get("/api/lyrics/{id}", lyrics)
    r.add_get("/api/color", color)

    # ---------------- account actions
    def need_auth():
        if not eng.yt.authed:
            raise web.HTTPForbidden(text="Connect YouTube Music in Settings first")

    async def like(request):
        need_auth()
        b = await body(request)
        await blocking(eng.yt.rate, b["id"], b.get("status") or "LIKE")
        for it in eng.items:
            if it["id"] == b["id"]:
                it["like"] = b.get("status") or "LIKE"
        eng.emit()
        eng.emit("like", {"id": b["id"], "status": b.get("status") or "LIKE"})
        return ok()

    async def save_album(request):
        need_auth()
        b = await body(request)
        await blocking(eng.yt.rate_album, b["playlistId"], b.get("status") or "LIKE")
        return ok()

    async def subscribe(request):
        need_auth()
        b = await body(request)
        await blocking(eng.yt.subscribe, b["id"], bool(b.get("on", True)))
        return ok()

    async def pl_create(request):
        need_auth()
        b = await body(request)
        tracks = _tracks_of(b)
        plain = list(dict.fromkeys(t["id"] for t in tracks if t.get("id") and not t.get("version_id")))
        pid = await blocking(eng.yt.create_playlist, b.get("title") or "New playlist", plain or None)
        versions = [t for t in tracks if t.get("version_id")]
        if versions:                     # My versions need their own entries (setVideoIds), so they go in after
            for attempt in range(4):     # a playlist made a second ago can refuse edits briefly
                try:
                    await _add_tracks(pid, versions)
                    break
                except Exception:        # noqa: BLE001
                    if attempt == 3:
                        raise
                    await asyncio.sleep(1.2)
        eng.toast(f"Created “{b.get('title') or 'New playlist'}”")
        return ok({"id": pid})

    async def _add_tracks(pid: str, tracks: list[dict]) -> tuple[int, int]:
        """Songs go in once (YouTube skips one already there); each My version goes in as its own entry and is
        remembered as that version. -> (added, already there)"""
        plain = list(dict.fromkeys(t["id"] for t in tracks if t.get("id") and not t.get("version_id")))
        added = skipped = 0
        if plain:
            # YouTube dedupes on its side, but refuses the WHOLE add when any song is already there. Its copy of a
            # playlist lags a few seconds behind edits, so checking our copy first isn't reliable: try the lot, and if
            # it's refused, go one by one (each song already there is refused on its own = skipped)
            try:
                res = await blocking(eng.yt.add_to_playlist, pid, plain)
                added += len(res)
                skipped += len(plain) - len(res)
            except RuntimeError:
                for vid in plain:
                    try:
                        added += len(await blocking(eng.yt.add_to_playlist, pid, [vid]))
                    except RuntimeError:
                        skipped += 1
        for t in tracks:
            if t.get("version_id") and t.get("id"):
                res = await blocking(eng.yt.add_to_playlist, pid, [t["id"]], True)
                if res:
                    eng.link_pl_version(pid, res[0]["setVideoId"], t["version_id"])
                    added += 1
        return added, skipped

    def _tracks_of(b: dict) -> list[dict]:
        return b.get("tracks") or [{"id": i} for i in b.get("videoIds") or []]

    async def pl_add(request):
        need_auth()
        b = await body(request)
        name = b.get("title") or "playlist"
        added, skipped = await _add_tracks(b["playlistId"], _tracks_of(b))
        if added and skipped:
            eng.toast(f"Added {added} to {name} ({skipped} already in it)")
        elif added:
            eng.toast(f"Added to {name}")
        else:
            eng.toast(f"Already in {name}")
        return ok({"added": added, "skipped": skipped})

    async def pl_remove(request):
        need_auth()
        b = await body(request)
        await blocking(eng.yt.remove_from_playlist, b["playlistId"], b["items"])
        eng.unlink_pl_entries(b["playlistId"], [i.get("setVideoId") for i in b["items"] if i.get("setVideoId")])
        return ok()

    async def pl_delete(request):
        need_auth()
        b = await body(request)
        await blocking(eng.yt.delete_playlist, b["playlistId"])
        eng.forget_playlist(b["playlistId"])
        return ok()

    r.add_post("/api/like", like)
    r.add_post("/api/album/save", save_album)
    r.add_post("/api/subscribe", subscribe)
    r.add_post("/api/playlist/create", pl_create)
    r.add_post("/api/playlist/add", pl_add)
    r.add_post("/api/playlist/remove", pl_remove)
    r.add_post("/api/playlist/delete", pl_delete)

    # ---------------- YouTube sign-in
    async def auth_paste(request):
        b = await body(request)
        cookie, authuser = ytmod.cookie_header_from_paste(b.get("text") or "")
        if not cookie:
            return web.json_response({"error": "Couldn't find your YouTube cookies in what you pasted"}, status=400)
        ytmod.save_auth_from_cookie_header(cookie, authuser)
        return await _after_auth()

    async def auth_cookies(request):
        b = await body(request)
        if not ytmod.save_auth_from_cookie_list(b.get("cookies") or []):
            return web.json_response({"error": "Not signed in yet"}, status=400)
        return await _after_auth()

    async def _after_auth():
        eng.yt.reload_auth()
        acct = await blocking(eng.yt.account_info)
        if not acct or not acct.get("name"):
            ytmod.clear_auth()
            eng.yt.reload_auth()
            return web.json_response({"error": "YouTube didn't accept that sign-in. Try again."}, status=400)
        eng.emit()
        eng.toast(f"Signed in as {acct['name']}")
        # check Premium quality in the background
        cur = eng.current
        if cur:
            eng.loop.run_in_executor(eng.pool, lambda: (eng.yt.resolve(cur["id"]), eng.loop.call_soon_threadsafe(eng.emit)))
        return ok({"account": acct})

    async def auth_logout(request):
        ytmod.clear_auth()
        eng.yt.reload_auth()
        eng.emit()
        return ok()

    async def auth_start(request):
        # ask the open window to run the Google sign-in (used by the tray / Claude to retry it)
        msg = b"event: signin\ndata: {}\n\n"
        for q in list(app_ctx.window_queues):
            q.put_nowait(msg)
        return ok({"sent": len(app_ctx.window_queues)})

    r.add_post("/api/auth/youtube/start", auth_start)
    r.add_post("/api/auth/youtube/paste", auth_paste)
    r.add_post("/api/auth/youtube/cookies", auth_cookies)
    r.add_post("/api/auth/youtube/logout", auth_logout)

    # ---------------- settings + misc
    async def settings_get(request):
        return ok({"settings": eng.settings.data, "memory": app_ctx.memory_report(),
                   "version": app_ctx.version, "platform": "mac" if config.IS_MAC else "win",
                   "data_dir": str(config.DATA), "offline": app_ctx.offline.status()})

    async def settings_set(request):
        b = await body(request)
        data = await eng.update_settings(b)
        if "start_at_login" in b:
            app_ctx.set_start_at_login(bool(b["start_at_login"]))
        return ok({"settings": data})

    async def open_url(request):
        b = await body(request)
        url = b.get("url") or ""
        if url.startswith("https://") or url.startswith("http://127.0.0.1"):
            webbrowser.open(url)
        return ok()

    async def copy_text(request):
        return ok()

    r.add_get("/api/settings", settings_get)
    r.add_post("/api/settings", settings_set)
    r.add_post("/api/open", open_url)

    # ---------------- downloads
    async def dl_add(request):
        b = await body(request)
        tracks = b.get("tracks")
        if tracks is None and b.get("kind"):
            if b["kind"] == "playlist":
                tracks = eng.pl_overlay(await blocking(eng.yt.playlist, b["id"]))["tracks"]
            elif b["kind"] == "album":
                tracks = (await blocking(eng.yt.album, b["id"]))["tracks"]
        app_ctx.offline.add(tracks or [])
        return ok(app_ctx.offline.status())

    async def dl_remove(request):
        b = await body(request)
        app_ctx.offline.remove(b.get("ids") or [])
        return ok(app_ctx.offline.status())

    async def dl_status(request):
        return ok(app_ctx.offline.status())

    r.add_post("/api/downloads/add", dl_add)
    r.add_post("/api/downloads/remove", dl_remove)
    r.add_get("/api/downloads", dl_status)

    # ---------------- Spotify import
    sp = app_ctx.spotify

    async def sp_status(request):
        return ok(sp.status())

    async def sp_config(request):
        b = await body(request)
        sp.set_client_id(b.get("client_id") or "")
        return ok(sp.status())

    async def sp_login(request):
        if not sp.data.get("client_id"):
            return web.json_response({"error": "Paste your Spotify Client ID first"}, status=400)
        url = sp.login_url()
        webbrowser.open(url)
        return ok({"url": url})

    async def sp_callback(request):
        if request.query.get("error"):
            return web.Response(text=_page("Spotify sign-in was cancelled", "You can close this tab."), content_type="text/html")
        try:
            await blocking(sp.callback, request.query.get("code", ""), request.query.get("state", ""))
            eng.emit("spotify", sp.status())
            return web.Response(text=_page("Spotify connected", "Go back to Nocturne — you can close this tab."), content_type="text/html")
        except Exception as e:
            return web.Response(text=_page("Spotify sign-in failed", str(e)[:300]), content_type="text/html")

    async def sp_disconnect(request):
        sp.disconnect()
        return ok(sp.status())

    async def sp_playlists(request):
        return ok({"items": await blocking(sp.playlists)})

    async def sp_match(request):
        b = await body(request)
        sp.start_match(b.get("ids") or [], b.get("names") or {})
        return ok(sp.status())

    async def sp_results(request):
        return ok(sp.results or {})

    async def sp_choose(request):
        b = await body(request)
        sp.set_choice(b["list"], int(b["index"]), b.get("track"))
        return ok()

    async def sp_import(request):
        b = await body(request)
        sp.start_import(b.get("ids") or [], bool(b.get("include_unsure")))
        return ok(sp.status())

    async def sp_job(request):
        return ok({"job": sp.job and {**sp.job_view(), "made": sp.job.get("made")}})

    r.add_get("/api/spotify", sp_status)
    r.add_post("/api/spotify/config", sp_config)
    r.add_post("/api/spotify/login", sp_login)
    r.add_get("/spotify/callback", sp_callback)
    r.add_post("/api/spotify/disconnect", sp_disconnect)
    r.add_get("/api/spotify/playlists", sp_playlists)
    r.add_post("/api/spotify/match", sp_match)
    r.add_get("/api/spotify/results", sp_results)
    r.add_post("/api/spotify/choose", sp_choose)
    r.add_post("/api/spotify/import", sp_import)
    r.add_get("/api/spotify/job", sp_job)

    # ---------------- window process <-> engine
    # The window's page holds an event stream open (?shell=1): that's how the engine knows a window
    # exists, and how it asks the window to come to the front.
    async def window_show(request):
        alive = app_ctx.window_alive()
        if alive:
            app_ctx.show_window()
        return ok({"has_window": alive})

    async def window_closed(request):
        if not eng.settings.get("keep_playing_on_close"):
            asyncio.get_running_loop().call_later(0.2, app_ctx.quit)
        return ok()

    async def quit_(request):
        asyncio.get_running_loop().call_later(0.2, app_ctx.quit)
        return ok()

    r.add_post("/api/window/show", window_show)
    r.add_post("/api/window/closed", window_closed)
    r.add_post("/api/quit", quit_)
    return app


def _page(title: str, text: str) -> str:
    return f"""<!doctype html><meta charset=utf-8><title>{title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0e;color:#eee;font:16px -apple-system,Segoe UI,sans-serif">
<div style="text-align:center"><div style="font-size:22px;font-weight:600;margin-bottom:8px">{title}</div><div style="color:#999">{text}</div></div>"""
