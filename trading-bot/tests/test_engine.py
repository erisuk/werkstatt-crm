import pandas as pd
import pytest

from scenario import short_day
from tjrbot import config, engine
from tjrbot.tfstate import DOWN


def run(frames, **over):
    over.setdefault("warmup_days", 1)
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
    cfg = config.load(bias_mode="off", warmup_days=1)
    cal = {"2026-03-03": {"no_trade": "FOMC", "blocks": [], "red_times": []}}
    eng = engine.Engine(short_day(), cfg, calendar=cal).run()
    assert not eng.signals
    assert any("NO_TRADE_DAY" in d["done_reason"] for d in eng.days)


def test_single_index_fails_closed_on_alignment():
    frames = short_day()
    assert not run({"NQ": frames["NQ"]}, bias_mode="off").signals
    assert run({"NQ": frames["NQ"]}, bias_mode="off", require_index_alignment=False).signals


def test_warmup_blocks_first_days():
    eng = run(short_day(), bias_mode="off", warmup_days=5)
    assert not eng.signals and all("WARMUP" in d["done_reason"] for d in eng.days)


def test_missing_minute_on_one_index_keeps_other_index_bars():
    frames = short_day()
    es = frames["ES"].drop(frames["ES"].index[100:110])
    eng = engine.Engine({"NQ": frames["NQ"], "ES": es}, config.load(warmup_days=1, bias_mode="off"), calendar={}).run()
    assert len(eng.X["NQ"].bars) == len(frames["NQ"])


def test_trigger_on_bar_with_new_range_extreme_is_taken():
    """allow_trigger_on_new_extreme: starke Trigger-Kerze, die gleichzeitig ein neues Range-Tief macht."""
    from scenario import NQ_SHORT_DAY, TZ, _drop_break, path_bars
    wp = [w for w in NQ_SHORT_DAY if not ("10:06" < w[0][11:] <= "10:12")]
    i = [k for k, w in enumerate(wp) if w[0].endswith("10:06")][0]
    wp[i + 1:i + 1] = [("2026-03-03 10:07", 19990), ("2026-03-03 10:12", 19980)]
    fr = {"NQ": _drop_break(path_bars(wp)), "ES": _drop_break(path_bars([(t, round(p * 0.3 * 4) / 4) for t, p in wp]))}
    on = run(fr, bias_mode="off", require_index_alignment=False)
    off = run(fr, bias_mode="off", require_index_alignment=False, allow_trigger_on_new_extreme=False)
    t_on = [engine.minute_to_ts(s.T) for s in on.signals]
    assert t_on and t_on[0] == pd.Timestamp("2026-03-03 10:07")
    assert not off.signals or engine.minute_to_ts(off.signals[0].T) != pd.Timestamp("2026-03-03 10:07")


def test_news_regex_does_not_block_adp_or_minutes(tmp_path):
    p = tmp_path / "cal.csv"
    p.write_text("date,time,event,impact\n2026-01-07,08:15,ADP Non-Farm Employment Change,red\n"
                 "2026-01-07,14:00,FOMC Meeting Minutes,red\n2026-01-09,08:30,Non-Farm Employment Change,red\n"
                 "2026-01-13,08:30,Core CPI m/m,red\n")
    cal = engine.load_calendar(config.load(), p)
    assert "no_trade" not in cal["2026-01-07"] and cal["2026-01-07"]["halve"]
    assert cal["2026-01-09"]["no_trade"] and cal["2026-01-13"]["no_trade"]


def test_yaml_unquoted_time_is_accepted():
    assert config.hm(660) == 660 and config.hm("11:00") == 660
    run(short_day(), bias_mode="off", cutoff=660)


def test_holiday_session_is_no_trade():
    from tjrbot import cme_calendar
    assert cme_calendar.is_half_day("2026-01-19")        # MLK
    assert cme_calendar.is_early_close("2026-11-27")     # Tag nach Thanksgiving
    assert not cme_calendar.is_half_day("2026-03-03")


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
