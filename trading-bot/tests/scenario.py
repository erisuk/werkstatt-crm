"""Konstruierte Kursverläufe (Wegpunkte -> 1m-Bars) für deterministische Tests der Engine."""
from __future__ import annotations

import numpy as np
import pandas as pd

TZ = "America/New_York"


def path_bars(waypoints: list[tuple[str, float]], wiggle: float = 0.25, tick: float = 0.25) -> pd.DataFrame:
    """Wegpunkte (Zeitpunkt NY, Preis) linear pro Minute verbinden. Jede 1m-Bar: open=vorheriger Close,
    close=nächster Punkt, High/Low = +/- wiggle. Flache Stücke bekommen eine Mini-Bewegung (keine Dojis)."""
    rows = []
    for (t0, p0), (t1, p1) in zip(waypoints, waypoints[1:]):
        a, b = pd.Timestamp(t0, tz=TZ), pd.Timestamp(t1, tz=TZ)
        n = int((b - a) / pd.Timedelta(minutes=1))
        prices = np.linspace(p0, p1, n + 1)
        for k in range(n):
            o, c = prices[k], prices[k + 1]
            o, c = round(o / tick) * tick, round(c / tick) * tick
            if o == c:
                c = o + tick if p1 >= p0 else o - tick
            rows.append((a + pd.Timedelta(minutes=k), o, max(o, c) + wiggle, min(o, c) - wiggle, c))
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close"]).set_index("ts")
    df["volume"] = 100.0
    return df[~df.index.duplicated()]


def _drop_break(df):
    """17:00-18:00 entfernen (Futures-Pause)."""
    m = df.index.hour * 60 + df.index.minute
    return df[(m < 17 * 60) | (m >= 18 * 60)]


# Montag = neutraler Vortag; Dienstag = Lehrbuch-SHORT nach TJR:
# London-High 20040 + Pre-Market-High werden um 09:40 gesweept, 5m-BOS unter das 5m-Tief (~20012) um 09:50,
# Retrace über das 1m-Hoch + Equilibrium bis 10:03, danach 1m-BOS nach unten -> Einstieg ~10:07.
NQ_SHORT_DAY = [
    ("2026-03-01 18:00", 20000), ("2026-03-02 02:00", 20080), ("2026-03-02 09:00", 19930),
    ("2026-03-02 12:00", 20120), ("2026-03-02 16:59", 20000), ("2026-03-02 18:00", 20000),
    ("2026-03-02 21:00", 20020), ("2026-03-03 00:00", 19985), ("2026-03-03 03:00", 20001),
    ("2026-03-03 05:00", 20040), ("2026-03-03 08:30", 20010), ("2026-03-03 08:45", 20030),
    ("2026-03-03 09:00", 20012), ("2026-03-03 09:30", 20016), ("2026-03-03 09:33", 20035),
    ("2026-03-03 09:35", 20028), ("2026-03-03 09:40", 20055), ("2026-03-03 09:46", 20010),
    ("2026-03-03 09:47", 20014), ("2026-03-03 09:48", 20011), ("2026-03-03 09:50", 20005),
    ("2026-03-03 09:55", 19995), ("2026-03-03 10:03", 20030), ("2026-03-03 10:04", 20026),
    ("2026-03-03 10:05", 20029), ("2026-03-03 10:06", 20027), ("2026-03-03 10:12", 19990),
    ("2026-03-03 10:40", 19960), ("2026-03-03 12:00", 19940), ("2026-03-03 16:00", 19950),
]


def short_day(scale_es: float = 0.3) -> dict[str, pd.DataFrame]:
    nq = _drop_break(path_bars(NQ_SHORT_DAY))
    es_wp = [(t, round(p * scale_es * 4) / 4) for t, p in NQ_SHORT_DAY]
    es = _drop_break(path_bars(es_wp))
    return {"NQ": nq, "ES": es}
