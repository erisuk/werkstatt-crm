"""Ausführung + Trade-Management eines Signals (Backtest und Paper-Modus).

Regeln (research/tjr_spec_final.json: backtest_execution, trade_management):
  * Signal bei Close der Trigger-Bar -> Market-Order zum Open der nächsten 1m-Bar, Slippage gegen uns.
  * Fill jenseits Stop oder TP1 -> GAP_SKIP. R bis TP1 nach dem Fill < tp1_min_R - 0.1 -> FILL_GATE.
  * Enthält eine Bar den aktuellen Stop, nimmt der Stop die ganze Restposition (stop_first), auch wenn ein
    Ziel in derselben Bar liegt. Stop-Fill zum schlechteren aus Stop und Open + Stop-Slippage.
  * Ziele füllen nur, wenn der Preis um tp_fill_through_ticks hindurchhandelt, zum Limitpreis.
  * TP1: Hälfte schließen, Stop ab der nächsten Bar auf Einstieg -/+ 1 Tick. TP2: Hälfte des Rests. Runner bis TP3.
  * Zeitausstiege (Stall, Max-Haltedauer, Flat-Zeit, 2 Min vor roten News) zum Open der ersten Bar ab Deadline.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import INSTRUMENTS


@dataclass
class Trade:
    status: str                       # FILLED | GAP_SKIP | FILL_GATE | PENDING | OPEN
    entry_t: int | None = None
    entry_price: int | None = None
    exit_t: int | None = None
    exit_reason: str = ""
    fills: list = field(default_factory=list)   # (t, qty, price_ticks, reason)
    pnl_usd: float | None = None
    r_multiple: float | None = None
    risk_ticks_fill: int | None = None


def simulate_signal(bars: list, k: int, sig, cfg: dict, flat_t: int, news_times: list | None = None) -> Trade:
    d = sig.dir
    spec = INSTRUMENTS[sig.instrument]
    tv, fee = spec["tick_value"], spec["commission_rt"]
    slip, sslip = cfg["slippage_ticks"], cfg["stop_slippage_ticks"]
    through = cfg["tp_fill_through_ticks"]
    if k >= len(bars):
        return Trade("PENDING")
    fb = bars[k]
    fill = fb.o + d * slip
    stop, tps = sig.stop, list(sig.targets)
    if (d == -1 and (fill >= stop or fill <= tps[0])) or (d == 1 and (fill <= stop or fill >= tps[0])):
        return Trade("GAP_SKIP", fb.t, fill, fb.t, "GAP_SKIP")
    risk = abs(fill - stop)
    r_tp1 = abs(tps[0] - fill) / risk
    if r_tp1 < cfg["tp1_min_R"] - 0.1:
        return Trade("FILL_GATE", fb.t, fill, fb.t, f"FILL_GATE (R {r_tp1:.2f})")

    q = sig.qty
    q1 = math.ceil(q * cfg["tp1_close_frac"])
    q2 = math.ceil((q - q1) * cfg["tp2_close_frac_of_remaining"]) if q1 < q else 0
    q3 = q - q1 - q2
    if q1 == q:
        plan = [q]
    elif len(tps) == 1:
        plan = [q1]                                # Rest läuft ohne Ziel (BE/Zeit)
    elif len(tps) == 2:
        plan = [q1, q - q1]                        # ohne TP3 schließt der Rest bei TP2
    else:
        plan = [q1, q2, q3] if q3 > 0 else [q1, q - q1]

    remaining = q
    fills = []
    next_tp = 0
    be_pending_from = None
    deadlines = [flat_t, fb.t + cfg["max_hold_minutes"]]
    for nt in news_times or []:
        if fb.t < nt - 2 < flat_t:
            deadlines.append(nt - 2)
    hard_deadline = min(deadlines)
    best, best_t = fill, fb.t
    exit_t, reason = None, ""

    for i in range(k, len(bars)):
        b = bars[i]
        if i > k and b.day != fb.day:          # Session vorbei (früher Schluss/Datenlücke) -> nie über Nacht halten
            prev = bars[i - 1]
            fills.append((prev.ct, remaining, prev.c - d * slip, "session_end"))
            remaining, exit_t, reason = 0, prev.ct, "SESSION_END"
            break
        if be_pending_from is not None and b.t >= be_pending_from:
            stop = fill + d * cfg["be_offset_ticks"]  # Break-even +1 Tick
            be_pending_from = None
        stall_deadline = best_t + cfg["stall_minutes"] if cfg["stall_minutes"] else None
        dl = min(x for x in (hard_deadline, stall_deadline) if x is not None)
        if b.t >= dl and i > k:
            px = b.o - d * slip
            fills.append((b.t, remaining, px, "time_exit"))
            remaining, exit_t = 0, b.t
            reason = "STALL" if stall_deadline is not None and dl == stall_deadline and dl < hard_deadline else "TIME"
            break
        if (d == -1 and b.h >= stop) or (d == 1 and b.l <= stop):
            px = (max(stop, b.o) + sslip) if d == -1 else (min(stop, b.o) - sslip)
            if i == k:
                px = stop + sslip if d == -1 else stop - sslip
            fills.append((b.t, remaining, px, "stop"))
            remaining, exit_t = 0, b.t
            reason = "BE_STOP" if next_tp > 0 else "STOP"
            break
        while next_tp < len(plan) and remaining > 0:
            tp = tps[next_tp]
            hit = (b.l <= tp - through) if d == -1 else (b.h >= tp + through)
            if not hit:
                break
            qty = min(plan[next_tp], remaining)
            fills.append((b.t, qty, tp, f"TP{next_tp + 1}"))
            remaining -= qty
            if next_tp == 0:
                be_pending_from = b.t + 1
            next_tp += 1
        if remaining == 0:
            exit_t, reason = b.t, f"TP{next_tp}"
            break
        if (d == -1 and b.l < best) or (d == 1 and b.h > best):
            best, best_t = (b.l if d == -1 else b.h), b.t

    status = "FILLED" if remaining == 0 else "OPEN"
    pts = sum(qty * (px - fill) * d for _, qty, px, _ in fills)
    closed_q = sum(qty for _, qty, _, _ in fills)
    pnl = pts * tv - fee * closed_q
    r = pnl / (risk * tv * q) if status == "FILLED" else None
    return Trade(status, fb.t, fill, exit_t, reason, fills, pnl if status == "FILLED" else None, r, risk)


def report(trade_rows: pd.DataFrame) -> dict:
    """Kennzahlen aus Engine.trades_frame()."""
    df = trade_rows.dropna(subset=["R"]) if len(trade_rows) else trade_rows
    if not len(df):
        return {"trades": 0}
    r = df["R"].to_numpy()
    usd = df["usd"].to_numpy()
    eq = usd.cumsum()
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]
    wins = usd[usd > 0]
    losses = usd[usd <= 0]
    scratch = np.abs(r) < 0.1
    return {
        "trades": int(len(df)),
        "trade_days": int(df["date"].nunique()),
        "winrate_pct": round(float(100 * (usd > 0).mean()), 1),
        "winrate_scratch_as_loss_pct": round(float(100 * ((usd > 0) & ~scratch).mean()), 1),
        "avg_R": round(float(r.mean()), 3),
        "total_R": round(float(r.sum()), 2),
        "net_usd": round(float(usd.sum()), 2),
        "profit_factor": round(float(wins.sum() / -losses.sum()), 2) if losses.sum() < 0 else None,
        "max_drawdown_usd": round(float((eq - peak).min()), 2),
        "exits": {k: int(v) for k, v in df["exit"].value_counts().items()},
        "long_short": {k: int(v) for k, v in df["dir"].value_counts().items()},
    }
