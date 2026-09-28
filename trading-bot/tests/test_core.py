import pandas as pd
import pytest

from tjrbot import backtest, data, sessions, structure


def bars(rows, start="2026-03-02 09:30", freq="5min"):
    idx = pd.date_range(start, periods=len(rows), freq=freq, tz="America/New_York")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(volume=0.0)


def test_swing_confirmed_only_after_right_bars():
    df = bars([(1, 2, 0, 1), (1, 3, 0, 1), (1, 5, 0, 1), (1, 4, 0, 1), (1, 3, 0, 1), (1, 2, 0, 1)])
    highs = [s for s in structure.swings(df, 2, 2) if s.kind == "high"]
    assert [(s.idx, s.confirmed_at, s.price) for s in highs] == [(2, 4, 5.0)]


def test_fvg_bull_and_bear():
    df = bars([(10, 11, 9, 10), (10, 15, 10, 15), (15, 16, 12, 16),   # bull gap 11..12
               (16, 16.5, 14, 14), (14, 14, 8, 8), (8, 9, 7, 8)])       # bear gap 9..14
    kinds = {(f.kind, f.bottom, f.top, f.confirmed_at) for f in structure.fvgs(df)}
    assert ("bull", 11.0, 12.0, 2) in kinds
    assert ("bear", 9.0, 14.0, 5) in kinds


def test_same_bar_stop_and_target_counts_as_stop():
    df = bars([(100, 101, 99, 100), (100, 100.5, 98, 99), (99, 110, 90, 100), (100, 101, 99, 100)])
    s = backtest.Setup(created_at=0, direction=1, entry=99.0, stop=95.0, target=105.0, expire_at=3, flat_at=3)
    risk = backtest.Risk(partial_at_r=None)
    t = backtest.simulate(df, [s], backtest.Costs(slippage_ticks=0, commission=0), risk)
    assert len(t) == 1 and t[0].exit_reason == "stop" and t[0].exit_idx == 2
    assert t[0].r_multiple == pytest.approx(-1.0)


def test_target_hit_gives_positive_r():
    df = bars([(100, 101, 99, 100), (100, 100.5, 98.5, 99.5), (99.5, 103, 99.2, 102), (102, 106, 101, 105)])
    s = backtest.Setup(0, 1, 99.0, 97.0, 105.0, 3, 3)
    t = backtest.simulate(df, [s], backtest.Costs(slippage_ticks=0, commission=0), backtest.Risk(partial_at_r=None))
    assert t[0].exit_reason == "target" and t[0].r_multiple == pytest.approx(3.0)


def test_limit_not_filled_if_target_first():
    df = bars([(100, 101, 99, 100), (100, 106, 100, 105), (105, 105, 98, 99)])
    s = backtest.Setup(0, 1, 99.0, 97.0, 105.0, 2, 2)
    assert backtest.simulate(df, [s]) == []


def test_trade_date_rolls_at_18ny():
    idx = pd.DatetimeIndex(["2026-03-02 17:55", "2026-03-02 18:00"]).tz_localize("America/New_York")
    td = sessions.trade_date(idx)
    assert str(td.iloc[0]) == "2026-03-02" and str(td.iloc[1]) == "2026-03-03"


def test_synthetic_data_shape():
    df = data.synthetic(days=3)
    assert len(df) > 500 and (df["high"] >= df[["open", "close"]].max(axis=1)).all()
