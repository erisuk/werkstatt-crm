"""Bar-basierter Backtester für Limit-/Market-Setups.

Konservative Annahmen (gegen Überoptimismus):
  * Ein Setup wird erst ab der Bar NACH seiner Erstellung (created_at + 1) handelbar.
  * Limit-Fill nur, wenn der Preis das Limit berührt; Market-Fill zum Open der nächsten Bar.
  * Treffen Stop und Ziel in derselben Bar, zählt der Stop (worst case).
  * In der Fill-Bar selbst wird nur der Stop geprüft (ob das Ziel nach dem Fill kam, ist unbekannt).
  * Slippage auf Stop-Ausführungen und Market-Einstiege, Kommission pro Kontrakt und Seite.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Setup:
    created_at: int          # Bar-Index, an dem das Setup bekannt ist (nach deren Schluss)
    direction: int           # +1 long, -1 short
    entry: float | None      # Limit-Preis; None = Market zum nächsten Open
    stop: float
    target: float
    expire_at: int           # letzte Bar, in der ein Limit noch gefüllt werden darf
    flat_at: int             # spätestens hier wird glattgestellt (Session-Ende)
    reason: str = ""
    meta: dict = field(default_factory=dict)


@dataclass
class Trade:
    setup: Setup
    entry_idx: int
    entry_price: float
    exit_idx: int
    exit_price: float
    qty: int
    exit_reason: str
    pnl_points: float
    pnl_usd: float
    r_multiple: float


@dataclass
class Costs:
    point_value: float = 20.0      # NQ: 20 $/Punkt, MNQ: 2, ES: 50, MES: 5
    tick_size: float = 0.25
    commission: float = 2.0        # $ pro Kontrakt und Seite
    slippage_ticks: int = 1


@dataclass
class Risk:
    account: float = 50_000.0
    risk_pct: float = 0.5          # % des Kontos pro Trade
    max_qty: int = 10
    partial_at_r: float | None = 1.0   # Teilgewinn bei x R (None = aus)
    partial_frac: float = 0.5
    breakeven_after_partial: bool = True
    max_trades_per_day: int = 1
    daily_loss_limit_r: float = 2.0


def _qty(risk: Risk, costs: Costs, stop_dist: float) -> int:
    if stop_dist <= 0:
        return 0
    q = math.floor(risk.account * risk.risk_pct / 100 / (stop_dist * costs.point_value))
    return max(0, min(q, risk.max_qty))


def simulate(df: pd.DataFrame, setups: list[Setup], costs: Costs | None = None,
             risk: Risk | None = None, day_key: pd.Series | None = None) -> list[Trade]:
    """Setups chronologisch abarbeiten. Immer nur eine Position gleichzeitig."""
    costs = costs or Costs()
    risk = risk or Risk()
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    n = len(df)
    days = day_key.to_numpy() if day_key is not None else np.array(df.index.date)
    slip = costs.slippage_ticks * costs.tick_size
    trades: list[Trade] = []
    busy_until = -1
    per_day: dict = {}
    day_r: dict = {}

    for s in sorted(setups, key=lambda x: x.created_at):
        start = s.created_at + 1
        if start >= n or start <= busy_until:
            continue
        d = days[start]
        if per_day.get(d, 0) >= risk.max_trades_per_day or day_r.get(d, 0.0) <= -risk.daily_loss_limit_r:
            continue

        # --- Einstieg ---
        entry_idx, entry_px = None, None
        if s.entry is None:
            entry_idx, entry_px = start, o[start] + s.direction * slip
        else:
            for i in range(start, min(s.expire_at, s.flat_at, n - 1) + 1):
                # Setup ungültig, wenn der Stop vor dem Fill erreicht wird (ohne Limit zu berühren)
                if s.direction == 1:
                    if l[i] <= s.entry:
                        entry_idx, entry_px = i, min(s.entry, o[i])  # Gap unter das Limit -> Fill zum Open
                        break
                    if h[i] >= s.target:  # Ziel ohne Retest erreicht -> Setup verfällt
                        break
                else:
                    if h[i] >= s.entry:
                        entry_idx, entry_px = i, max(s.entry, o[i])
                        break
                    if l[i] <= s.target:
                        break
        if entry_idx is None:
            continue

        stop_dist = abs(entry_px - s.stop)
        qty = _qty(risk, costs, stop_dist)
        if qty == 0 or (s.direction == 1 and s.stop >= entry_px) or (s.direction == -1 and s.stop <= entry_px):
            continue

        # --- Management ---
        stop = s.stop
        remaining = qty
        realized = 0.0  # Punkte * Kontrakte
        partial_px = entry_px + s.direction * risk.partial_at_r * stop_dist if risk.partial_at_r else None
        partial_done = False
        exit_idx, exit_px, reason = None, None, ""
        last = min(s.flat_at, n - 1)
        for i in range(entry_idx, last + 1):
            hit_stop = (l[i] <= stop) if s.direction == 1 else (h[i] >= stop)
            if hit_stop:
                px = (min(stop, o[i]) if s.direction == 1 else max(stop, o[i])) - s.direction * slip
                if i == entry_idx:
                    px = stop - s.direction * slip
                exit_idx, exit_px, reason = i, px, "stop" if not partial_done else "breakeven/stop"
                break
            if i == entry_idx:
                continue
            if partial_px is not None and not partial_done:
                if (h[i] >= partial_px) if s.direction == 1 else (l[i] <= partial_px):
                    pq = max(1, int(qty * risk.partial_frac)) if qty > 1 else 0
                    if pq:
                        realized += pq * (partial_px - entry_px) * s.direction
                        remaining -= pq
                    partial_done = True
                    if risk.breakeven_after_partial:
                        stop = entry_px
            if (h[i] >= s.target) if s.direction == 1 else (l[i] <= s.target):
                exit_idx, exit_px, reason = i, s.target, "target"
                break
        if exit_idx is None:
            exit_idx, exit_px, reason = last, c[last] - s.direction * slip, "session_end"

        realized += remaining * (exit_px - entry_px) * s.direction
        pnl_usd = realized * costs.point_value - 2 * qty * costs.commission
        risk_usd = qty * stop_dist * costs.point_value
        trades.append(Trade(s, entry_idx, float(entry_px), exit_idx, float(exit_px), qty, reason,
                            realized / qty, pnl_usd, pnl_usd / risk_usd if risk_usd else 0.0))
        busy_until = exit_idx
        per_day[d] = per_day.get(d, 0) + 1
        day_r[d] = day_r.get(d, 0.0) + trades[-1].r_multiple
    return trades


def report(trades: list[Trade], df: pd.DataFrame | None = None) -> dict:
    if not trades:
        return {"trades": 0}
    r = np.array([t.r_multiple for t in trades])
    usd = np.array([t.pnl_usd for t in trades])
    equity = usd.cumsum()
    dd = (equity - np.maximum.accumulate(np.concatenate([[0.0], equity]))[1:]).min()
    wins, losses = usd[usd > 0], usd[usd <= 0]
    return {
        "trades": len(trades),
        "winrate_pct": round(100 * len(wins) / len(trades), 1),
        "avg_r": round(float(r.mean()), 3),
        "total_r": round(float(r.sum()), 2),
        "net_usd": round(float(usd.sum()), 2),
        "profit_factor": round(float(wins.sum() / -losses.sum()), 2) if losses.sum() < 0 else float("inf"),
        "max_drawdown_usd": round(float(dd), 2),
        "exits": pd.Series([t.exit_reason for t in trades]).value_counts().to_dict(),
        "long_short": {"long": sum(t.setup.direction == 1 for t in trades),
                       "short": sum(t.setup.direction == -1 for t in trades)},
    }


def trades_frame(trades: list[Trade], df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for t in trades:
        rows.append({
            "created": df.index[t.setup.created_at], "entry_time": df.index[t.entry_idx],
            "exit_time": df.index[t.exit_idx], "dir": "long" if t.setup.direction == 1 else "short",
            "entry": t.entry_price, "stop": t.setup.stop, "target": t.setup.target, "exit": t.exit_price,
            "qty": t.qty, "exit_reason": t.exit_reason, "r": round(t.r_multiple, 2), "usd": round(t.pnl_usd, 2),
            "reason": t.setup.reason,
        })
    return pd.DataFrame(rows)
