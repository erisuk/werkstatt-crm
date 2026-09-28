"""CME-Equity-Kalender (ohne Zusatzpaket): Globex-Feiertagssessions und frühe Schlüsse.

An US-Feiertagen (MLK, Presidents, Memorial, Juneteenth, 4. Juli, Labor, Thanksgiving) läuft Globex nur
bis ~13:00 ET ohne Kassa-Eröffnung -> kein Trade, und die Session wird für PDH/PDL dem Folgetag zugeschlagen.
Frühe Schlüsse (13:15 ET: Tag nach Thanksgiving, 24.12., 3.7.) -> kein Trade (Spec: filters.EXCHANGE CALENDAR).
Tage vor einem Feiertag -> halbe Größe.
"""
from __future__ import annotations

from functools import lru_cache

import pandas as pd
from pandas.tseries.holiday import (AbstractHolidayCalendar, Holiday, USLaborDay, USMartinLutherKingJr,
                                    USMemorialDay, USPresidentsDay, USThanksgivingDay, nearest_workday)
from pandas.tseries.offsets import BDay


class _HalfDays(AbstractHolidayCalendar):
    rules = [USMartinLutherKingJr, USPresidentsDay, USMemorialDay,
             Holiday("Juneteenth", month=6, day=19, start_date="2022-01-01", observance=nearest_workday),
             Holiday("July4", month=7, day=4, observance=nearest_workday), USLaborDay, USThanksgivingDay]


@lru_cache(maxsize=1)
def _sets():
    half = {str(d.date()) for d in _HalfDays().holidays("2005-01-01", "2040-12-31")}
    early = set()
    for y in range(2005, 2041):
        tg = USThanksgivingDay.dates(f"{y}-01-01", f"{y}-12-31")[0]
        early.add(str((tg + pd.Timedelta(days=1)).date()))
        for md in ("12-24", "07-03"):
            d = pd.Timestamp(f"{y}-{md}")
            if d.dayofweek < 5:
                early.add(str(d.date()))
    full = set()
    for y in range(2005, 2041):
        for md in ("01-01", "12-25"):
            full.add(str(nearest_workday(pd.Timestamp(f"{y}-{md}")).date()))
    pre = {str((pd.Timestamp(d) - BDay(1)).date()) for d in half | full}
    return half, early - half, pre


def is_half_day(date: str) -> bool:
    return date in _sets()[0]


def is_early_close(date: str) -> bool:
    return date in _sets()[1]


def is_pre_holiday(date: str) -> bool:
    return date in _sets()[2]
