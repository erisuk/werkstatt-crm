"""Marktstruktur-Bausteine – alle lookahead-frei.

Konvention: Eine Information "ist bekannt" erst an dem Bar-Index, an dem sie in Echtzeit bekannt wäre
(`confirmed_at`). Die Strategie darf nur Informationen mit confirmed_at <= aktueller Bar verwenden.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Swing:
    idx: int            # Bar des Hochs/Tiefs
    confirmed_at: int   # Bar, ab der der Swing feststeht (idx + right)
    price: float
    kind: str           # "high" | "low"


@dataclass(frozen=True)
class FVG:
    idx: int            # mittlere Kerze (Displacement-Kerze)
    confirmed_at: int   # dritte Kerze (idx + 1) – erst nach deren Schluss bekannt
    top: float
    bottom: float
    kind: str           # "bull" | "bear"

    @property
    def mid(self) -> float:
        return (self.top + self.bottom) / 2


def swings(df: pd.DataFrame, left: int = 2, right: int = 2) -> list[Swing]:
    """Fractal-Swings: High ist höher als die `left` Bars davor und die `right` Bars danach (strikt links,
    >= rechts, damit bei gleichen Hochs das erste zählt). Bestätigt erst `right` Bars später."""
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    out: list[Swing] = []
    for i in range(left, len(df) - right):
        if h[i] > h[i - left:i].max() and h[i] >= h[i + 1:i + right + 1].max():
            out.append(Swing(i, i + right, float(h[i]), "high"))
        if l[i] < l[i - left:i].min() and l[i] <= l[i + 1:i + right + 1].min():
            out.append(Swing(i, i + right, float(l[i]), "low"))
    out.sort(key=lambda s: (s.confirmed_at, s.idx))
    return out


def fvgs(df: pd.DataFrame, min_size: float = 0.0) -> list[FVG]:
    """3-Kerzen-Imbalance. Bullish: low[i+1] > high[i-1]; bearish: high[i+1] < low[i-1]."""
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    out: list[FVG] = []
    for i in range(1, len(df) - 1):
        if l[i + 1] > h[i - 1] and l[i + 1] - h[i - 1] > min_size:
            out.append(FVG(i, i + 1, float(l[i + 1]), float(h[i - 1]), "bull"))
        if h[i + 1] < l[i - 1] and l[i - 1] - h[i + 1] > min_size:
            out.append(FVG(i, i + 1, float(l[i - 1]), float(h[i + 1]), "bear"))
    return out


def body_ratio(df: pd.DataFrame) -> np.ndarray:
    rng = (df["high"] - df["low"]).to_numpy()
    body = (df["close"] - df["open"]).abs().to_numpy()
    return np.divide(body, rng, out=np.zeros_like(body), where=rng > 0)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev = df["close"].shift()
    tr = pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(n, min_periods=1).mean()
