"""Copy Spotify playlists + liked songs into YouTube Music.

Step 1 (match): read Spotify, find each song on YouTube Music, nothing is written.
Step 2 (import): create the playlists / like the songs on the YouTube Music account.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import config
from .yt import tracks as yt_tracks

log = logging.getLogger("tempo.spotify")
REDIRECT = f"http://127.0.0.1:{config.PORT}/spotify/callback"
SCOPES = "playlist-read-private playlist-read-collaborative user-library-read"


class Spotify:
    def __init__(self, engine):
        self.engine = engine
        self.data = config.read_json(config.SPOTIFY_FILE, {}) or {}
        self._verifier = None
        self._state = None
        self.job: dict | None = None
        self.results = config.read_json(config.CACHE / "spotify_match.json", None)
        self._links: dict = {}  # (kind, id) -> (time, public read): preview + match read Spotify once

    # ---------------- auth
    def save(self):
        config.write_json(config.SPOTIFY_FILE, self.data)

    def status(self) -> dict:
        return {"client_id": bool(self.data.get("client_id")), "connected": bool(self.data.get("refresh_token")),
                "user": self.data.get("user"), "redirect": REDIRECT, "job": self.job_view(),
                "has_results": bool(self.results)}

    def set_client_id(self, cid: str):
        self.data["client_id"] = cid.strip()
        self.data.pop("refresh_token", None)
        self.data.pop("access_token", None)
        self.save()

    def login_url(self) -> str:
        self._verifier = secrets.token_urlsafe(64)[:96]
        self._state = secrets.token_urlsafe(16)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self._verifier.encode()).digest()).decode().rstrip("=")
        q = {"client_id": self.data["client_id"], "response_type": "code", "redirect_uri": REDIRECT,
             "code_challenge_method": "S256", "code_challenge": challenge, "scope": SCOPES, "state": self._state}
        return "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode(q)

    def callback(self, code: str, state: str):
        if not self._verifier or state != self._state:
            raise RuntimeError("Sign-in expired, try Connect again")
        tok = self._token({"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
                           "client_id": self.data["client_id"], "code_verifier": self._verifier})
        self._store(tok)
        me = self.get("/me")
        self.data["user"] = me.get("display_name") or me.get("id")
        self.save()

    def disconnect(self):
        for k in ("refresh_token", "access_token", "expires", "user"):
            self.data.pop(k, None)
        self.save()

    def _token(self, form: dict) -> dict:
        req = urllib.request.Request("https://accounts.spotify.com/api/token", data=urllib.parse.urlencode(form).encode(),
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())

    def _store(self, tok: dict):
        self.data["access_token"] = tok["access_token"]
        self.data["expires"] = time.time() + int(tok.get("expires_in", 3600)) - 60
        if tok.get("refresh_token"):
            self.data["refresh_token"] = tok["refresh_token"]
        self.save()

    def _access(self) -> str:
        if self.data.get("access_token") and time.time() < self.data.get("expires", 0):
            return self.data["access_token"]
        if not self.data.get("refresh_token"):
            raise RuntimeError("Spotify isn't connected")
        try:
            tok = self._token({"grant_type": "refresh_token", "refresh_token": self.data["refresh_token"],
                               "client_id": self.data["client_id"]})
        except urllib.error.HTTPError as e:
            if e.code in (400, 401):
                # Spotify refresh tokens expire after 180 days: forget it so Tempo shows "Connect" again
                self.disconnect()
                raise RuntimeError("Your Spotify sign-in expired — click Connect again")
            raise
        self._store(tok)
        return self.data["access_token"]

    def get(self, path: str) -> dict:
        url = path if path.startswith("http") else "https://api.spotify.com/v1" + path
        for attempt in range(5):
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self._access()})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(int(e.headers.get("Retry-After", "2")) + 0.5)
                    continue
                if e.code == 401 and attempt == 0:
                    self.data.pop("access_token", None)
                    continue
                body = e.read()[:300].decode("utf-8", "replace")
                raise RuntimeError(f"Spotify {e.code}: {body}")
        raise RuntimeError("Spotify kept rate-limiting, try again in a minute")

    def pages(self, path: str):
        nxt = path
        while nxt:
            d = self.get(nxt)
            yield from d.get("items") or []
            nxt = d.get("next")

    # ---------------- reading Spotify
    def playlists(self) -> list[dict]:
        me = self.data.get("user")
        out = [{"id": "liked", "name": "Liked Songs", "count": None, "owner": me, "image": None, "importable": True}]
        for p in self.pages("/me/playlists?limit=50"):
            if not p:
                continue
            owner = (p.get("owner") or {}).get("display_name") or (p.get("owner") or {}).get("id")
            imgs = p.get("images") or []
            count = (p.get("items") or p.get("tracks") or {}).get("total")
            out.append({"id": p["id"], "name": p.get("name") or "Untitled", "count": count, "owner": owner,
                        "image": imgs[0]["url"] if imgs else None, "collaborative": p.get("collaborative"),
                        "mine": owner == me or p.get("collaborative")})
        return out

    def playlist_tracks(self, pid: str) -> list[dict]:
        rows = []
        if pid == "liked":
            src = self.pages("/me/tracks?limit=50")
        else:
            try:
                src = list(self.pages(f"/playlists/{pid}/items?limit=50"))
            except RuntimeError as e:
                if "404" not in str(e):
                    raise
                src = list(self.pages(f"/playlists/{pid}/tracks?limit=50"))
        for it in src:
            t = (it or {}).get("item") or (it or {}).get("track")
            if not t or t.get("type", "track") != "track" or t.get("is_local"):
                continue
            rows.append({
                "sid": t.get("id"), "name": t.get("name") or "", "artists": [a.get("name") for a in t.get("artists") or []],
                "album": (t.get("album") or {}).get("name") or "", "ms": t.get("duration_ms") or 0,
                "isrc": (t.get("external_ids") or {}).get("isrc"),
            })
        return rows

    # ---------------- matching
    def job_view(self):
        if not self.job:
            return None
        j = self.job
        return {k: j.get(k) for k in ("phase", "done", "total", "message", "error", "finished", "created")}

    def start_match(self, playlist_ids: list[str], names: dict):
        """Your own Spotify playlists / liked songs (needs Connect)."""
        sources = [(pid, (lambda pid=pid: {"name": names.get(pid) or pid, "rows": self.playlist_tracks(pid)}),
                    names.get(pid, pid)) for pid in playlist_ids]
        self._start(sources, "Reading Spotify…")

    def start_link_match(self, text: str):
        """Any public Spotify playlist / album / song links (anyone's), no Spotify sign-in needed."""
        links = parse_links(text)
        if not links:
            raise RuntimeError("That doesn't look like a Spotify link")
        sources = []
        for kind, sid in links:
            if kind in ("playlist", "album"):
                sources.append((f"sp:{kind}:{sid}", (lambda kind=kind, sid=sid: self.read_link(kind, sid, full=True)),
                                f"the {kind}"))
        songs = [sid for kind, sid in links if kind == "track"]
        if len(songs) == 1:
            sources.append((f"sp:track:{songs[0]}", (lambda: self.read_link("track", songs[0])), "the song"))
        elif songs:
            sources.append((f"sp:tracks:{songs[0]}:{len(songs)}", (lambda: read_tracks(songs, self.job)), f"{len(songs)} songs"))
        self._start(sources, "Reading the Spotify link…")

    def read_link(self, kind: str, sid: str, full: bool = False) -> dict:
        """Preview (full=False): the quick embed read. Import (full=True): a playlist the embed cut off at 100
        is read again, all of it, from the normal page (spotify_full: a headless browser, no window)."""
        hit = self._links.get((kind, sid))
        fresh = hit is not None and time.time() - hit[0] < 600
        if fresh and (not full or not hit[1].get("more") or hit[1].get("full_tried")):
            return hit[1]
        d = hit[1] if fresh else read_public(kind, sid)
        if full and d.get("more"):
            d = dict(d)
            d["full_tried"] = True
            res = read_full(kind, sid, d.get("total") or 0, self.job)
            if res.get("rows") and len(res["rows"]) > len(d["rows"]):
                d.update(rows=res["rows"], total=max(len(res["rows"]), res.get("total") or 0), more=False,
                         full=True, full_seconds=res.get("seconds"))
                if not res.get("complete"):
                    d["more"] = True
                    d["short_reason"] = res.get("error") or ("reading took too long" if res.get("timed_out")
                                                             else "Spotify stopped giving songs before the end")
            else:
                d["short_reason"] = res.get("error") or "couldn't read more than the first 100"
                d["full_tried"] = False   # a failed full read isn't cached: pressing it again tries again
                log.info("full read of %s failed: %s", sid, d["short_reason"])
        self._links[(kind, sid)] = (time.time(), d)
        return d

    def link_preview(self, text: str) -> dict:
        """What a pasted link points at (name, cover, song count); for a single song also its YouTube match."""
        links = parse_links(text)
        if not links:
            raise RuntimeError("That doesn't look like a Spotify link")
        if len(links) > 1:
            return {"kind": "many", "count": len(links), "songs": sum(k == "track" for k, _ in links),
                    "lists": sum(k != "track" for k, _ in links)}
        kind, sid = links[0]
        d = self.read_link(kind, sid)
        out = {k: d.get(k) for k in ("kind", "id", "name", "owner", "image", "total", "url")}
        out["count"] = len(d["rows"])
        out["full"] = bool(d.get("more")) and full_read_available()   # all of it gets read when the import starts
        if kind == "track" and d["rows"]:
            out["src"] = d["rows"][0]
            out["match"] = self.match_one(d["rows"][0])
        return out

    def _start(self, sources, message):
        if self.job and not self.job.get("finished"):
            raise RuntimeError("An import is already running")
        self.job = {"phase": "reading", "done": 0, "total": 0, "message": message, "finished": False}
        self.engine.loop.run_in_executor(None, self._match_job, sources)

    def _match_job(self, sources):
        try:
            lists = []
            for lid, reader, label in sources:
                self.job["message"] = f"Reading {label}…"
                d = reader()
                lists.append({"id": lid, "name": d.get("name") or label, "rows": d["rows"],
                              "total": d.get("total"), "url": d.get("url"), "short_reason": d.get("short_reason")})
            uniq = {}
            for l in lists:
                for r in l["rows"]:
                    uniq.setdefault(r["sid"] or (r["name"] + "|" + ",".join(r["artists"])), r)
            self.job.update(phase="matching", total=len(uniq), done=0, message="Finding songs on YouTube Music…")
            cache = config.read_json(config.CACHE / "spotify_cache.json", {}) or {}
            keys = list(uniq)

            def work(key):
                r = uniq[key]
                if key in cache:
                    return key, cache[key]
                try:
                    m = self.match_one(r)
                except Exception as e:
                    m = {"status": "missing", "error": str(e)[:120]}
                return key, m

            with ThreadPoolExecutor(max_workers=6) as ex:
                for key, m in ex.map(work, keys):
                    cache[key] = m
                    self.job["done"] += 1
            config.write_json(config.CACHE / "spotify_cache.json", cache)
            out_lists = []
            for l in lists:
                items = []
                for r in l["rows"]:
                    key = r["sid"] or (r["name"] + "|" + ",".join(r["artists"]))
                    items.append({"src": r, "match": cache.get(key)})
                out_lists.append({"id": l["id"], "name": l["name"], "items": items, "total": l.get("total"),
                                  "url": l.get("url"), "short_reason": l.get("short_reason")})
            counts = {"good": 0, "unsure": 0, "missing": 0}
            for l in out_lists:
                for it in l["items"]:
                    counts[(it["match"] or {}).get("status", "missing")] += 1
            self.results = {"lists": out_lists, "counts": counts, "created": time.time()}
            config.write_json(config.CACHE / "spotify_match.json", self.results)
            self.job.update(phase="matched", finished=True, message="Matched")
        except Exception as e:
            log.exception("match job failed")
            self.job.update(phase="error", finished=True, error=str(e)[:300])
        self.engine.loop.call_soon_threadsafe(lambda: self.engine.emit("spotify", self.status()))

    def match_one(self, r: dict) -> dict:
        api = self.engine.yt.api
        artist = r["artists"][0] if r["artists"] else ""
        q = f"{clean_title(r['name'])} {artist}".strip()
        cands = yt_tracks(api.search(q, filter="songs", limit=8))
        scored = sorted(((score(r, c), c) for c in cands), key=lambda x: -x[0])
        if not scored or scored[0][0] < 0.72:
            vids = yt_tracks(api.search(q, filter="videos", limit=6))
            scored = sorted(scored + [(score(r, c) - 0.06, c) for c in vids], key=lambda x: -x[0])
        if not scored:
            return {"status": "missing"}
        best, c = scored[0]
        alts = [x[1] for x in scored[1:4]]
        status = "good" if best >= 0.8 else ("unsure" if best >= 0.55 else "missing")
        return {"status": status, "score": round(best, 2), "track": c if status != "missing" else None,
                "alts": alts if status != "good" else [], "best": c}

    def set_choice(self, list_id: str, idx: int, track: dict | None):
        for l in (self.results or {}).get("lists", []):
            if l["id"] == list_id and 0 <= idx < len(l["items"]):
                it = l["items"][idx]
                if track:
                    it["match"] = {"status": "good", "score": 1.0, "track": track, "alts": [], "manual": True}
                else:
                    it["match"] = {"status": "missing", "skipped": True}
        config.write_json(config.CACHE / "spotify_match.json", self.results)

    # ---------------- writing to YouTube Music
    def start_import(self, list_ids: list[str], include_unsure: bool, names: dict | None = None):
        if not self.engine.yt.authed:
            raise RuntimeError("Connect YouTube Music first")
        if self.job and not self.job.get("finished"):
            raise RuntimeError("An import is already running")
        self.job = {"phase": "importing", "done": 0, "total": 0, "message": "Writing to YouTube Music…", "finished": False}
        self.engine.loop.run_in_executor(None, self._import_job, list_ids, include_unsure, names or {})

    def _import_job(self, list_ids, include_unsure, names):
        yt = self.engine.yt
        try:
            todo = [l for l in self.results["lists"] if l["id"] in list_ids]
            total = sum(len(l["items"]) for l in todo)
            self.job.update(total=total, done=0)
            made = []
            for l in todo:
                ids = []
                for it in l["items"]:
                    m = it.get("match") or {}
                    if m.get("track") and (m.get("status") == "good" or (include_unsure and m.get("status") == "unsure")):
                        if m["track"]["id"] not in ids:
                            ids.append(m["track"]["id"])
                if l["id"] == "liked":
                    self.job["message"] = "Liking songs on YouTube Music…"
                    for vid in ids:
                        try:
                            yt.rate(vid, "LIKE")
                        except Exception as e:
                            log.info("like failed %s: %s", vid, e)
                        self.job["done"] += 1
                        time.sleep(0.15)
                    made.append({"name": "Liked songs", "count": len(ids)})
                else:
                    name = (names.get(l["id"]) or "").strip()[:150] or l["name"]
                    self.job["message"] = f"Creating “{name}”…"
                    pid = yt.create_playlist(name, None, "Imported from Spotify")
                    for k in range(0, len(ids), 50):
                        yt.add_to_playlist(pid, ids[k:k + 50])
                        self.job["done"] += min(50, len(ids) - k)
                    made.append({"name": name, "count": len(ids), "id": pid})
                self.job["done"] = min(self.job["total"], self.job["done"] + (len(l["items"]) - len(ids)))
            yt.invalidate("lib:")
            self.job.update(phase="imported", finished=True, message="Done", made=made)
        except Exception as e:
            log.exception("import failed")
            self.job.update(phase="error", finished=True, error=str(e)[:300])
        self.engine.loop.call_soon_threadsafe(lambda: self.engine.emit("spotify", self.status()))


# ---------------- public links (anyone's playlist, no Spotify sign-in)
# Since Spotify's Feb 2026 API change the Web API only lists items of playlists YOU own or collaborate on.
# The public embed page (open.spotify.com/embed/<kind>/<id>) carries the list in its __NEXT_DATA__ JSON:
# title, artists, duration for the FIRST 100 songs (no paging; measured Nov 20). The normal public page
# (plain user agent) says the real size in <meta name="music:song_count">, so bigger playlists get a
# "first 100 of N" note. For all of them: paste the songs' own links (Spotify desktop: Ctrl+A, Ctrl+C),
# each is read from its track embed.
_EMBED_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
_LINK = re.compile(r"(playlist|album|track)[/:]([A-Za-z0-9]{22})(?=$|[^A-Za-z0-9]|https?:|spotify:)")
_SHORT = re.compile(r"https?://(?:spotify\.link|spoti\.fi)/[A-Za-z0-9_-]+")
_NEXT = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)


def is_link(text: str) -> bool:
    t = (text or "").strip()
    return bool(re.search(r"(open\.spotify\.com/|spotify:(playlist|album|track):|spotify\.link/|spoti\.fi/)", t))


def _fetch(url: str, ua: str = _EMBED_UA, timeout: float = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "en"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(int(e.headers.get("Retry-After") or 2) + 0.5)
                continue
            if e.code == 404:
                raise RuntimeError("Spotify couldn't find that — check the link")
            raise RuntimeError(f"Spotify said {e.code}")
    raise RuntimeError("Spotify kept rate-limiting, try again in a minute")


def parse_links(text: str) -> list[tuple[str, str]]:
    """Every Spotify playlist/album/track in the text, in order, no repeats.
    Takes open.spotify.com links (?si=, /intl-xx/, /embed/, old /user/x/playlist/), spotify:kind:id URIs,
    and spotify.link / spoti.fi short links (followed)."""
    text = text or ""
    if not is_link(text):
        return []
    found = _LINK.findall(_SHORT.sub(" ", text))
    for short in _SHORT.findall(text)[:5]:
        try:
            found.extend(_resolve_short(short))
        except Exception as e:
            log.info("short link %s: %s", short, e)
    out, seen = [], set()
    for kind, sid in found:
        if (kind, sid) not in seen:
            seen.add((kind, sid))
            out.append((kind, sid))
    return out


def _resolve_short(url: str) -> list[tuple[str, str]]:
    """spotify.link / spoti.fi -> the one thing it points at (redirect target, else the page's og:url)."""
    req = urllib.request.Request(url, headers={"User-Agent": _EMBED_UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        hit = _LINK.findall(r.geturl())
        if hit:
            return hit[:1]
        body = r.read(300_000).decode("utf-8", "replace")
    for pat in (r'property="og:url" content="([^"]+)"', r'(https://open\.spotify\.com/[^"\'\s<>]+)'):
        m = re.search(pat, body)
        if m and _LINK.findall(m.group(1)):
            return _LINK.findall(m.group(1))[:1]
    return []


def _embed(kind: str, sid: str) -> dict:
    html = _fetch(f"https://open.spotify.com/embed/{kind}/{sid}")
    m = _NEXT.search(html)
    ent = None
    if m:
        try:
            ent = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
        except (KeyError, TypeError, ValueError):
            ent = None
    if not ent:
        raise RuntimeError(f"Spotify didn't share that {kind} — it may be private or deleted")
    return ent


def _artists(sub: str) -> list[str]:
    # embed track subtitles join artists with ",<nbsp>" (names themselves can hold ", ")
    return [a.strip() for a in (sub or "").split(",\xa0") if a.strip()]


def read_public(kind: str, sid: str) -> dict:
    ent = _embed(kind, sid)
    url = f"https://open.spotify.com/{kind}/{sid}"
    imgs = ((ent.get("coverArt") or {}).get("sources") or []) or ((ent.get("visualIdentity") or {}).get("image") or [])
    image = imgs[-1].get("url") if imgs else None
    if kind == "track":
        row = {"sid": sid, "name": ent.get("name") or ent.get("title") or "",
               "artists": [a.get("name") for a in ent.get("artists") or [] if a.get("name")],
               "album": "", "ms": ent.get("duration") or 0}
        return {"kind": kind, "id": sid, "name": row["name"], "owner": ", ".join(row["artists"]), "image": image,
                "rows": [row], "total": 1, "url": url}
    rows = []
    for t in ent.get("trackList") or []:
        if (t.get("entityType") or "track") != "track":
            continue  # podcast episodes
        uri = t.get("uri") or ""
        rows.append({"sid": uri.rsplit(":", 1)[-1] if uri.startswith("spotify:track:") else None,
                     "name": t.get("title") or "", "artists": _artists(t.get("subtitle")),
                     "album": ent.get("name") if kind == "album" else "", "ms": t.get("duration") or 0})
    total = len(rows)
    more = False
    if len(ent.get("trackList") or []) >= 100:   # playlists AND albums: the embed stops at 100
        more = True    # maybe more (if the page doesn't say, the full read finds out)
        try:  # the public page says how many there really are
            page = _fetch(url, ua="Mozilla/5.0", timeout=15)
            m = (re.search(r'<meta name="music:song_count" content="(\d+)"', page)
                 or re.search(r'<meta (?:name|property)="(?:og:)?description" content="[^"]*?(\d[\d,]*) songs', page))
            if m:
                m = re.match(r"(\d+)", m.group(1).replace(",", ""))
                total = max(total, int(m.group(1)))
                more = total > len(rows)
        except Exception as e:
            log.info("song count for %s: %s", sid, e)
    return {"kind": kind, "id": sid, "name": ent.get("name") or ent.get("title") or "Spotify " + kind,
            "owner": ent.get("subtitle") or "", "image": image, "rows": rows, "total": total, "url": url, "more": more}


# ---------------- the WHOLE playlist (Nov 21): the embed stops at 100, the normal page doesn't
# open.spotify.com/playlist/<id> (or /album/<id>) opened in a real browser engine, signed out, and scrolled,
# lazy-loads every row. tempo/spotify_full.py is that browser, in its own short-lived process: a headless
# Edge/Chrome/Brave (no window at all; Edge is on every Windows). No such browser = the first 100 + the Ctrl+A
# song-links route. Measured Nov 21: Windows 500 songs 13-15 s, 152 in 7 s, a 150-song album 7 s; Mac (Brave) 9 / 5 / 4 s.
_full_lock = threading.Lock()   # one at a time (they share one browser profile)


def full_read_available() -> bool:
    if os.environ.get("TEMPO_NO_FULL_READ") == "1":     # tests: force the embed-only path
        return False
    try:
        from .spotify_full import find_browser
        return find_browser() is not None     # headless Edge / Chrome / Brave: no window at all
    except Exception:
        return False


def read_full(kind: str, sid: str, total: int = 0, job: dict | None = None, timeout: float | None = None) -> dict:
    """{rows, total, complete, seconds} or {error}. Progress goes into job (done/total/message)."""
    if not full_read_available():
        return {"error": "no browser engine here"}
    # the first start of WebView2 on a busy laptop can take 1-2 minutes; after that ~6 s
    timeout = timeout or min(300.0, 150.0 + total * 0.2)
    cmd = [sys.executable, "-m", "tempo.spotify_full", kind, sid, str(int(total or 0)), str(int(timeout))]
    kw = {}
    if config.IS_WIN:
        kw["creationflags"] = 0x08000000   # CREATE_NO_WINDOW: no console window, ever

    def msg_for(tot):
        return f"Reading all {tot} songs from Spotify…" if tot else "Reading every song from Spotify…"
    t0 = time.time()
    with _full_lock:
        if job is not None:
            job.update(total=total or 0, done=0, message=msg_for(total))
        try:
            proc = subprocess.Popen(cmd, cwd=str(config.ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, **kw)
        except Exception as e:   # noqa: BLE001
            return {"error": f"couldn't start the reader: {e}"[:200]}
        killer = threading.Timer(timeout + 30, proc.kill)   # its own watchdog should end it first
        killer.daemon = True
        killer.start()
        out: dict = {"error": "the reader stopped without an answer"}
        try:
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if "progress" in msg and job is not None:
                    n, tot = msg.get("progress") or 0, msg.get("total") or total
                    job.update(done=min(n, tot or n), total=tot or 0, message=msg_for(tot))
                elif "result" in msg:
                    out = msg["result"]
                elif "error" in msg:
                    out = {"error": msg["error"]}
            proc.wait(timeout=20)
        except Exception as e:   # noqa: BLE001
            out = {"error": str(e)[:200]}
        finally:
            killer.cancel()
            if proc.poll() is None:
                proc.kill()
    log.info("full read %s: %s rows of %s in %.1fs%s", sid, len(out.get("rows") or []), out.get("total"),
             time.time() - t0, (" (" + out["error"] + ")") if out.get("error") else "")
    return out


def read_tracks(ids: list[str], job: dict | None = None) -> dict:
    """A pasted batch of song links (e.g. Ctrl+A, Ctrl+C in Spotify desktop) -> one list, in order."""
    ids = ids[:2000]
    if job is not None:
        job.update(total=len(ids), done=0)

    def one(sid):
        try:
            return read_public("track", sid)["rows"][0]
        except Exception as e:
            log.info("track %s: %s", sid, e)
            return None
        finally:
            if job is not None:
                job["done"] = job.get("done", 0) + 1

    with ThreadPoolExecutor(max_workers=6) as ex:
        rows = [r for r in ex.map(one, ids) if r]
    if not rows:
        raise RuntimeError("Couldn't read any of those Spotify songs")
    return {"name": "Songs from Spotify", "rows": rows, "total": len(ids)}


# ---------------- scoring
_FEAT = re.compile(r"\s*[\(\[](feat\.?|ft\.?|with|prod\.?)[^\)\]]*[\)\]]", re.I)
_DASH = re.compile(r"\s+-\s+(.*(remaster|version|edit|mix|mono|stereo|live|radio|deluxe|bonus|from).*)$", re.I)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_title(s: str) -> str:
    s = _FEAT.sub("", s or "")
    s = _DASH.sub("", s)
    return s.strip()


def score(r: dict, c: dict) -> float:
    t1, t2 = norm(clean_title(r["name"])), norm(clean_title(c["title"]))
    title = difflib.SequenceMatcher(None, t1, t2).ratio()
    if t1 and (t1 in t2 or t2 in t1):
        title = max(title, 0.9)
    sa = {norm(a) for a in r["artists"] if a}
    ca = {norm(a["name"]) for a in c.get("artists") or []}
    if sa and ca:
        inter = len(sa & ca)
        artist = 1.0 if inter else max(difflib.SequenceMatcher(None, " ".join(sorted(sa)), " ".join(sorted(ca))).ratio() - 0.2, 0)
        if not inter and any(a in norm(c["title"]) for a in sa):
            artist = 0.85
        # "Bob Marley & The Wailers" vs "Bob Marley", "Prince" vs "Prince & The Revolution"
        if not inter and any(len(x) >= 4 and len(y) >= 4 and (f" {x} " in f" {y} " or f" {y} " in f" {x} ")
                             for x in sa for y in ca):
            artist = max(artist, 0.95)
    else:
        artist = 0.5
    dur = 0.5
    if r.get("ms") and c.get("dur"):
        diff = abs(r["ms"] / 1000 - c["dur"])
        dur = 1.0 if diff <= 3 else (0.8 if diff <= 8 else (0.4 if diff <= 20 else 0.0))
    s = title * 0.5 + artist * 0.32 + dur * 0.18
    # different-version words on only one side ("live", "remix", "sped up") are usually the wrong song
    for w in ("live", "remix", "sped up", "slowed", "instrumental", "karaoke", "acoustic", "cover", "nightcore"):
        if (w in norm(c["title"])) != (w in norm(r["name"])):
            s -= 0.15
    return s
