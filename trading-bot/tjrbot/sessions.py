"""Session-Fenster in New-York-Zeit und die daraus abgeleiteten Liquiditäts-Levels.

Ein Handelstag ("trade date") beginnt um 18:00 NY am Vortag (CME-Futures-Konvention). Asia/London-
Ranges eines Handelstags liegen also vor der NY-Session desselben Handelstags.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import time

import pandas as pd


@dataclass(frozen=True)
class Window:
    start: time
    end: time  # exklusiv

    def mask(self, idx: pd.DatetimeIndex) -> pd.Series:
        t = idx.time
        if self.start <= self.end:
            m = (t >= self.start) & (t < self.end)
        else:  # über Mitternacht
            m = (t >= self.start) | (t < self.end)
        return pd.Series(m, index=idx)


def parse(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def window(spec: list[str] | tuple[str, str]) -> Window:
    return Window(parse(spec[0]), parse(spec[1]))


def trade_date(idx: pd.DatetimeIndex) -> pd.Series:
    """Handelstag: Bars ab 18:00 NY zählen zum nächsten Kalendertag."""
    shifted = idx + pd.Timedelta(hours=6)
    return pd.Series(shifted.normalize().date, index=idx)


def range_levels(df: pd.DataFrame, win: Window) -> pd.DataFrame:
    """High/Low eines Session-Fensters je Handelstag + Zeitpunkt, ab dem das Range feststeht (Ende des Fensters)."""
    td = trade_date(df.index)
    m = win.mask(df.index)
    sub = df[m.to_numpy()]
    g = sub.groupby(td[m].to_numpy())
    out = pd.DataFrame({"high": g["high"].max(), "low": g["low"].min(), "last_ts": g.apply(lambda x: x.index[-1])})
    return out


def previous_day_levels(df: pd.DataFrame) -> pd.DataFrame:
    """PDH/PDL je Handelstag (Hoch/Tief des vorherigen Handelstags)."""
    td = trade_date(df.index)
    g = df.groupby(td.to_numpy())
    daily = pd.DataFrame({"high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()})
    return daily.shift(1).rename(columns={"high": "pdh", "low": "pdl", "close": "pdc"})
