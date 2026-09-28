import pandas as pd
import pytest

from scenario import short_day
from tjrbot import config, engine
from tjrbot.tfstate import DOWN


def run(frames, **over):
    return engine.Engine(frames, config.load(**over), calendar={}).run()


def test_textbook_short_is_taken():
    eng = run(short_day(), bias_mode="off")
    assert len(eng.signals) == 1
    s = eng.signals[0]
    assert s.dir == DOWN and s.index == "NQ"
    t = engine.minute_to_ts(s.T)
    assert pd.Timestamp("2026-03-03 09:50") <= t < pd.Timestamp("2026-03-03 10:30")
    assert s.stop > s.trigger_close > s.targets[0]
    assert (s.trigger_close - s.targets[0]) / s.risk_ticks >= 1.0
    types = {t for L in s.setup.levels for t in L.types}
    assert "LONDON_H" in types
    assert s.trade.status == "FILLED"


def test_counter_bias_blocked_in_filter_mode():
    eng = run(short_day(), bias_mode="filter")
    assert all(sig.bias in (0, sig.dir) for sig in eng.signals)


def test_no_trade_day_from_calendar():
    cfg = config.load(bias_mode="off")
    cal = {"2026-03-03": {"no_trade": "FOMC", "blocks": [], "red_times": []}}
    eng = engine.Engine(short_day(), cfg, calendar=cal).run()
    assert not eng.signals
    assert any("NO_TRADE_DAY" in d["done_reason"] for d in eng.days)


def test_alignment_required_single_index_still_runs():
    frames = short_day()
    eng = run({"NQ": frames["NQ"]}, bias_mode="off")
    assert len(eng.signals) <= 1


def test_no_lookahead_truncated_data_gives_same_decisions():
    """Entscheidungen bis T dürfen sich nicht ändern, wenn Daten nach T fehlen."""
    frames = short_day()
    full = run(frames, bias_mode="off")
    assert full.signals
    T = engine.minute_to_ts(full.signals[0].T)
    for cut_min in (0, 1, 5, 30):
        cut = (T + pd.Timedelta(minutes=cut_min)).tz_localize("America/New_York")
        part = run({k: v[v.index < cut] for k, v in frames.items()}, bias_mode="off")
        assert [(s.T, s.index, s.dir, s.stop, s.targets) for s in part.signals] == \
               [(s.T, s.index, s.dir, s.stop, s.targets) for s in full.signals]


def test_entry_window_respected():
    eng = run(short_day(), bias_mode="off", entry_start="10:20")
    for s in eng.signals:
        assert engine.minute_to_ts(s.T) >= pd.Timestamp("2026-03-03 10:20")


def test_stop_first_when_bar_contains_stop_and_target():
    from tjrbot.backtest import simulate_signal
    from tjrbot.tfstate import Bar

    class Sig:
        dir, instrument, stop, targets, qty = DOWN, "NQ", 105, [90], 1
    bars = [Bar(0, 1, 100, 101, 99, 100, 0), Bar(1, 2, 100, 111, 85, 100, 0)]
    tr = simulate_signal(bars, 0, Sig, config.load(), flat_t=10_000)
    assert tr.exit_reason == "STOP" and tr.r_multiple < -1.0
