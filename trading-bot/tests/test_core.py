import pandas as pd
import pytest

from tjrbot import config, data, timeline
from tjrbot.tfstate import DOWN, UP, Bar, TFState


def mk(rows, t0=0, tf=1, day=0):
    """rows: (o,h,l,c) in Ticks -> Bars mit fortlaufender Zeit."""
    return [Bar(t0 + i * tf, t0 + (i + 1) * tf, o, h, l, c, day) for i, (o, h, l, c) in enumerate(rows)]


def feed(rows, **kw):
    st = TFState(1, 10_000)
    for b in mk(rows, **kw):
        st.update(b)
    return st


def test_two_candle_swing_high_and_low():
    # up, up, down (-> Swing High), down, up (-> Swing Low)
    st = feed([(10, 12, 9, 11), (11, 15, 10, 14), (14, 14, 11, 12), (12, 12, 8, 9), (9, 11, 9, 10)])
    hs, ls = st.highs, st.lows
    assert [(s.price, s.anchor_t, s.detected_at) for s in hs] == [(15, 1, 3)]
    assert [(s.price, s.anchor_t, s.detected_at) for s in ls] == [(8, 3, 5)]


def test_same_colour_candles_never_form_swing():
    st = feed([(10, 12, 9, 11), (11, 13, 10, 12), (12, 14, 11, 13)])
    assert st.swings == []


def test_doji_is_skipped():
    st = feed([(10, 12, 9, 11), (11, 13, 10, 11), (11, 11, 8, 9)])  # up, doji, down
    assert [(s.price, s.detected_at) for s in st.highs] == [(13, 3)]


def test_bos_needs_body_close_not_wick():
    rows = [(10, 12, 9, 11), (11, 15, 10, 14), (14, 14, 11, 12),   # Swing High 15
            (12, 16, 12, 15),                                        # Docht über 15, Close 15 = kein Bruch
            (15, 17, 15, 16)]                                        # Close 16 > 15 -> BOS UP
    st = feed(rows)
    bos = [e for e in st.events if e.kind == "BOS"]
    assert [(e.dir, e.t) for e in bos] == [(UP, 5)]
    assert st.orderflow == UP


def test_fvg_detection_and_inversion_event():
    rows = [(10, 11, 9, 10), (10, 20, 10, 20), (20, 22, 13, 21),   # bullish FVG 11..13
            (21, 21, 12, 12)]                                         # Close 12 < Boden 11? nein
    st = feed(rows)
    g = st.gaps[UP][0]
    assert (g.bottom, g.top, g.detected_at) == (11, 13, 3)
    assert g.inverted_at is None and g.touched_at == 4
    st.update(Bar(4, 5, 12, 12, 9, 10, 0))                         # Close 10 < 11 -> bearish IFVG
    assert g.inverted_at == 5
    assert any(e.kind == "IFVG" and e.dir == DOWN for e in st.events)


def test_gap_not_eligible_before_detection():
    rows = [(10, 11, 9, 10), (10, 20, 10, 20), (20, 22, 13, 21)]
    st = feed(rows)
    g = st.gaps[UP][0]
    assert not g.eligible(bar_t=2, bar_ct=3)      # die dritte Kerze selbst kennt die Lücke noch nicht
    assert g.eligible(bar_t=3, bar_ct=4)


def test_dst_safe_4h_bins_open_at_10_in_summer_and_winter():
    for date in ("2026-01-14", "2026-07-15"):
        idx = pd.date_range(f"{date} 09:00", f"{date} 14:59", freq="1min", tz="America/New_York")
        df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 0.0}, index=idx)
        bars = timeline.to_bars(df, 0.25)
        h4 = timeline.aggregate(bars, 240)
        opens = [str(timeline.minute_to_ts(b.t).time()) for b in h4]
        assert opens == ["06:00:00", "10:00:00"], (date, opens)  # 14:00-Bar ist noch unvollständig


def test_session_break_bars_dropped_and_trade_day_rolls_at_18():
    idx = pd.DatetimeIndex(["2026-03-02 16:59", "2026-03-02 17:30", "2026-03-02 18:00"]).tz_localize("America/New_York")
    df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}, index=idx)
    bars = timeline.to_bars(df, 0.25)
    assert len(bars) == 2 and bars[0].day != bars[1].day


def test_config_rejects_unknown_keys():
    with pytest.raises(KeyError):
        config.load(foo=1)


def test_synthetic_data_shape():
    df = data.synthetic(days=3)
    assert len(df) > 500 and (df["high"] >= df[["open", "close"]].max(axis=1)).all()
