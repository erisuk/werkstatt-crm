"""OHLCV-Daten laden.

Alle Zeitstempel werden intern als tz-aware America/New_York geführt, weil TJRs
Session-Zeiten (Asia, London, NY-Open 9:30) in New-York-Zeit definiert sind.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

NY = "America/New_York"
COLUMNS = ["open", "high", "low", "close", "volume"]


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Spalten klein schreiben, Index nach NY-Zeit konvertieren, sortieren, Duplikate entfernen."""
    df = df.copy()
    df.columns = [str(c).lower() for c in df.columns]
    if "volume" not in df.columns:
        df["volume"] = 0.0
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"fehlende Spalten: {missing}")
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    df.index = idx.tz_convert(NY)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df[COLUMNS].astype(float)


def load_csv(path: str | Path) -> pd.DataFrame:
    """CSV mit Spalte `timestamp`/`datetime`/`date` (UTC oder mit Offset) + OHLCV laden."""
    raw = pd.read_csv(path)
    ts_col = next((c for c in raw.columns if c.lower() in ("timestamp", "datetime", "date", "time")), None)
    if ts_col is None:
        raise ValueError("CSV braucht eine Zeitspalte (timestamp/datetime/date/time)")
    raw.index = pd.to_datetime(raw.pop(ts_col), utc=True)
    return normalize(raw)


def download_yahoo(symbol: str = "NQ=F", interval: str = "5m", period: str = "60d") -> pd.DataFrame:
    """Intraday-Daten über yfinance (nur außerhalb dieser Cloud-Sandbox nutzbar, z. B. in GitHub Actions).

    Yahoo-Limits: 1m -> 7 Tage, 5m/15m -> 60 Tage. Daten sind ~10-15 Min. verzögert.
    """
    import yfinance as yf  # optional dependency

    df = yf.download(symbol, interval=interval, period=period, progress=False, auto_adjust=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if df.empty:
        raise RuntimeError(f"keine Daten für {symbol}")
    return normalize(df)


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Auf höheres Timeframe aggregieren (z. B. '1h', '4h', '1D'). Bars werden links beschriftet."""
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    return df.resample(rule, label="left", closed="left").agg(agg).dropna(subset=["open"])


def synthetic(days: int = 30, freq: str = "5min", start: str = "2026-01-05", seed: int = 7,
              start_price: float = 20000.0) -> pd.DataFrame:
    """Zufallsdaten (Random Walk mit Session-Volatilität) – nur für Tests/Demos, keine echten Kurse."""
    rng = np.random.default_rng(seed)
    periods = int(days * 86400 / pd.Timedelta(freq).total_seconds())
    idx = pd.date_range(start=start, periods=periods, freq=freq, tz=NY)
    idx = idx[idx.dayofweek < 5]
    hours = idx.hour + idx.minute / 60
    vol = np.where((hours >= 9.5) & (hours < 11.5), 2.2, np.where((hours >= 2) & (hours < 5), 1.4, 0.7))
    rets = rng.normal(0, 1, len(idx)) * vol * 4.0
    close = start_price + np.cumsum(rets)
    open_ = np.concatenate([[start_price], close[:-1]])
    spread = np.abs(rng.normal(0, 1, len(idx))) * vol * 3.0
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - np.abs(rng.normal(0, 1, len(idx))) * vol * 3.0
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close,
                         "volume": rng.integers(100, 1000, len(idx)).astype(float)}, index=idx)
