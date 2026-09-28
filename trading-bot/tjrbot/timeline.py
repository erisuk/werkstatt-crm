"""Zeitachse: 1m-OHLCV -> Bars in ganzen Minuten NY-Wanduhr + DST-sichere Aggregation.

Warum Wanduhr-Minuten? Alle TJR-Zeiten (09:30, 09:50, 10:30 …) sind NY-Ortszeit. Die Zeitumstellung
fällt immer auf Sonntag 02:00 – mitten in die Wochenend-Pause des Futures-Markts –, daher sind
Wanduhr-Minuten für Handelsbars eindeutig und monoton.

Handelstag: Anker = 18:00 des Vortags; Session-Ende = Anker + 23h (17:00).
Höhere Timeframes: key = Anker + floor((m - Anker)/tf)*tf, Close = min(key + tf, Session-Ende).
So öffnen 4H-Bars um 18, 22, 02, 06, 10, 14 Uhr (letzte = 3h) – auch in der Sommerzeit.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .tfstate import Bar

DAY = 1440
ANCHOR = 18 * 60
SESSION_LEN = 23 * 60


def day_anchor(m: int) -> int:
    return ((m - ANCHOR) // DAY) * DAY + ANCHOR


def mod(m: int) -> int:
    return m % DAY


def to_minutes(idx: pd.DatetimeIndex) -> np.ndarray:
    wall = idx.tz_convert("America/New_York").tz_localize(None) if idx.tz is not None else idx
    return ((wall - pd.Timestamp("1970-01-01")) // pd.Timedelta(minutes=1)).to_numpy(dtype=np.int64)


def minute_to_ts(m: int) -> pd.Timestamp:
    return pd.Timestamp("1970-01-01") + pd.Timedelta(minutes=int(m))


def to_bars(df: pd.DataFrame, tick: float) -> list[Bar]:
    """1m-DataFrame (Index tz-aware) -> Bars in Ticks. Bars außerhalb der Session (17:00-18:00) werden verworfen."""
    ms = to_minutes(pd.DatetimeIndex(df.index))
    o, h, l, c = (np.rint(df[k].to_numpy() / tick).astype(np.int64) for k in ("open", "high", "low", "close"))
    bars = []
    for i in range(len(ms)):
        m = int(ms[i])
        a = day_anchor(m)
        if m >= a + SESSION_LEN:
            continue
        hi, lo = max(h[i], o[i], c[i]), min(l[i], o[i], c[i])
        bars.append(Bar(m, m + 1, int(o[i]), int(hi), int(lo), int(c[i]), a))
    return bars


def aggregate(bars1: list[Bar], tf: int) -> list[Bar]:
    """1m-Bars -> tf-Bars (Minuten). Letzte Bar wird nur ausgegeben, wenn sie vollständig ist."""
    out: list[Bar] = []
    cur = None
    for b in bars1:
        a = b.day
        key = a + ((b.t - a) // tf) * tf
        ct = min(key + tf, a + SESSION_LEN)
        if cur is None or cur.t != key:
            if cur is not None:
                out.append(cur)
            cur = Bar(key, ct, b.o, b.h, b.l, b.c, a)
        else:
            cur.h = max(cur.h, b.h)
            cur.l = min(cur.l, b.l)
            cur.c = b.c
    if cur is not None and bars1 and bars1[-1].ct >= cur.ct:
        out.append(cur)
    return out


def align(frames: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """Nur gemeinsame Zeitstempel behalten (fehlende Minuten werden NICHT aufgefüllt)."""
    if len(frames) < 2:
        return frames
    common = None
    for df in frames.values():
        common = df.index if common is None else common.intersection(df.index)
    return {k: v.loc[common] for k, v in frames.items()}
