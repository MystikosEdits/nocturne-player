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
import re
import secrets
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
        if self.job and not self.job.get("finished"):
            raise RuntimeError("An import is already running")
        self.job = {"phase": "reading", "done": 0, "total": 0, "message": "Reading Spotify…", "finished": False}
        self.engine.loop.run_in_executor(None, self._match_job, playlist_ids, names)

    def _match_job(self, playlist_ids, names):
        try:
            lists = []
            for pid in playlist_ids:
                self.job["message"] = f"Reading {names.get(pid, pid)}…"
                rows = self.playlist_tracks(pid)
                lists.append({"id": pid, "name": names.get(pid) or pid, "rows": rows})
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
                out_lists.append({"id": l["id"], "name": l["name"], "items": items})
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
    def start_import(self, list_ids: list[str], include_unsure: bool):
        if not self.engine.yt.authed:
            raise RuntimeError("Connect YouTube Music first")
        if self.job and not self.job.get("finished"):
            raise RuntimeError("An import is already running")
        self.job = {"phase": "importing", "done": 0, "total": 0, "message": "Writing to YouTube Music…", "finished": False}
        self.engine.loop.run_in_executor(None, self._import_job, list_ids, include_unsure)

    def _import_job(self, list_ids, include_unsure):
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
                    self.job["message"] = f"Creating “{l['name']}”…"
                    pid = yt.create_playlist(l["name"], None, "Imported from Spotify")
                    for k in range(0, len(ids), 50):
                        yt.add_to_playlist(pid, ids[k:k + 50])
                        self.job["done"] += min(50, len(ids) - k)
                    made.append({"name": l["name"], "count": len(ids), "id": pid})
                self.job["done"] = min(self.job["total"], self.job["done"] + (len(l["items"]) - len(ids)))
            yt.invalidate("lib:")
            self.job.update(phase="imported", finished=True, message="Done", made=made)
        except Exception as e:
            log.exception("import failed")
            self.job.update(phase="error", finished=True, error=str(e)[:300])
        self.engine.loop.call_soon_threadsafe(lambda: self.engine.emit("spotify", self.status()))


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
