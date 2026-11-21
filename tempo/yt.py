"""YouTube Music: browsing (ytmusicapi), stream URLs (yt-dlp), and turning their data into simple dicts for the UI."""
from __future__ import annotations

import io
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any

from ytmusicapi import YTMusic

from . import config

log = logging.getLogger("tempo.yt")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")


# ----------------------------------------------------------------- helpers
def parse_dur(s) -> int | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(s)
    try:
        parts = [int(p) for p in str(s).strip().split(":")]
    except ValueError:
        return None
    sec = 0
    for p in parts:
        sec = sec * 60 + p
    return sec


def best_thumb(thumbs, size: int = 226) -> str | None:
    if not thumbs:
        return None
    if isinstance(thumbs, dict):
        thumbs = thumbs.get("thumbnails") or []
    if isinstance(thumbs, str):
        return resize_thumb(thumbs, size)
    try:
        t = max(thumbs, key=lambda t: (t.get("width") or 0))
    except Exception:
        t = thumbs[-1]
    return resize_thumb(t.get("url"), size)


def resize_thumb(url: str | None, size: int = 226) -> str | None:
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    if "googleusercontent.com" in url or "ggpht.com" in url:
        base = re.split(r"=(w\d+|s\d+)", url)[0]
        return f"{base}=w{size}-h{size}-l90-rj"
    return url


def video_thumb(vid: str) -> str:
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"


def artists_of(d) -> list[dict]:
    arts = d.get("artists") or []
    if isinstance(arts, dict):
        arts = [arts]
    out = []
    for a in arts:
        if not isinstance(a, dict):
            continue
        name = a.get("name")
        if not name or re.search(r"\b(views|plays|subscribers)\b", name, re.I) or re.fullmatch(r"\d{4}", name or ""):
            continue
        out.append({"name": name, "id": a.get("id")})
    if not out:
        for key in ("author", "channel", "uploader", "artist"):
            if d.get(key):
                name = d[key] if isinstance(d[key], str) else d[key].get("name")
                if name:
                    out.append({"name": name, "id": None})
                    break
    return out


def track(d: dict, album: dict | None = None) -> dict | None:
    """Any song/video dict from ytmusicapi -> one shape the UI and the queue use."""
    if not d:
        return None
    vid = d.get("videoId")
    if not vid:
        return None
    artists = artists_of(d)
    alb = d.get("album")
    if isinstance(alb, str):
        alb = {"name": alb, "id": None}
    if not alb and album:
        alb = {"name": album.get("title"), "id": album.get("browseId") or album.get("id")}
    if alb and not alb.get("name"):
        alb = None
    dur = d.get("duration_seconds") or parse_dur(d.get("duration") or d.get("length"))
    thumbs = d.get("thumbnails") or d.get("thumbnail") or (album or {}).get("thumbnails")
    vt = d.get("videoType") or ""
    rt = d.get("resultType")
    if rt == "video" or vt in ("MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC", "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC"):
        kind = "video"
    else:
        kind = "song"
    thumb = best_thumb(thumbs) if thumbs else video_thumb(vid)
    t = {
        "id": vid,
        "title": d.get("title") or "Unknown",
        "artists": artists,
        "artist": ", ".join(a["name"] for a in artists),
        "album": alb,
        "dur": dur,
        "thumb": thumb,
        "explicit": bool(d.get("isExplicit")),
        "type": kind,
    }
    if d.get("likeStatus"):
        t["like"] = d["likeStatus"]
    if d.get("setVideoId"):
        t["setVideoId"] = d["setVideoId"]
    if d.get("isAvailable") is False:
        t["unavailable"] = True
    if d.get("views"):
        t["views"] = d["views"]
    return t


def tracks(items, album=None) -> list[dict]:
    out = []
    for d in items or []:
        t = track(d, album)
        if t:
            out.append(t)
    return out


def card(d: dict) -> dict | None:
    """A playlist / album / artist / song tile."""
    if not d:
        return None
    bid = d.get("browseId") or ""
    if not bid and (d.get("resultType") == "artist") and isinstance(d.get("artists"), list) and d["artists"]:
        bid = d["artists"][0].get("id") or ""
        d = {**d, "artist": d.get("artist") or d["artists"][0].get("name")}
    pid = d.get("playlistId") or d.get("audioPlaylistId")
    title = d.get("title") or d.get("artist") or d.get("name") or ""
    thumb = best_thumb(d.get("thumbnails") or d.get("thumbnail"), 400)
    rt = (d.get("resultType") or d.get("type") or "").lower()
    if d.get("videoId") and not bid and rt not in ("playlist", "album"):
        t = track(d)
        if t:
            t["kind"] = t["type"]
            return t
    if bid.startswith("MPRE") or rt in ("album", "single", "ep") or d.get("type") in ("Album", "Single", "EP"):
        arts = artists_of(d)
        sub = " • ".join(x for x in [d.get("type") or "Album", ", ".join(a["name"] for a in arts), str(d.get("year") or "")] if x)
        return {"kind": "album", "id": bid or pid, "title": title, "sub": sub, "thumb": thumb, "artists": arts}
    if bid.startswith("UC") or rt == "artist" or (bid and d.get("subscribers") is not None):
        sub = d.get("subscribers")
        return {"kind": "artist", "id": bid, "title": d.get("artist") or title, "sub": (f"{sub} subscribers" if sub and "sub" not in str(sub) else (sub or "Artist")), "thumb": thumb, "round": True}
    if pid or bid.startswith("VL") or rt == "playlist":
        pid = pid or (bid[2:] if bid.startswith("VL") else bid)
        sub = d.get("description") or d.get("author") or ""
        if isinstance(sub, list):
            sub = ", ".join(a.get("name", "") for a in sub if isinstance(a, dict))
        if isinstance(sub, dict):
            sub = sub.get("name", "")
        if not sub and d.get("count"):
            sub = f"{d['count']} songs"
        return {"kind": "playlist", "id": pid, "title": title, "sub": sub or "Playlist", "thumb": thumb}
    if bid.startswith("MPSP"):
        return {"kind": "podcast", "id": bid, "title": title, "sub": "Podcast", "thumb": thumb}
    return None


def shelf(title: str, items, **extra) -> dict | None:
    out = [c for c in (card(i) for i in items or []) if c]
    if not out:
        return None
    is_tracks = all(c.get("kind") in ("song", "video") for c in out)
    return {"title": title, "type": "tracks" if is_tracks else "cards", "items": out, **extra}


# ----------------------------------------------------------------- auth
def cookie_header_from_paste(text: str) -> tuple[str | None, str]:
    """Pull a Cookie header (and X-Goog-AuthUser) out of whatever the user pasted:
    raw request headers, 'Copy as cURL', or just the cookie string."""
    text = text.strip()
    authuser = "0"
    m = re.search(r"x-goog-authuser['\"]?\s*[:=]\s*['\"]?(\d+)", text, re.I)
    if m:
        authuser = m.group(1)
    for pat in (r"-H\s+['\"]cookie:\s*([^'\"]+)['\"]", r"-b\s+['\"]([^'\"]+)['\"]",
                r"(?im)^\s*cookie\s*[:\n]\s*(.+)$", r"\"cookie\"\s*:\s*\"([^\"]+)\""):
        m = re.search(pat, text, re.I)
        if m:
            return m.group(1).strip(), authuser
    if "SAPISID=" in text or "__Secure-3PAPISID=" in text:
        return text.replace("\n", " ").strip(), authuser
    return None, authuser


_KEY_COOKIES = ["__Secure-3PAPISID", "SAPISID", "__Secure-1PAPISID", "APISID", "HSID", "SSID", "SID",
                "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS", "LOGIN_INFO", "PREF"]


def _clean_cookies(cookie: str) -> str:
    """ytmusicapi reads the header with http.cookies.SimpleCookie, and on Python 3.13 one value it
    dislikes (a space, a quote...) makes it return NOTHING, so __Secure-3PAPISID 'goes missing'.
    Keep only cookies SimpleCookie accepts, sign-in cookies first."""
    from http.cookies import SimpleCookie

    def parses(parts):
        # exactly what ytmusicapi does: strip quotes, load the whole header, every key must come back
        c = SimpleCookie()
        try:
            c.load("; ".join(parts).replace('"', ""))
        except Exception:
            return False
        return all(p.split("=", 1)[0] in c for p in parts)

    key = {n: i for i, n in enumerate(_KEY_COOKIES)}
    cand = [p.strip() for p in cookie.split(";") if "=" in p]
    cand.sort(key=lambda p: key.get(p.split("=", 1)[0], len(key)))
    kept = []
    for p in cand:
        if parses(kept + [p]):
            kept.append(p)
    return "; ".join(kept)


def save_auth_from_cookie_header(cookie: str, authuser: str = "0") -> None:
    write_cookies_txt(cookie)              # yt-dlp gets every cookie
    cookie = _clean_cookies(cookie)
    headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        # ytmusicapi only treats headers as a browser sign-in when an authorization header with
        # SAPISIDHASH is present (without it: "oauth JSON provided ... oauth_credentials not provided").
        # It recomputes the real value from __Secure-3PAPISID on every request, so a placeholder is fine.
        "authorization": "SAPISIDHASH 0_0",
        "content-type": "application/json",
        "cookie": cookie,
        "origin": "https://music.youtube.com",
        "user-agent": UA,
        "x-goog-authuser": authuser,
        "x-origin": "https://music.youtube.com",
    }
    config.write_json(config.YT_AUTH, headers)


def save_auth_from_cookie_list(cookies: list[dict]) -> bool:
    """cookies = [{name, value, domain}] read out of the sign-in window."""
    yt = {}
    for c in cookies:
        dom = (c.get("domain") or "").lstrip(".")
        if dom.endswith("youtube.com"):
            yt[c["name"]] = c["value"]
    if "__Secure-3PAPISID" not in yt:
        if "SAPISID" not in yt:
            return False
        yt["__Secure-3PAPISID"] = yt["SAPISID"]  # same value; ytmusicapi requires this name
    save_auth_from_cookie_header("; ".join(f"{k}={v}" for k, v in yt.items()))
    return True


def write_cookies_txt(cookie: str) -> None:
    exp = int(time.time()) + 365 * 86400
    lines = ["# Netscape HTTP Cookie File"]
    for part in cookie.split(";"):
        if "=" not in part:
            continue
        name, value = part.strip().split("=", 1)
        if not name:
            continue
        lines.append("\t".join([".youtube.com", "TRUE", "/", "TRUE", str(exp), name, value]))
    with open(config.YT_COOKIES, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def clear_auth() -> None:
    for p in (config.YT_AUTH, config.YT_COOKIES):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


# ----------------------------------------------------------------- the client
class YT:
    def __init__(self, settings: config.Settings):
        self.settings = settings
        self._local = threading.local()
        self._gen = 0                    # bumps when auth changes so threads rebuild clients
        self.account: dict | None = None
        self.premium: bool | None = None
        self._stream_cache: dict[str, dict] = {}
        self._cache: dict[str, tuple[float, Any]] = {}
        self._refreshing: set[str] = set()
        self._quick_blocked_until = 0.0
        self._lock = threading.Lock()
        self.authed = config.YT_AUTH.exists()

    # one YTMusic per thread (requests sessions aren't thread safe)
    @property
    def api(self) -> YTMusic:
        loc = self._local
        if getattr(loc, "gen", -1) != self._gen or getattr(loc, "api", None) is None:
            if self.authed:
                try:
                    loc.api = YTMusic(str(config.YT_AUTH), language="en", location=self.settings.get("country") or "US")
                    self._remember_visitor(loc.api)
                except Exception as e:  # broken auth file -> fall back to signed out
                    log.warning("auth load failed: %s", e)
                    loc.api = YTMusic(language="en", location=self.settings.get("country") or "US")
            else:
                loc.api = YTMusic(language="en", location=self.settings.get("country") or "US")
            loc.gen = self._gen
        return loc.api

    def _remember_visitor(self, api: YTMusic):
        """ytmusicapi fetches a visitor id once per instance (one per worker thread) unless the saved
        headers already have it: store it after the first fetch."""
        try:
            saved = config.read_json(config.YT_AUTH, {}) or {}
            if any(k.lower() == "x-goog-visitor-id" for k in saved):
                return
            vid = api.base_headers.get("X-Goog-Visitor-Id")
            if vid:
                saved["X-Goog-Visitor-Id"] = vid
                config.write_json(config.YT_AUTH, saved)
        except Exception:
            pass

    def reload_auth(self):
        self.authed = config.YT_AUTH.exists()
        self._gen += 1
        self.account = None
        self.premium = None
        self._stream_cache.clear()
        self._cache.clear()

    def cached(self, key: str, ttl: float, fn, persist: bool = False):
        """Memory cache; with persist=True also a disk copy, served instantly (even right after a
        restart) while a fresh copy loads in the background ("stale while revalidate")."""
        now = time.time()
        hit = self._cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        if persist:
            if hit is None:
                disk = config.read_json(self._disk_path(key), None)
                if disk and now - disk.get("t", 0) < 3 * 86400:
                    self._cache[key] = (disk["t"], disk["v"])
                    hit = self._cache[key]
            if hit is not None:
                self._refresh_bg(key, fn)
                return hit[1]
        val = fn()
        self._store(key, val, persist)
        return val

    def _store(self, key, val, persist):
        self._cache[key] = (time.time(), val)
        if persist:
            try:
                config.write_json(self._disk_path(key), {"t": time.time(), "v": val})
            except Exception:
                pass

    def _refresh_bg(self, key, fn):
        with self._lock:
            if key in self._refreshing:
                return
            self._refreshing.add(key)

        def run():
            try:
                self._store(key, fn(), True)
            except Exception as e:
                log.info("background refresh %s failed: %s", key, e)
            finally:
                self._refreshing.discard(key)
        threading.Thread(target=run, daemon=True, name="tempo-refresh").start()

    def _disk_path(self, key: str):
        tag = "a" + str(int(config.YT_AUTH.stat().st_mtime)) if self.authed and config.YT_AUTH.exists() else "anon"
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", key)[:120]
        return config.CACHE / "api" / f"{safe}__{tag}.json"

    def invalidate(self, prefix: str):
        for k in list(self._cache):
            if k.startswith(prefix):
                self._cache.pop(k, None)
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", prefix)
        for p in (config.CACHE / "api").glob(f"{safe}*"):
            try:
                p.unlink()
            except Exception:
                pass

    # ---------------- account
    def account_info(self) -> dict | None:
        if not self.authed:
            return None
        if self.account is None:
            try:
                a = self.api.get_account_info()
                self.account = {"name": a.get("accountName"), "handle": a.get("channelHandle"),
                                "photo": resize_thumb(a.get("accountPhotoUrl"), 88)}
            except Exception as e:
                log.warning("account info failed: %s", e)
                self.account = {"name": None, "error": str(e)[:200]}
        return self.account

    # ---------------- browse
    def home(self) -> list[dict]:
        def load():
            rows = self.api.get_home(limit=12)
            out = []
            for r in rows:
                s = shelf(r.get("title") or "", r.get("contents"))
                if s:
                    out.append(s)
            return out
        return self.cached("home", 600, load, persist=True)

    def explore(self) -> dict:
        def load():
            e = self.api.get_explore()
            shelves = []
            if e.get("new_releases"):
                s = shelf("New releases", e["new_releases"])
                if s: shelves.append(s)
            for key, title in (("top_songs", "Top songs"), ("trending", "Trending")):
                block = e.get(key) or {}
                s = shelf(title, block.get("items"), playlist=block.get("playlist"))
                if s: shelves.append(s)
            if e.get("new_videos"):
                s = shelf("New music videos", e["new_videos"])
                if s: shelves.append(s)
            moods = []
            try:
                cats = self.api.get_mood_categories()
                for group, items in cats.items():
                    moods.append({"title": group, "items": [{"title": i["title"], "params": i["params"]} for i in items]})
            except Exception as ex:
                log.warning("moods failed: %s", ex)
            return {"shelves": shelves, "moods": moods}
        return self.cached("explore", 1800, load, persist=True)

    def mood(self, params: str) -> list[dict]:
        return self.cached("mood:" + params, 1800,
                           lambda: [c for c in (card(p) for p in self.api.get_mood_playlists(params)) if c])

    def search(self, q: str, filt: str | None = None) -> dict:
        def load():
            if filt:
                res = self.api.search(q, filter=filt, limit=40)
                if filt in ("songs", "videos"):
                    return {"filter": filt, "tracks": tracks(res)}
                return {"filter": filt, "cards": [c for c in (card(r) for r in res) if c]}
            res = self.api.search(q, limit=20)
            top, groups = None, {}
            names = {"song": "Songs", "video": "Videos", "artist": "Artists", "album": "Albums", "playlist": "Playlists"}
            for r in res:
                if r.get("category") == "Top result" and top is None:
                    c = card(r)
                    if c:
                        top = c
                    continue
                cat = names.get(r.get("resultType") or "")
                if not cat:
                    continue
                c = card(r)
                if not c or (top and c.get("id") == top.get("id")):
                    continue
                groups.setdefault(cat, []).append(c)
            order = ["Songs", "Videos", "Artists", "Albums", "Playlists"]
            out = []
            for cat in order:
                items = groups.get(cat)
                if not items:
                    continue
                is_tracks = all(i.get("kind") in ("song", "video") for i in items)
                out.append({"title": cat, "type": "tracks" if is_tracks else "cards", "items": items})
            return {"top": top, "shelves": out}
        return self.cached(f"search:{filt}:{q}", 300, load)

    def suggest(self, q: str) -> list[str]:
        try:
            return self.api.get_search_suggestions(q)[:8]
        except Exception:
            return []

    def youtube_search(self, q: str) -> list[dict]:
        """Anything on YouTube, not just YouTube Music's catalog."""
        def load():
            import yt_dlp
            loc = self._local
            if getattr(loc, "ysearch", None) is None:
                loc.ysearch = yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "skip_download": True})
            info = loc.ysearch.extract_info(f"ytsearch30:{q}", download=False)
            out = []
            for e in info.get("entries") or []:
                if not e.get("id") or e.get("ie_key") not in (None, "Youtube"):
                    continue
                if (e.get("duration") or 0) > 4 * 3600:
                    continue
                out.append({
                    "id": e["id"], "title": e.get("title") or "", "artists": [{"name": e.get("channel") or e.get("uploader") or "", "id": e.get("channel_id")}],
                    "artist": e.get("channel") or e.get("uploader") or "", "album": None, "dur": int(e["duration"]) if e.get("duration") else None,
                    "thumb": video_thumb(e["id"]), "explicit": False, "type": "video",
                    "views": f"{e['view_count']:,} views" if e.get("view_count") else None,
                })
            return out
        return self.cached("ytsearch:" + q, 600, load)

    def playlist(self, pid: str) -> dict:
        def load():
            p = None
            # A playlist made seconds ago (or still empty) comes back from YouTube without its page
            # layout and ytmusicapi raises KeyError 'contents'. Give YouTube a moment, then fall back
            # to an empty playlist instead of an error page.
            for attempt in range(4):
                try:
                    p = self.api.get_playlist(pid, limit=None)
                    break
                except KeyError:
                    if attempt < 3:
                        time.sleep(1.2)
            if p is None:
                known = next((c for c in (self._cache.get("lib:playlists") or (0, []))[1] if c.get("id") == pid), None)
                return {"kind": "playlist", "id": pid, "title": (known or {}).get("title") or "New playlist",
                        "thumb": None, "desc": "", "author": "", "year": None, "count": 0, "duration": None,
                        "owned": True, "tracks": [], "_placeholder": True}
            author = p.get("author")
            if isinstance(author, dict):
                author = author.get("name")
            elif isinstance(author, list):
                author = ", ".join(a.get("name", "") for a in author)
            return {
                "kind": "playlist", "id": pid, "title": p.get("title") or ("Liked music" if pid == "LM" else "Playlist"),
                "thumb": best_thumb(p.get("thumbnails"), 544), "desc": p.get("description") or "",
                "author": author or "", "year": p.get("year"), "count": p.get("trackCount"),
                "duration": p.get("duration"), "owned": bool(p.get("owned")) or pid == "LM",
                "tracks": tracks(p.get("tracks")),
            }
        res = self.cached("pl:" + pid, 120, load, persist=True)
        if res.get("_placeholder"):
            self.invalidate("pl:" + pid)   # never keep the stand-in: fetch the real one next time
        return res

    def album(self, bid: str) -> dict:
        def load():
            if not bid.startswith("MPRE"):
                real = self.api.get_album_browse_id(bid)
            else:
                real = bid
            a = self.api.get_album(real)
            arts = artists_of(a)
            return {
                "kind": "album", "id": real, "title": a.get("title"), "type": a.get("type") or "Album",
                "thumb": best_thumb(a.get("thumbnails"), 544), "desc": a.get("description") or "",
                "artists": arts, "year": a.get("year"), "count": a.get("trackCount"), "duration": a.get("duration"),
                "playlistId": a.get("audioPlaylistId"), "like": a.get("likeStatus"),
                "tracks": tracks(a.get("tracks"), {"title": a.get("title"), "browseId": real, "thumbnails": a.get("thumbnails")}),
                "versions": [c for c in (card(v) for v in a.get("other_versions") or []) if c],
            }
        return self.cached("al:" + bid, 900, load, persist=True)

    def artist(self, cid: str) -> dict:
        def load():
            try:
                a = self.api.get_artist(cid)
            except KeyError:
                # an ordinary uploader's channel (e.g. someone posting unreleased songs), not an artist page:
                # ytmusicapi's artist reader can't parse it (KeyError musicImmersiveHeaderRenderer) -> show it as a user
                return self._user_page(cid)
            out = {
                "kind": "artist", "id": cid, "name": a.get("name"), "desc": a.get("description") or "",
                "thumb": best_thumb(a.get("thumbnails"), 1200), "subscribers": a.get("subscribers"),
                "subscribed": a.get("subscribed"), "radioId": a.get("radioId"), "shuffleId": a.get("shuffleId"),
                "views": a.get("views"), "channelId": a.get("channelId") or cid,
            }
            songs = a.get("songs") or {}
            out["songs"] = tracks(songs.get("results"))
            out["songsPlaylist"] = songs.get("browseId")
            shelves = []
            for key, title in (("albums", "Albums"), ("singles", "Singles & EPs"), ("videos", "Videos"),
                               ("playlists", "Featured on"), ("related", "Fans also like")):
                block = a.get(key) or {}
                s = shelf(title, block.get("results"))
                if s:
                    shelves.append(s)
            out["shelves"] = shelves
            return out
        return self.cached("ar:" + cid, 900, load, persist=True)

    def _user_page(self, cid: str) -> dict:
        u = self.api.get_user(cid)
        vids = (u.get("videos") or {}).get("results") or []
        shelves = []
        for key, title in (("videos", "Uploads"), ("playlists", "Playlists")):
            s = shelf(title, (u.get(key) or {}).get("results"))
            if s:
                shelves.append(s)
        thumb = None
        for block in (u.get("playlists"), u.get("videos")):
            res = (block or {}).get("results") or []
            if res and not thumb:
                thumb = best_thumb(res[0].get("thumbnails"), 1200)
        return {"kind": "artist", "id": cid, "name": u.get("name") or "Channel", "desc": "", "thumb": thumb,
                "subscribers": None, "subscribed": None, "radioId": None, "shuffleId": None, "views": None,
                "channelId": cid, "songs": tracks(vids), "songsPlaylist": None, "shelves": shelves, "user": True}

    def library(self, kind: str) -> list[dict]:
        if not self.authed:
            return []
        def load():
            if kind == "playlists":
                return [c for c in (card(p) for p in self.api.get_library_playlists(limit=None)) if c]
            if kind == "albums":
                return [c for c in (card(p) for p in self.api.get_library_albums(limit=None)) if c]
            if kind == "artists":
                res = self.api.get_library_subscriptions(limit=None)
                out = []
                for r in res:
                    r = dict(r)
                    r.setdefault("resultType", "artist")
                    c = card(r)
                    if c:
                        out.append(c)
                return out
            if kind == "history":
                return tracks(self.api.get_history())
            return []
        return self.cached("lib:" + kind, 60 if kind == "history" else 180, load, persist=kind != "history")

    def lyrics(self, vid: str) -> dict | None:
        def load():
            wp = self.api.get_watch_playlist(videoId=vid, limit=1)
            bid = wp.get("lyrics")
            if not bid:
                return None
            try:
                ly = self.api.get_lyrics(bid, timestamps=True)
            except Exception:
                ly = self.api.get_lyrics(bid)
            if not ly:
                return None
            lines = ly.get("lyrics") if isinstance(ly, dict) else getattr(ly, "lyrics", None)
            source = ly.get("source") if isinstance(ly, dict) else getattr(ly, "source", None)
            timed = ly.get("hasTimestamps") if isinstance(ly, dict) else getattr(ly, "hasTimestamps", False)
            if timed and isinstance(lines, list):
                out = []
                for ln in lines:
                    text = ln.get("text") if isinstance(ln, dict) else getattr(ln, "text", "")
                    start = ln.get("start_time") if isinstance(ln, dict) else getattr(ln, "start_time", 0)
                    out.append({"t": (start or 0) / 1000.0, "text": text or ""})
                return {"timed": True, "lines": out, "source": source}
            if isinstance(lines, str):
                return {"timed": False, "lines": [{"t": None, "text": l} for l in lines.split("\n")], "source": source}
            return None
        return self.cached("ly:" + vid, 3600, load)

    def radio(self, video_id: str | None = None, playlist_id: str | None = None, limit: int = 50) -> list[dict]:
        if playlist_id:
            wp = self.api.get_watch_playlist(playlistId=playlist_id, limit=limit, radio=True)
        else:
            wp = self.api.get_watch_playlist(videoId=video_id, limit=limit, radio=True)
        return tracks(wp.get("tracks"))

    def song_meta(self, vid: str) -> dict | None:
        """Track info for a bare video id (pasted links)."""
        try:
            wp = self.api.get_watch_playlist(videoId=vid, limit=1)
            for t in tracks(wp.get("tracks")):
                if t["id"] == vid:
                    return t
        except Exception:
            pass
        try:
            s = self.api.get_song(vid).get("videoDetails") or {}
            return {"id": vid, "title": s.get("title") or vid, "artists": [{"name": s.get("author") or "", "id": s.get("channelId")}],
                    "artist": s.get("author") or "", "album": None, "dur": parse_dur(s.get("lengthSeconds")),
                    "thumb": best_thumb((s.get("thumbnail") or {}).get("thumbnails")) or video_thumb(vid),
                    "explicit": False, "type": "video"}
        except Exception:
            return None

    # ---------------- account actions
    def rate(self, vid: str, status: str):
        from ytmusicapi.models.content.enums import LikeStatus
        self.api.rate_song(vid, LikeStatus(status))
        self.invalidate("pl:LM")

    def rate_album(self, playlist_id: str, status: str):
        from ytmusicapi.models.content.enums import LikeStatus
        self.api.rate_playlist(playlist_id, LikeStatus(status))
        self.invalidate("lib:")

    def subscribe(self, channel_id: str, on: bool):
        if on:
            self.api.subscribe_artists([channel_id])
        else:
            self.api.unsubscribe_artists([channel_id])
        self.invalidate("lib:artists")
        self.invalidate("ar:" + channel_id)

    def create_playlist(self, title: str, video_ids: list[str] | None = None, desc: str = "") -> str:
        pid = self.api.create_playlist(title, desc, privacy_status="PRIVATE", video_ids=video_ids or None)
        self.invalidate("lib:playlists")
        return pid if isinstance(pid, str) else (pid or {}).get("playlistId")

    def add_to_playlist(self, pid: str, video_ids: list[str], duplicates: bool = False) -> list[dict]:
        """-> [{videoId, setVideoId}] for the entries really added. With duplicates=False YouTube silently SKIPS a song
        already in the playlist (no error), so the caller can tell "added" from "already there"."""
        res = self.api.add_playlist_items(pid, video_ids, duplicates=duplicates)
        self.invalidate("pl:" + pid)
        if not isinstance(res, dict) or "SUCCEEDED" not in str(res.get("status", "")):
            raise RuntimeError("YouTube didn't accept that change")
        return [r for r in (res.get("playlistEditResults") or []) if isinstance(r, dict) and r.get("setVideoId")]

    def remove_from_playlist(self, pid: str, items: list[dict]):
        res = self.api.remove_playlist_items(pid, [{"videoId": i["id"], "setVideoId": i["setVideoId"]} for i in items if i.get("setVideoId")])
        self.invalidate("pl:" + pid)
        return res

    def delete_playlist(self, pid: str):
        self.api.delete_playlist(pid)
        self.invalidate("lib:playlists")

    def log_play(self, vid: str):
        if not self.authed:
            return
        try:
            song = self.api.get_song(vid)
            self.api.add_history_item(song)
        except Exception as e:
            log.info("history log failed for %s: %s", vid, e)

    # ---------------- streams
    def _ydl(self, clients, use_cookies: bool, fmt: str):
        """One long-lived yt-dlp per thread + setup. Building a new one per song costs seconds
        (it re-probes the JS runtime and reopens connections)."""
        import yt_dlp
        loc = self._local
        if getattr(loc, "ydl_gen", -1) != self._gen:
            loc.ydls = {}
            loc.ydl_gen = self._gen
        key = (tuple(clients or ()), use_cookies, fmt)
        y = loc.ydls.get(key)
        if y is None:
            opts = {
                "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
                "format": fmt, "cachedir": str(config.CACHE / "ytdlp"),
                "extractor_args": {"youtube": {"skip": ["hls", "translated_subs"]}},
            }
            if clients:
                opts["extractor_args"]["youtube"]["player_client"] = list(clients)
            if use_cookies:
                opts["cookiefile"] = str(config.YT_COOKIES)
            deno = _deno_path()
            if deno:
                # signed-in clients need YouTube's JS challenge solved; don't depend on PATH to find deno
                opts["js_runtimes"] = {"deno": {"path": deno}}
            y = yt_dlp.YoutubeDL(opts)
            loc.ydls[key] = y
        return y

    def prefetch(self, vid: str):
        """Hover: grab the quick stream first (so a click starts at once), then the Premium one."""
        try:
            self.resolve(vid, fast=True)
            if self.wants_premium():
                self.resolve(vid)
        except Exception:
            pass

    def wants_premium(self) -> bool:
        return self.authed and config.YT_COOKIES.exists() and self.settings.get("quality") == "best"

    def has_premium(self, vid: str) -> bool:
        hit = self._stream_cache.get(vid)
        return bool(hit and hit.get("premium") and hit["expires"] - 300 > time.time())

    def resolve(self, vid: str, fast: bool = False) -> dict:
        """Direct audio URL for a video id, cached until shortly before YouTube expires it.
        fast=True: the quick unsigned stream (~1-2 s, ~130 kbps) for songs you just clicked.
        fast=False: Premium 256 kbps via your account (~5 s) for songs queued up ahead."""
        now = time.time()
        hit = self._stream_cache.get(vid)
        if hit and hit["expires"] - 300 > now and (fast or hit.get("premium") or not self.wants_premium()):
            return hit
        quality = self.settings.get("quality")
        quick = (["visionos"], False, "251/140/bestaudio" if quality != "normal" else "140/251/bestaudio")
        attempts = []
        if self.wants_premium() and not fast:
            attempts.append((["web_music"], True, "774/141/251/140/bestaudio"))
        # YouTube sometimes answers the unsigned quick route with "confirm you're not a bot": after that,
        # skip it for 10 minutes instead of wasting ~1 s per song on a refusal
        if time.time() >= self._quick_blocked_until or not (self.authed and config.YT_COOKIES.exists()):
            attempts.append(quick)
        if self.authed and config.YT_COOKIES.exists():
            attempts.append((["web_music", "default"], True, "251/140/bestaudio/best"))
        attempts.append((None, False, "bestaudio/best"))
        last = None
        for clients, use_cookies, fmt in attempts:
            url = (f"https://music.youtube.com/watch?v={vid}" if use_cookies else f"https://www.youtube.com/watch?v={vid}")
            t0 = time.time()
            try:
                info = self._ydl(clients, use_cookies, fmt).extract_info(url, download=False)
            except Exception as e:
                last = e
                log.info("resolve %s via %s failed: %s", vid, clients, str(e).splitlines()[0][:160])
                if clients == ["visionos"] and "not a bot" in str(e):
                    self._quick_blocked_until = time.time() + 600
                continue
            stream = info.get("url")
            if not stream:
                continue
            q = urllib.parse.parse_qs(urllib.parse.urlparse(stream).query)
            expires = int((q.get("expire") or [now + 3 * 3600])[0])
            fid = str(info.get("format_id") or "")
            if clients == ["web_music"]:
                self.premium = fid in ("774", "141") or self.premium
            res = {
                "premium": fid in ("774", "141"),
                "url": stream, "headers": info.get("http_headers") or {}, "format": fid,
                "codec": info.get("acodec"), "abr": round(info.get("abr") or 0), "expires": expires,
                "client": ",".join(clients or ["default"]), "took": round(time.time() - t0, 2),
                "duration": info.get("duration"), "loudness": None,
            }
            prev = self._stream_cache.get(vid)
            if not (prev and prev.get("premium") and not res["premium"] and prev["expires"] - 300 > now):
                self._stream_cache[vid] = res   # never replace a Premium stream with a quick one
            if len(self._stream_cache) > 400:
                for k in sorted(self._stream_cache, key=lambda k: self._stream_cache[k]["expires"])[:100]:
                    self._stream_cache.pop(k, None)
            log.info("resolved %s fmt=%s %skbps via %s in %.2fs", vid, fid, res["abr"], res["client"], res["took"])
            return res
        raise RuntimeError(f"Couldn't get audio for this track ({str(last).splitlines()[0][:120] if last else 'no stream'})")


def _deno_path() -> str | None:
    import shutil
    for p in (config.ROOT / ".venv" / "Scripts" / "deno.exe", config.ROOT / ".venv" / "bin" / "deno"):
        if p.exists():
            return str(p)
    return shutil.which("deno")


# ----------------------------------------------------------------- links
def parse_link(text: str) -> dict | None:
    text = text.strip()
    if not re.match(r"^(https?://)?([\w-]+\.)*(youtube\.com|youtu\.be)/", text, re.I):
        return None
    if not text.startswith("http"):
        text = "https://" + text
    u = urllib.parse.urlparse(text)
    q = urllib.parse.parse_qs(u.query)
    if "youtu.be" in u.netloc:
        vid = u.path.strip("/").split("/")[0]
        return {"kind": "song", "id": vid}
    if u.path.startswith("/shorts/"):
        return {"kind": "song", "id": u.path.split("/")[2]}
    if u.path.startswith("/browse/"):
        bid = u.path.split("/")[2]
        if bid.startswith("MPRE"):
            return {"kind": "album", "id": bid}
        if bid.startswith("VL"):
            return {"kind": "playlist", "id": bid[2:]}
        return {"kind": "artist", "id": bid}
    if u.path.startswith("/channel/"):
        return {"kind": "artist", "id": u.path.split("/")[2]}
    if q.get("v"):
        return {"kind": "song", "id": q["v"][0]}
    if q.get("list"):
        lid = q["list"][0]
        if lid.startswith("OLAK5uy"):
            return {"kind": "album", "id": lid}
        return {"kind": "playlist", "id": lid}
    return None


# ----------------------------------------------------------------- colours
_color_cache: dict[str, list[int]] = {}


def accent_color(url: str) -> list[int]:
    """A pleasant accent colour from cover art, tuned to read well on a dark UI."""
    if url in _color_cache:
        return _color_cache[url]
    from PIL import Image
    import colorsys
    small = resize_thumb(url, 64) if url else url
    req = urllib.request.Request(small, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=8) as r:
        img = Image.open(io.BytesIO(r.read())).convert("RGB").resize((24, 24))
    best, best_score = (167, 139, 250), -1.0
    buckets: dict[tuple, list] = {}
    for px in img.getdata():
        h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in px))
        key = (round(h * 12) % 12, round(s * 3), round(l * 4))
        buckets.setdefault(key, []).append(px)
    for key, pxs in buckets.items():
        r_, g_, b_ = (sum(p[i] for p in pxs) / len(pxs) for i in range(3))
        h, l, s = colorsys.rgb_to_hls(r_ / 255, g_ / 255, b_ / 255)
        score = len(pxs) * (0.25 + s) * (1.0 if 0.18 < l < 0.85 else 0.3)
        if score > best_score:
            best_score, best = score, (r_, g_, b_)
    h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in best))
    s = min(max(s, 0.35), 0.85) if s > 0.08 else s
    l = min(max(l, 0.55), 0.72)
    rgb = [int(c * 255) for c in colorsys.hls_to_rgb(h, l, s)]
    _color_cache[url] = rgb
    return rgb
