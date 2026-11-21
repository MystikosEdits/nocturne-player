"""Audio effects: the global equalizer and per-song versions (slowed / reverb / sped up / bass boost).

Everything becomes ONE mpv `af` string (a libavfilter graph), so EQ + song effects + volume levelling
stack in a fixed order and always end in a limiter (no clipping). Speed is mpv's `speed` property:
with `keep_pitch` off it plays like a turntable (slowed = deeper, sped up = higher), on = same pitch
(Rubber Band when mpv has it, see build_af; else mpv's own scaletempo2).
"""
from __future__ import annotations

EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"]

EQ_PRESETS: dict[str, list[float]] = {
    "Flat":          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "Bass boost":    [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    "Deep bass":     [9, 7, 4, 1, -1, 0, 0, 0, 0, 0],
    "V-shape":       [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
    "Hip-hop":       [5, 4, 2, 3, -1, -1, 1, 0, 2, 3],
    "Electronic":    [4, 3, 1, 0, -2, 1, 0, 1, 3, 4],
    "Rock":          [4, 3, 2, 0, -1, -1, 1, 2, 3, 4],
    "Vocal":         [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
    "Acoustic":      [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
    "Treble boost":  [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
    "Late night":    [-1, 0, 1, 1, 0, -1, -2, -3, -4, -5],
    "Loudness":      [5, 4, 1, 0, -1, 0, 0, 1, 3, 4],
}

# per-song versions: speed (0.5-1.5), reverb 0-100, bass 0-12 dB, muffle 0-100 (low-pass: "through a wall"), keep_pitch
PRESETS: dict[str, dict] = {
    "Slowed + reverb": {"speed": 0.85, "reverb": 55, "bass": 2, "keep_pitch": False},
    "Slowed":          {"speed": 0.82, "reverb": 0, "bass": 1, "keep_pitch": False},
    "Sped up":         {"speed": 1.22, "reverb": 0, "bass": 0, "keep_pitch": False},
    "Nightcore":       {"speed": 1.32, "reverb": 8, "bass": 0, "keep_pitch": False},
    "Reverb":          {"speed": 1.0, "reverb": 50, "bass": 0, "keep_pitch": False},
    "Bass boosted":    {"speed": 1.0, "reverb": 0, "bass": 8, "keep_pitch": False},
    "Daycore":         {"speed": 0.9, "reverb": 30, "bass": 0, "keep_pitch": False},
    "Muffled":         {"speed": 1.0, "reverb": 0, "bass": 2, "muffle": 72, "keep_pitch": False},
    "Muffled + reverb": {"speed": 1.0, "reverb": 45, "bass": 3, "muffle": 75, "keep_pitch": False},
}

WET_GAIN = 0.8   # calibrated with tools/fx_calibrate.py so a reverbed song stays about as loud as the original


def clean_fx(fx: dict | None) -> dict | None:
    if not fx:
        return None
    out = {
        "speed": round(min(1.5, max(0.5, float(fx.get("speed") or 1.0))), 3),
        "reverb": int(min(100, max(0, float(fx.get("reverb") or 0)))),
        "bass": round(min(12, max(0, float(fx.get("bass") or 0))), 1),
        "muffle": int(min(100, max(0, float(fx.get("muffle") or 0)))),
        "keep_pitch": bool(fx.get("keep_pitch")),
    }
    if out["speed"] == 1.0 and not out["reverb"] and not out["bass"] and not out["muffle"]:
        return None
    return out


def describe(fx: dict | None) -> str:
    """'slowed + reverb', 'sped up + bass', ..."""
    if not fx:
        return ""
    parts = []
    s = fx.get("speed", 1.0)
    if s < 0.97:
        parts.append("slowed")
    elif s > 1.03:
        parts.append("nightcore" if s >= 1.3 and not fx.get("keep_pitch") else "sped up")
    if fx.get("reverb"):
        parts.append("reverb")
    if (fx.get("bass") or 0) > 3:      # a light bass touch (presets add 1-3 dB) isn't worth naming
        parts.append("bass boosted")
    if fx.get("muffle"):
        parts.append("muffled")
    return " + ".join(parts)


def _eq_chain(eq: dict | None) -> list[str]:
    if not eq or not eq.get("on"):
        return []
    gains = list(eq.get("bands") or [0] * 10)[:10]
    pre = float(eq.get("preamp") or 0)
    if not any(abs(g) > 0.05 for g in gains) and abs(pre) < 0.05:
        return []
    chain = [f"volume={pre:.1f}dB"] if abs(pre) >= 0.05 else []
    for f, g in zip(EQ_BANDS, gains):
        if abs(g) > 0.05:
            chain.append(f"equalizer=f={f}:t=o:w=1:g={float(g):.1f}")
    return chain


def _muffle_filters(fx: dict) -> list[str]:
    """Low-pass that closes from 20 kHz (0) down to ~350 Hz (100), two stages = steep like a wall."""
    m = (fx.get("muffle") or 0) / 100.0
    if m <= 0:
        return []
    cutoff = int(20000 * (350 / 20000) ** m)
    return [f"lowpass=f={cutoff}:p=2", f"lowpass=f={cutoff}:p=2"]


def _makeup_db(fx: dict) -> float:
    """Level correction measured with tools/fx_calibrate.py: reverb mixes came out ~2 dB quieter,
    bass boost ~2.3 dB louder (at 55% reverb / +8 dB bass)."""
    return ((fx.get("reverb") or 0) / 100.0 * 3.6 - (fx.get("bass") or 0) * 0.28
            + (fx.get("muffle") or 0) / 100.0 * 1.8)   # low-pass loses ~1.5 dB at 72%


def _escape_path(p: str) -> str:
    # inside a filter graph a Windows drive colon must be escaped and the path quoted
    return "'" + p.replace("\\", "/").replace(":", "\\:").replace("'", "") + "'"


def build_af(eq: dict | None, fx: dict | None, normalize: bool, ir_path: str, rubberband: bool = False) -> str:
    """The full mpv `af` value ('' = no filters at all).

    rubberband=True (mpv has librubberband): a "keep pitch" speed change goes through mpv's `rubberband` filter
    (R3 "finer" engine, channels together = its defaults) instead of the scaletempo2 mpv inserts by itself.
    scaletempo2 splices the waveform, which warbles dense mixes: on a steady 8-note chord its notes wobbled
    0.9-1.4 dB and drifted 3 cents at 0.8x/0.65x, rubberband 0.0 (tools/pitch_synth_test.py, Nov 20).
    With a rubberband filter in the chain mpv sends it the speed and drops its own speed stage EVEN with pitch
    correction off, so it's only added for keep_pitch (turntable mode must stay a resample)."""
    fx = clean_fx(fx) or {}
    chain = _build_chain(eq, fx, normalize, ir_path)
    if rubberband and fx.get("keep_pitch") and fx.get("speed", 1.0) != 1.0:
        return "rubberband" + ("," + chain if chain else "")
    return chain


def _build_chain(eq: dict | None, fx: dict, normalize: bool, ir_path: str) -> str:
    pre = _eq_chain(eq)
    if fx.get("bass"):
        pre.append(f"bass=g={fx['bass']}:f=110:w=0.6")
    pre += _muffle_filters(fx)
    post = []
    mk = _makeup_db(fx) if fx else 0.0
    if abs(mk) >= 0.1:
        post.append(f"volume={mk:.1f}dB")
    if normalize:
        post.append("loudnorm=I=-15:TP=-1.5:LRA=11")
    reverb = fx.get("reverb") or 0
    if not pre and not post and not reverb:
        return ""
    post.append("alimiter=limit=0.95:level=0")
    if not reverb:
        return "lavfi=[" + ",".join(pre + post) + "]"
    r = reverb / 100.0
    dry, wet = 1.0 - r * 0.45, r * WET_GAIN
    head = "[ain]" + (",".join(pre) + "," if pre else "") + "asplit[d][w]"
    graph = (f"{head};amovie={_escape_path(ir_path)}[ir];[w][ir]afir[wv];"
             f"[d][wv]amix=inputs=2:weights='{dry:.2f} {wet:.2f}':normalize=0," + ",".join(post))
    return "lavfi=[" + graph + "]"


def ffmpeg_graph(fx: dict, ir_path: str) -> str | None:
    """Same chain for the ffmpeg CLI (calibration only): input [0:a], speed via asetrate/atempo."""
    fx = clean_fx(fx)
    if not fx:
        return None
    pre = []
    s = fx["speed"]
    if s != 1.0:
        pre.append(f"atempo={s}" if fx["keep_pitch"] else f"asetrate=48000*{s},aresample=48000")
    if fx.get("bass"):
        pre.append(f"bass=g={fx['bass']}:f=110:w=0.6")
    pre += _muffle_filters(fx)
    mk = _makeup_db(fx)
    post = (f"volume={mk:.1f}dB," if abs(mk) >= 0.1 else "") + "alimiter=limit=0.95:level=0"
    if not fx.get("reverb"):
        return "[0:a]" + ",".join(pre + [post])
    r = fx["reverb"] / 100.0
    dry, wet = 1.0 - r * 0.45, r * WET_GAIN
    head = "[0:a]aresample=48000," + (",".join(pre) + "," if pre else "") + "asplit[d][w]"
    return (f"{head};amovie={_escape_path(ir_path)}[ir];[w][ir]afir[wv];"
            f"[d][wv]amix=inputs=2:weights='{dry:.2f} {wet:.2f}':normalize=0,{post}")
