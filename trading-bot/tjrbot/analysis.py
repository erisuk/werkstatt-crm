"""Analyse-Werkzeuge: Wo verdient/verliert der Bot, was blockiert ihn?

Eingabe: Engine.trades_frame(), Engine.journal (Setups), Engine.days.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

GATES = ["PRE_WINDOW", "BIAS_WAIT", "UNALIGNED", "News-Fenster", "STOP_GATE", "NO_TARGET", "SIZE/COST",
         "EXPIRED_NO_REACTION", "CANCELLED_INVALIDATION", "CUTOFF", "ALIGNMENT_DEADLINE", "WARMUP", "NO_TRADE_DAY"]


def _stats(g: pd.DataFrame) -> dict:
    r = g["R"].astype(float)
    return {"n": int(len(g)), "winrate": round(float((r > 0).mean() * 100), 1), "avg_R": round(float(r.mean()), 3),
            "sum_R": round(float(r.sum()), 2)}


def by(trades: pd.DataFrame, col) -> dict:
    if not len(trades):
        return {}
    return {str(k): _stats(g) for k, g in trades.groupby(col)}


def gate_counts(journal: list[dict], days: list[dict]) -> dict:
    text = " | ".join(j.get("log", "") + " | " + j.get("end", "") for j in journal)
    text += " | " + " | ".join(d.get("done_reason", "") for d in days)
    return {g: len(re.findall(re.escape(g), text)) for g in GATES if g in text}


def streaks(r: pd.Series) -> dict:
    worst = cur = 0
    for x in r:
        cur = cur + 1 if x <= 0 else 0
        worst = max(worst, cur)
    return {"max_loss_streak": worst}


def analyze(trades: pd.DataFrame, journal: list[dict], days: list[dict]) -> dict:
    t = trades.dropna(subset=["R"]).copy() if len(trades) else trades
    out: dict = {"days": len(days), "setups": len(journal), "gates": gate_counts(journal, days)}
    if not len(t):
        out["trades"] = 0
        return out
    t["hour"] = pd.to_datetime(t["signal"]).dt.strftime("%H:%M").str[:4] + "0"
    t["with_bias"] = np.where(t["bias"].isin(["NEUTRAL"]) | (t["bias"] == t["dir"]), "mit/neutral", "gegen Bias")
    t["first_level"] = t["levels"].str.split(", ").str[0]
    out.update({
        "trades": int(len(t)), "total": _stats(t), **streaks(t["R"]),
        "by_exit": by(t, "exit"), "by_dir": by(t, "dir"), "by_index": by(t, "index"),
        "by_trigger": by(t, "trigger"), "by_confirm": by(t, "confirm"), "by_time": by(t, "hour"),
        "by_bias": by(t, "with_bias"), "by_level": by(t, "first_level"),
        "worst_trades": t.nsmallest(5, "R")[["signal", "index", "dir", "levels", "exit", "R"]].to_dict("records"),
    })
    return out


def text_report(a: dict) -> str:
    """Kurzer, regelbasierter Bericht (ohne KI)."""
    if not a.get("trades"):
        return f"Keine Trades. Häufigste Blocker: {sorted(a['gates'].items(), key=lambda x: -x[1])[:5]}"
    lines = [f"{a['trades']} Trades, Trefferquote {a['total']['winrate']} %, Ø {a['total']['avg_R']}R, "
             f"Summe {a['total']['sum_R']}R, längste Verlustserie {a['max_loss_streak']}"]
    for key, name in (("by_time", "Uhrzeit"), ("by_level", "Level"), ("by_confirm", "Bestätigung"),
                      ("by_bias", "Bias"), ("by_exit", "Ausstieg")):
        bad = [(k, v) for k, v in a[key].items() if v["n"] >= 3 and v["avg_R"] < 0]
        if bad:
            lines.append(f"🔻 Verlustbringer {name}: " + ", ".join(f"{k} ({v['n']}x, Ø {v['avg_R']}R)" for k, v in bad))
    lines.append("Blocker: " + ", ".join(f"{k} {v}x" for k, v in sorted(a["gates"].items(), key=lambda x: -x[1])[:6]))
    return "\n".join(lines)
