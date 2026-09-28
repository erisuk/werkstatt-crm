"""TJR-Modell als deterministische Zustandsmaschine (ES + NQ, 1m-Basis).

Ablauf je Handelstag (Details + Quellen: research/tjr_spec_final.json):
  1. 08:30  Draws on Liquidity markieren: PDH/PDL, Asia-, London-, Vortags-NY-High/Low, 1H/4H-Swings,
            ab 09:30 zusätzlich Pre-Market-High/Low. Bereits vorher durchbrochene Levels sind tot.
  2. Sweep  Ein 1m-Docht handelt durch ein Level -> Setup (SWEPT). Gegenrichtung zum Sweep.
  3. Bestätigung auf 5m: Body-Close durch den jüngsten 5m-Swing (BOS) ODER durch den Stack-Boden der
            FVGs des Laufs ins Level (IFVG) -> CONFIRMED. Nie direkt auf der Bestätigung einsteigen.
  4. Retrace: 1m-BOS gegen die Trade-Richtung, standardmäßig nachdem 5m-Equilibrium oder eine 5m-FVG
            des neuen Laufs erreicht wurde -> ARMED.
  5. Einstieg: 1m-BOS oder 1m-IFVG zurück in Trade-Richtung, nur 09:50-10:30 NY, nur wenn der andere Index
            auf 5m in dieselbe Richtung zeigt (ES/NQ-Abgleich), Bias-Filter "lean".
  6. Stop hinter dem Retrace-Hoch/Tief ("second high") + Puffer. Ziele = nächste gegenüberliegende
            Liquidität, TP1 >= 1R. Teilgewinn + Break-even, Runner. 1 Trade pro Tag.
"""
from __future__ import annotations

import bisect
import csv
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import backtest as bt
from .config import INSTRUMENTS, ROOT, hm
from .tfstate import DOWN, NONE, UP, Bar, TFState
from .timeline import SESSION_LEN, aggregate, align, day_anchor, minute_to_ts, to_bars

HTFS = (5, 15, 60, 240)
SIDE_NAME = {UP: "HIGH", DOWN: "LOW"}
DIR_NAME = {UP: "LONG", DOWN: "SHORT", NONE: "NEUTRAL"}


def at(anchor: int, clock: str | int) -> int:
    """Minute des Handelstags (Anker 18:00) zur Uhrzeit `clock`."""
    m = hm(clock) if isinstance(clock, str) else clock
    return anchor + (m - 18 * 60) % 1440


# ---------------------------------------------------------------------------- Datenobjekte
@dataclass(eq=False)
class Level:
    id: str
    types: set
    side: int            # UP = High-Level (Buy-Side), DOWN = Low-Level (Sell-Side)
    price: int
    rank: int
    anchor_t: int
    formed_at: int
    alive: bool = True
    swept_at: int | None = None


@dataclass(eq=False)
class Setup:
    id: int
    index: str
    dir: int                  # Trade-Richtung (Sweep eines Highs -> SHORT = DOWN)
    levels: list
    created_at: int           # = sweep_time (Close der Sweep-Bar)
    sweep_bar_t: int
    sweep_extreme: int
    sweep_extreme_t: int
    leg_origin: int
    leg_origin_t: int
    state: str = "SWEPT"
    confirm_kind: str = ""
    confirm_time: int | None = None
    range_ext: int | None = None        # SHORT: Range-Low; LONG: Range-High
    range_ext_t: int | None = None
    retrace_ext: int | None = None      # SHORT: Retrace-Hoch ("second high")
    zone_touched: bool = False
    counter_bos: bool = False
    counter_bos_time: int | None = None
    smt: bool | None = None
    smt_t_eval: int | None = None
    fired_swings: set = field(default_factory=set)
    fired_stacks: set = field(default_factory=set)
    log: list = field(default_factory=list)
    end_reason: str = ""


@dataclass
class Signal:
    setup: Setup
    index: str
    instrument: str
    dir: int
    T: int                    # Entscheidungszeit (Close der Trigger-Bar)
    trigger_close: int
    stop: int
    targets: list             # Ticks
    target_kinds: list
    qty: int
    risk_ticks: int
    mult: float
    bias: int
    trigger_kind: str
    trade: "bt.Trade | None" = None


# ---------------------------------------------------------------------------- Index-Zustand
class IndexState:
    def __init__(self, name: str, df: pd.DataFrame, cfg: dict):
        self.name = name
        self.inst = INSTRUMENTS[name]
        self.tick = self.inst["tick"]
        self.bars = to_bars(df, self.tick)
        self.t = np.array([b.t for b in self.bars], dtype=np.int64)
        self.h = np.array([b.h for b in self.bars], dtype=np.int64)
        self.l = np.array([b.l for b in self.bars], dtype=np.int64)
        self.tfs = {1: TFState(1, cfg["fvg_max_age_min"][1], cfg["min_fvg_ticks"])}
        self.htf_bars = {}
        self.ptr = {}
        for tf in HTFS:
            self.tfs[tf] = TFState(tf, cfg["fvg_max_age_min"][tf], cfg["min_fvg_ticks"])
            self.htf_bars[tf] = aggregate(self.bars, tf)
            self.ptr[tf] = 0
        self.levels: list[Level] = []
        self.pos = -1

    def rng(self, t_from: int, t_to: int) -> slice:
        """1m-Bars mit Open-Zeit in [t_from, t_to)."""
        return slice(bisect.bisect_left(self.t, t_from), bisect.bisect_left(self.t, t_to))

    def max_high(self, t_from, t_to):
        s = self.rng(t_from, t_to)
        return int(self.h[s].max()) if s.stop > s.start else None

    def min_low(self, t_from, t_to):
        s = self.rng(t_from, t_to)
        return int(self.l[s].min()) if s.stop > s.start else None

    def argext(self, t_from, t_to, want_high: bool):
        s = self.rng(t_from, t_to)
        if s.stop <= s.start:
            return None, None
        arr = self.h[s] if want_high else self.l[s]
        k = int(arr.argmax() if want_high else arr.argmin())
        return int(arr[k]), int(self.t[s.start + k])

    def advance(self, k: int) -> Bar:
        """1m-Bar k verarbeiten und alle höheren TF-Bars, die bis zu ihrem Close fertig sind."""
        b = self.bars[k]
        self.pos = k
        self.tfs[1].update(b)
        closed = []
        for tf in HTFS:
            hb = self.htf_bars[tf]
            while self.ptr[tf] < len(hb) and hb[self.ptr[tf]].ct <= b.ct:
                self.tfs[tf].update(hb[self.ptr[tf]])
                closed.append(tf)
                self.ptr[tf] += 1
        return b, closed


# ---------------------------------------------------------------------------- Engine
class Engine:
    def __init__(self, frames: dict[str, pd.DataFrame], cfg: dict, calendar: dict | None = None):
        frames = align({k: v for k, v in frames.items() if v is not None and len(v)})
        if not frames:
            raise ValueError("keine Daten")
        self.cfg = cfg
        self.X = {name: IndexState(name, df, cfg) for name, df in sorted(frames.items())}
        self.names = list(self.X)
        self.pair = len(self.names) == 2
        n = {len(s.bars) for s in self.X.values()}
        if len(n) != 1:
            raise ValueError("ES/NQ-Bars nicht deckungsgleich")
        self.calendar = calendar if calendar is not None else load_calendar(cfg)
        self.signals: list[Signal] = []
        self.journal: list[dict] = []
        self.days: list[dict] = []
        self._sid = 0
        c = cfg
        self.m = {k: hm(c[k]) for k in ("scan_start", "entry_start", "alignment_deadline", "flat_time",
                                          "ny_rth_start")}
        self.m["cutoff"] = hm(c["cutoff"]) if c["cutoff"] else hm("15:00")

    # ----------------------------------------------------------------- Hauptschleife
    def run(self) -> "Engine":
        N = len(self.X[self.names[0]].bars)
        day = None
        for k in range(N):
            closed = {}
            b = {}
            for name, xs in self.X.items():
                b[name], closed[name] = xs.advance(k)
            b0 = b[self.names[0]]
            if b0.day != day:
                if day is not None:
                    self._end_day()
                day = b0.day
                self._start_day(day)
            self._step(b, closed[self.names[0]])
        if day is not None:
            self._end_day()
        return self

    def _start_day(self, a: int):
        self.d = {
            "anchor": a, "date": str(minute_to_ts(a + 1440).date()), "levels_built": False, "pre_added": False,
            "setups": [], "trades": 0, "done": False, "done_reason": "", "bias": NONE, "bias_draws": set(),
            "bias_info": {}, "aligned_checked": False, "busy_until": None, "last_R": None,
            "news": self.calendar.get(str(minute_to_ts(a + 1440).date()), {}),
        }
        news = self.d["news"]
        if news.get("no_trade"):
            self.d["done"], self.d["done_reason"] = True, f"NO_TRADE_DAY ({news['no_trade']})"

    def _end_day(self):
        d = self.d
        for s in d["setups"]:
            if s.state not in ("DONE",):
                self._close_setup(s, "CUTOFF" if s.state != "IN_TRADE" else "ENTERED")
        self.days.append({"date": d["date"], "trades": d["trades"], "bias": DIR_NAME[d["bias"]],
                          "done_reason": d["done_reason"], "setups": len(d["setups"])})

    def _step(self, b: dict, closed: list):
        d, a = self.d, self.d["anchor"]
        b0 = b[self.names[0]]
        t, T = b0.t, b0.ct
        scan, flat = at(a, self.m["scan_start"]), at(a, self.m["flat_time"])
        if t < scan or t >= flat:
            return
        cutoff = at(a, self.m["cutoff"])
        if not d["levels_built"]:
            for xs in self.X.values():
                self._build_levels(xs, a, scan)
            d["levels_built"] = True
        if not d["pre_added"] and T >= at(a, "09:30") and self.cfg["include_premarket"]:
            for xs in self.X.values():
                self._add_premarket(xs, a)
            d["pre_added"] = True
        # späte 1H/4H-Swings als Levels
        for xs in self.X.values():
            for tf in (60, 240):
                if tf in closed:
                    for s in xs.tfs[tf].swings[-2:]:
                        if s.detected_at == T:
                            self._add_level(xs, f"{tf // 60}H_SWING", s.kind, s.price, 3 if tf == 60 else 4,
                                            s.anchor_t, T)
        # Bias um 09:25 und zu jedem 1H-Close
        if (T >= at(a, "09:25") and not d["bias_info"]) or (60 in closed and T > at(a, "09:25")):
            self._compute_bias(T)
        # SMT-Auswertungen
        for s in d["setups"]:
            if s.smt is None and s.smt_t_eval is not None and T >= s.smt_t_eval:
                self._eval_smt(s, T)

        if T < cutoff and not d["done"] and d["trades"] < self.cfg["max_trades_per_day"]:
            busy = d["busy_until"] is not None and T <= d["busy_until"]
            triggers = []
            for s in sorted(d["setups"], key=lambda s: (s.created_at, s.index, s.dir)):
                xs = self.X[s.index]
                if s.state == "ARMED":
                    tr = self._trigger(s, xs, b[s.index])
                    if tr:
                        triggers.append((s, tr))
                if s.state in ("CONFIRMED", "ARMED"):
                    self._continuation(s, xs, b[s.index], closed)
                elif s.state == "SWEPT":
                    if b[s.index].t > s.sweep_bar_t:
                        if s.dir == DOWN and b[s.index].h > s.sweep_extreme:
                            s.sweep_extreme, s.sweep_extreme_t = b[s.index].h, b[s.index].t
                        if s.dir == UP and b[s.index].l < s.sweep_extreme:
                            s.sweep_extreme, s.sweep_extreme_t = b[s.index].l, b[s.index].t
            for name in self.names:
                self._sweeps(self.X[name], b[name], T, create=not busy)
            if self.cfg["confirm_tf"] in closed:
                for s in list(d["setups"]):
                    if s.state == "SWEPT":
                        self._confirm(s, self.X[s.index], T)
            for s in d["setups"]:
                if s.state == "SWEPT" and T - s.created_at > self.cfg["sweep_max_age_bars"] * self.cfg["confirm_tf"]:
                    self._close_setup(s, "EXPIRED_NO_REACTION")
            if triggers and not busy:
                self._gate_and_enter(triggers, b, T)

        if not d["aligned_checked"] and T >= at(a, self.m["alignment_deadline"]):
            d["aligned_checked"] = True
            if self.pair and self.cfg["require_index_alignment"] and not d["done"] and d["trades"] == 0:
                of = [self.X[n].tfs[self.cfg["confirm_tf"]].orderflow for n in self.names]
                if of[0] != of[1] or NONE in of:
                    d["done"], d["done_reason"] = True, "ALIGNMENT_DEADLINE (ES/NQ uneinig)"
        if T >= cutoff:
            for s in d["setups"]:
                if s.state in ("SWEPT", "CONFIRMED", "ARMED"):
                    self._close_setup(s, "CUTOFF")

    # ----------------------------------------------------------------- Levels
    def _add_level(self, xs: IndexState, typ: str, side: int, price: int, rank: int, anchor_t: int,
                   formed_at: int, alive: bool = True):
        for L in xs.levels:
            if L.side == side and L.price == price:
                L.types.add(typ)
                if rank > L.rank:
                    L.rank = rank
                return L
        L = Level(f"{xs.name}:{typ}:{price}", {typ}, side, price, rank, anchor_t, formed_at, alive)
        xs.levels.append(L)
        return L

    def _session_level(self, xs, typ, t_from, t_to, formed_at, rank, scan):
        for side, want_high in ((UP, True), (DOWN, False)):
            p, pt = xs.argext(t_from, t_to, want_high)
            if p is None:
                continue
            if want_high:
                after = xs.max_high(formed_at, scan)
                alive = after is None or after <= p
            else:
                after = xs.min_low(formed_at, scan)
                alive = after is None or after >= p
            self._add_level(xs, f"{typ}_{'H' if want_high else 'L'}", side, p, rank, pt, formed_at, alive)

    def _build_levels(self, xs: IndexState, a: int, scan: int):
        xs.levels = []
        # Vortag: letzter Handelstag vor a mit Daten
        k = bisect.bisect_left(xs.t, a) - 1
        pa = day_anchor(int(xs.t[k])) if k >= 0 else None
        if pa is not None:
            self._session_level(xs, "PD", pa, pa + SESSION_LEN, pa + SESSION_LEN, 3, scan)
            if self.cfg["include_prev_ny"]:
                self._session_level(xs, "PREV_NY", at(pa, self.m["ny_rth_start"]), pa + SESSION_LEN,
                                    pa + SESSION_LEN, 2, scan)
        asia_end, lon_end = at(a, self.cfg["asia_end"]), at(a, self.cfg["london_end"])
        self._session_level(xs, "ASIA", at(a, self.cfg["asia_start"]), asia_end, asia_end, 2, scan)
        self._session_level(xs, "LONDON", at(a, self.cfg["london_start"]), lon_end, lon_end, 2, scan)
        # 1H/4H-Swings der letzten N Handelstage
        for tf, days, rank in ((60, self.cfg["lookback_1h_days"], 3), (240, self.cfg["lookback_4h_days"], 4)):
            since = self._n_days_back(xs, a, days)
            for s in xs.tfs[tf].swings:
                if s.detected_at <= scan and s.anchor_t >= since:
                    if s.kind == UP:
                        after = xs.max_high(s.detected_at, scan)
                        alive = after is None or after <= s.price
                    else:
                        after = xs.min_low(s.detected_at, scan)
                        alive = after is None or after >= s.price
                    self._add_level(xs, f"{tf // 60}H_SWING", s.kind, s.price, rank, s.anchor_t, s.detected_at, alive)

    def _n_days_back(self, xs, a, n):
        anchors = []
        k = bisect.bisect_left(xs.t, a) - 1
        while k >= 0 and len(anchors) < n:
            da = day_anchor(int(xs.t[k]))
            anchors.append(da)
            k = bisect.bisect_left(xs.t, da) - 1
        return anchors[-1] if anchors else a

    def _add_premarket(self, xs, a):
        s, e = at(a, self.m["scan_start"]), at(a, "09:30")
        for side, want_high in ((UP, True), (DOWN, False)):
            p, pt = xs.argext(s, e, want_high)
            if p is not None:
                self._add_level(xs, f"PRE_{'H' if want_high else 'L'}", side, p, 2, pt, e)

    # ----------------------------------------------------------------- Bias
    def _compute_bias(self, T: int):
        d = self.d
        trends = {}
        for tf in (240, 60):
            vals = [self.X[n].tfs[tf].trend_with_gap_flip(T) for n in self.names]
            trends[tf] = vals[0] if all(v == vals[0] for v in vals) else NONE
        t4, t1 = trends[240], trends[60]
        conflict = False
        if t4 != NONE and t1 == t4:
            bias = t4
        elif t4 != NONE and t1 != NONE:
            bias, conflict = t4, True
        elif t4 != NONE or t1 != NONE:
            bias = t4 if t4 != NONE else t1
        else:
            bias = NONE
        # Draws über/unter dem Kurs
        up, dn, draws = 0, 0, {UP: set(), DOWN: set()}
        ok = {UP: True, DOWN: True}
        for n in self.names:
            xs = self.X[n]
            close = xs.bars[xs.pos].c
            radius = self.cfg["draw_radius_pct"] * close
            u = [L for L in xs.levels if L.alive and L.formed_at <= T and L.side == UP and 0 < L.price - close <= radius]
            w = [L for L in xs.levels if L.alive and L.formed_at <= T and L.side == DOWN and 0 < close - L.price <= radius]
            up, dn = up + len(u), dn + len(w)
            draws[UP] |= {L.id for L in u}
            draws[DOWN] |= {L.id for L in w}
            ok[UP] &= bool(u)
            ok[DOWN] &= bool(w)
        if bias != NONE and not ok[bias]:
            bias = NONE
        if bias == NONE and abs(up - dn) >= self.cfg["draw_imbalance_min"]:
            bias = UP if up > dn else DOWN
        if conflict and self.cfg["htf_conflict_action"] == "stand_down" and not d["done"]:
            d["done"], d["done_reason"] = True, "HTF_CONFLICT (4H vs 1H)"
        d["bias"] = bias
        d["bias_draws"] = draws[bias] if bias != NONE else set()
        d["bias_info"] = {"t4": DIR_NAME[t4], "t1": DIR_NAME[t1], "draws_up": up, "draws_down": dn,
                          "conflict": conflict, "at": str(minute_to_ts(T).time())}

    # ----------------------------------------------------------------- Sweep / Setup
    def _sweeps(self, xs: IndexState, b: Bar, T: int, create: bool = True):
        for L in sorted(xs.levels, key=lambda L: (L.side, L.price)):
            if not L.alive or L.formed_at > b.t:
                continue
            if L.side == UP and b.h > L.price:
                L.alive, L.swept_at = False, T
                if create:
                    self._on_sweep(xs, L, DOWN, b, T)
            elif L.side == DOWN and b.l < L.price:
                L.alive, L.swept_at = False, T
                if create:
                    self._on_sweep(xs, L, UP, b, T)

    def _on_sweep(self, xs: IndexState, L: Level, dirn: int, b: Bar, T: int):
        d = self.d
        for s in d["setups"]:
            if s.index == xs.name and s.dir == dirn:
                if s.state == "SWEPT":
                    s.levels.append(L)
                    return
                if s.state in ("CONFIRMED", "ARMED"):
                    s.log.append(f"{_ts(T)} weiterer Sweep {L.id} ignoriert")
                    return
        ctf = self.cfg["confirm_tf"]
        floor_t = b.t - self.cfg["leg_max_bars"] * ctf
        sw = xs.tfs[ctf].highs if dirn == DOWN else xs.tfs[ctf].lows
        t0 = floor_t
        for s in reversed(sw):
            if s.detected_at <= T and ((dirn == DOWN and s.price >= L.price) or (dirn == UP and s.price <= L.price)):
                t0 = max(s.anchor_t, floor_t)
                break
        p, pt = xs.argext(t0, b.t + 1, want_high=(dirn == UP))
        if p is None:
            p, pt = (b.l, b.t) if dirn == DOWN else (b.h, b.t)
        a = b.day
        leg_t = a + ((pt - a) // ctf) * ctf
        self._sid += 1
        s = Setup(self._sid, xs.name, dirn, [L], T, b.t, b.h if dirn == DOWN else b.l, b.t, p, leg_t)
        s.smt_t_eval = a + ((b.t - a) // ctf + 1) * ctf  # erster confirm_tf-Close nach dem Sweep
        s.log.append(f"{_ts(T)} Sweep {L.id} -> {DIR_NAME[dirn]}-Setup")
        d["setups"].append(s)

    def _eval_smt(self, s: Setup, T: int):
        if not self.pair:
            s.smt = False
            return
        L = s.levels[0]
        other = self.X[[n for n in self.names if n != s.index][0]]
        ctf = self.cfg["confirm_tf"]
        w0 = s.created_at - self.cfg["smt_window_bars"] * ctf
        typ = next(iter(L.types))
        ref = None
        if not typ.endswith("SWING"):
            for M in other.levels:
                if typ in M.types and M.side == L.side:
                    ref = M.price
                    break
        if ref is None:
            span = self.cfg["smt_align_bars"] * ctf
            ref = (other.max_high if L.side == UP else other.min_low)(L.anchor_t - span, L.anchor_t + span + 1)
        if ref is None:
            s.smt = False
            return
        if L.side == UP:
            mx = other.max_high(w0, s.smt_t_eval)
            s.smt = mx is not None and mx <= ref
        else:
            mn = other.min_low(w0, s.smt_t_eval)
            s.smt = mn is not None and mn >= ref
        if s.smt:
            s.log.append(f"{_ts(T)} SMT: {other.name} hat das Level nicht mitgenommen")

    def _confirm(self, s: Setup, xs: IndexState, T: int):
        ctf = self.cfg["confirm_tf"]
        st = xs.tfs[ctf]
        c = st.bars[-1]
        if c.ct <= s.created_at:
            return
        sh, sl = st.pre
        kind = ""
        if s.dir == DOWN:
            if self.cfg["ifvg_enabled"] and st.ifvg_against(UP, c, s.leg_origin_t) is not None:
                kind = "IFVG"
            elif sl is not None and c.c < sl.price:
                kind = "BOS"
        else:
            if self.cfg["ifvg_enabled"] and st.ifvg_against(DOWN, c, s.leg_origin_t) is not None:
                kind = "IFVG"
            elif sh is not None and c.c > sh.price:
                kind = "BOS"
        if not kind:
            return
        s.state, s.confirm_kind, s.confirm_time = "CONFIRMED", kind, T
        p, pt = xs.argext(s.sweep_extreme_t, T, want_high=(s.dir == UP))
        s.range_ext, s.range_ext_t = p, pt
        hi, _ = xs.argext(pt + 1, T, want_high=(s.dir == DOWN))
        s.retrace_ext = hi
        s.zone_touched = s.counter_bos = False
        s.log.append(f"{_ts(T)} {ctf}m-{kind} bestätigt, Range-Extrem {p}")

    def _range_other(self, s: Setup, xs: IndexState, T: int) -> int:
        """SHORT: Range-High = jüngster confirm_tf-Swing-High zwischen Sweep-Extrem und Range-Low, sonst Sweep-Extrem."""
        st = xs.tfs[self.cfg["confirm_tf"]]
        seq = st.highs if s.dir == DOWN else st.lows
        for sw in reversed(seq):
            if sw.detected_at <= T and s.sweep_extreme_t <= sw.anchor_t < s.range_ext_t:
                return sw.price
        return s.sweep_extreme

    def _continuation(self, s: Setup, xs: IndexState, b: Bar, closed: list):
        T = b.ct
        ctf = self.cfg["confirm_tf"]
        short = s.dir == DOWN
        # (2) Abbruch
        if (short and b.h > s.sweep_extreme) or (not short and b.l < s.sweep_extreme):
            return self._close_setup(s, "CANCELLED_INVALIDATION (Sweep-Extrem überschritten)")
        if ctf in closed:
            c5 = xs.tfs[ctf].bars[-1]
            ro = self._range_other(s, xs, T)
            if (short and c5.c > ro) or (not short and c5.c < ro):
                return self._close_setup(s, "CANCELLED_INVALIDATION (Range zurückerobert)")
        # (3) neuer Lauf
        if (short and b.l < s.range_ext) or (not short and b.h > s.range_ext):
            s.range_ext, s.range_ext_t = (b.l if short else b.h), b.t
            s.state, s.zone_touched, s.counter_bos, s.retrace_ext = "CONFIRMED", False, False, None
            return
        # (4) Zone / Counter-BOS
        if b.t > s.range_ext_t:
            if short:
                s.retrace_ext = b.h if s.retrace_ext is None else max(s.retrace_ext, b.h)
            else:
                s.retrace_ext = b.l if s.retrace_ext is None else min(s.retrace_ext, b.l)
        ro = self._range_other(s, xs, T)
        zones = self.cfg["continuation_zones"]
        if short:
            eq = math.ceil((ro + s.range_ext) / 2)
            if "EQ" in zones and b.h >= eq:
                s.zone_touched = True
            if "FVG" in zones and any(b.h >= g.bottom for g in xs.tfs[ctf].eligible_gaps(DOWN, b, s.sweep_extreme_t)):
                s.zone_touched = True
        else:
            eq = math.floor((ro + s.range_ext) / 2)
            if "EQ" in zones and b.l <= eq:
                s.zone_touched = True
            if "FVG" in zones and any(b.l <= g.top for g in xs.tfs[ctf].eligible_gaps(UP, b, s.sweep_extreme_t)):
                s.zone_touched = True
        sh1, sl1 = xs.tfs[self.cfg["trigger_tf"]].pre
        if b.t > s.range_ext_t:
            if short and sh1 is not None and b.c > sh1.price:
                s.counter_bos, s.counter_bos_time = True, T
            if not short and sl1 is not None and b.c < sl1.price:
                s.counter_bos, s.counter_bos_time = True, T
        if s.state == "CONFIRMED" and s.counter_bos and (s.zone_touched or not self.cfg["require_zone_touch"]):
            s.state = "ARMED"
            s.log.append(f"{_ts(T)} Retrace bestätigt (1m-Gegen-BOS{', Zone berührt' if s.zone_touched else ''}) -> ARMED")

    def _trigger(self, s: Setup, xs: IndexState, b: Bar):
        st = xs.tfs[self.cfg["trigger_tf"]]
        sh1, sl1 = st.pre
        kind = ""
        if s.dir == DOWN:
            sw = sl1 if (sl1 is not None and sl1.anchor_t > s.range_ext_t and id(sl1) not in s.fired_swings) else None
            if sw is not None and b.c < sw.price:
                s.fired_swings.add(id(sw)); kind = "1m-BOS"
            if self.cfg["ifvg_enabled"]:
                k = st.ifvg_against(UP, b, s.range_ext_t)
                if k is not None and id(k) not in s.fired_stacks:
                    s.fired_stacks.add(id(k)); kind = kind or "1m-IFVG"
        else:
            sw = sh1 if (sh1 is not None and sh1.anchor_t > s.range_ext_t and id(sh1) not in s.fired_swings) else None
            if sw is not None and b.c > sw.price:
                s.fired_swings.add(id(sw)); kind = "1m-BOS"
            if self.cfg["ifvg_enabled"]:
                k = st.ifvg_against(DOWN, b, s.range_ext_t)
                if k is not None and id(k) not in s.fired_stacks:
                    s.fired_stacks.add(id(k)); kind = kind or "1m-IFVG"
        return kind

    # ----------------------------------------------------------------- Gates + Einstieg
    def _gate_and_enter(self, triggers: list, b: dict, T: int):
        d, a, cfg = self.d, self.d["anchor"], self.cfg
        cands = []
        for s, kind in triggers:
            if s.state != "ARMED":
                continue
            xs, bar = self.X[s.index], b[s.index]
            if T < at(a, self.m["entry_start"]):
                s.log.append(f"{_ts(T)} Trigger {kind} vor {cfg['entry_start']} -> warten (PRE_WINDOW)")
                continue
            if self._news_block(T):
                s.log.append(f"{_ts(T)} Trigger {kind} im News-Fenster -> warten")
                continue
            if not self._bias_ok(s, T):
                s.log.append(f"{_ts(T)} Trigger {kind} gegen Bias {DIR_NAME[d['bias']]} -> warten (BIAS_WAIT)")
                continue
            if self.pair and cfg["require_index_alignment"]:
                other = [n for n in self.names if n != s.index][0]
                if self.X[other].tfs[cfg["confirm_tf"]].orderflow != s.dir:
                    s.log.append(f"{_ts(T)} Trigger {kind}: {other} nicht ausgerichtet -> warten (UNALIGNED)")
                    continue
            # Stop
            price = bar.c
            buf = max(cfg["stop_buffer_ticks"], math.ceil(cfg["stop_buffer_pct"] * price))
            if s.dir == DOWN:
                ext = max(v for v in (s.retrace_ext, bar.h) if v is not None)
                stop = ext + buf
                risk = stop - price
            else:
                ext = min(v for v in (s.retrace_ext, bar.l) if v is not None)
                stop = ext - buf
                risk = price - stop
            if risk < cfg["min_stop_pct"] * price or risk > cfg["max_stop_pct"] * price:
                self._close_setup(s, f"STOP_GATE (Risiko {risk} Ticks)")
                continue
            targets, kinds = self._targets(s, xs, price, risk, T)
            if not targets:
                self._close_setup(s, "NO_TARGET (keine Liquidität >= 1R)")
                continue
            mult = 0.5 if (d["news"].get("halve") or risk > cfg["wide_stop_pct"] * price) else 1.0
            inst, qty = self._size(s.index, risk, mult)
            if qty <= 0:
                self._close_setup(s, f"SIZE/COST (Risiko {risk} Ticks)")
                continue
            r1 = abs(targets[0] - price) / risk
            with_bias = d["bias"] in (NONE, s.dir)
            cands.append((not with_bias, -r1, s.created_at, s.index,
                          Signal(s, s.index, inst, s.dir, T, price, stop, targets, kinds, qty, risk, mult, d["bias"], kind)))
        if not cands:
            return
        cands.sort(key=lambda x: x[:4])
        sig = cands[0][4]
        s = sig.setup
        s.state = "IN_TRADE"
        s.log.append(f"{_ts(T)} EINSTIEG {DIR_NAME[sig.dir]} {sig.instrument} x{sig.qty} ({sig.trigger_kind})")
        self.signals.append(sig)
        d["trades"] += 1
        for o in d["setups"]:
            if o is not s and o.state in ("SWEPT", "CONFIRMED", "ARMED"):
                self._close_setup(o, "CANCELLED (anderer Trade eröffnet)")
        # Ausführung simulieren (für Tagesstatus; nutzt nur Daten nach T)
        xs = self.X[s.index]
        sig.trade = bt.simulate_signal(xs.bars, xs.pos + 1, sig, self.cfg, flat_t=at(d["anchor"], self.m["flat_time"]),
                                       news_times=d["news"].get("red_times", []))
        tr = sig.trade
        if tr is not None and tr.exit_t is not None:
            d["busy_until"] = tr.exit_t
            d["last_R"] = tr.r_multiple
        else:
            d["busy_until"] = at(d["anchor"], self.m["flat_time"])
        if d["trades"] >= self.cfg["max_trades_per_day"] or (tr is not None and tr.r_multiple is not None and tr.r_multiple < -0.1):
            d["done"], d["done_reason"] = True, "TRADE_DONE"

    def _bias_ok(self, s: Setup, T: int) -> bool:
        mode, bias = self.cfg["bias_mode"], self.d["bias"]
        if mode == "off" or bias in (NONE, s.dir):
            return True
        if mode == "filter":
            return False
        # lean: Gegen-Bias nur, wenn der Draw des Bias geliefert wurde + SMT + anderer Index dreht mit
        if not any(L.id in self.d["bias_draws"] for L in s.levels):
            return False
        if not self.pair:
            return False
        if self.cfg["lean_requires_smt"] and not s.smt:
            return False
        other = self.X[[n for n in self.names if n != s.index][0]]
        return other.tfs[self.cfg["confirm_tf"]].orderflow_events_since(s.dir, s.created_at, T)

    def _news_block(self, T: int) -> bool:
        return any(s <= T < e for s, e in self.d["news"].get("blocks", []))

    def _targets(self, s: Setup, xs: IndexState, price: int, risk: int, T: int):
        short = s.dir == DOWN
        want = DOWN if short else UP
        cands: dict[int, str] = {}

        def add(p, kind):
            if (short and p < price - 1) or (not short and p > price + 1):
                cands.setdefault(p, kind)

        for L in xs.levels:
            if L.alive and L.formed_at <= T and L.side == want:
                add(L.price, "/".join(sorted(L.types)))
        a = self.d["anchor"]
        tp_tf = self.cfg["tp_ref_tf"]
        for sw in (xs.tfs[tp_tf].lows if short else xs.tfs[tp_tf].highs):
            if sw.anchor_t >= a and sw.detected_at <= T:
                ext = xs.min_low(sw.detected_at, T) if short else xs.max_high(sw.detected_at, T)
                if ext is None or (short and ext >= sw.price) or (not short and ext <= sw.price):
                    add(sw.price, f"{tp_tf}m_SWING")
        if self.cfg["tp_include_internal"]:
            bar = xs.bars[xs.pos]
            for tf in (15, 60, 240):
                for dirg in (UP, DOWN):
                    for g in xs.tfs[tf].eligible_gaps(dirg, bar):
                        if g.touched_at is not None:
                            continue
                        if short and g.top < price:
                            add(g.top, f"{tf}m_FVG")
                        elif not short and g.bottom > price:
                            add(g.bottom, f"{tf}m_FVG")
        ordered = sorted(cands, key=lambda p: abs(price - p))
        out, kinds, last_r = [], [], None
        for p in ordered:
            r = abs(price - p) / risk
            if not out:
                if r >= self.cfg["tp1_min_R"]:
                    out.append(p); kinds.append(cands[p]); last_r = r
            elif r >= last_r + self.cfg["tp_min_gap_R"]:
                out.append(p); kinds.append(cands[p]); last_r = r
            if len(out) >= self.cfg["max_targets"]:
                break
        if not out and self.cfg["fallback_R"]:
            p = price - self.cfg["fallback_R"] * risk if short else price + self.cfg["fallback_R"] * risk
            out, kinds = [int(round(p))], ["FALLBACK_R"]
        return out, kinds

    def _size(self, index: str, risk: int, mult: float):
        cfg = self.cfg
        inst = index
        for _ in range(2):
            spec = INSTRUMENTS[inst]
            tv = spec["tick_value"]
            slip = (cfg["slippage_ticks"] + cfg["stop_slippage_ticks"]) * tv
            per = risk * tv + spec["commission_rt"] + slip
            q = min(int(cfg["account"] * cfg["risk_pct"] * mult // per), cfg["max_contracts"])
            cost_r = (spec["commission_rt"] + slip) / (risk * tv)
            if q >= 1 and cost_r <= cfg["max_cost_R"]:
                return inst, q
            if q >= 1:
                return inst, 0
            if not (cfg["allow_micros"] and spec["micro"]):
                return inst, 0
            inst = spec["micro"]
        return inst, 0

    def _close_setup(self, s: Setup, reason: str):
        if s.state == "DONE":
            return
        entered = s.state == "IN_TRADE"
        s.state, s.end_reason = "DONE", ("ENTERED" if entered else reason)
        self.journal.append({
            "date": self.d["date"], "index": s.index, "dir": DIR_NAME[s.dir],
            "levels": ", ".join(L.id.split(":", 1)[1] for L in s.levels), "sweep": _ts(s.created_at),
            "confirm": s.confirm_kind, "smt": s.smt, "end": s.end_reason, "log": " | ".join(s.log),
        })

    # ----------------------------------------------------------------- Ergebnisse
    def trades_frame(self) -> pd.DataFrame:
        rows = []
        for sg in self.signals:
            t = sg.trade
            rows.append({
                "date": _ts(sg.T)[:10], "signal": _ts(sg.T), "index": sg.index, "instrument": sg.instrument,
                "dir": DIR_NAME[sg.dir], "trigger": sg.trigger_kind, "confirm": sg.setup.confirm_kind,
                "levels": ", ".join(sorted({t_ for L in sg.setup.levels for t_ in L.types})),
                "bias": DIR_NAME[sg.bias], "qty": sg.qty,
                "entry": t.entry_price * self._tick(sg) if t and t.entry_price is not None else None,
                "stop": sg.stop * self._tick(sg), "tp": ", ".join(f"{p * self._tick(sg):.2f}" for p in sg.targets),
                "tp_kinds": ", ".join(sg.target_kinds), "exit": t.exit_reason if t else "",
                "R": round(t.r_multiple, 2) if t and t.r_multiple is not None else None,
                "usd": round(t.pnl_usd, 2) if t and t.pnl_usd is not None else None,
            })
        return pd.DataFrame(rows)

    def _tick(self, sg):
        return INSTRUMENTS[sg.index]["tick"]


def _ts(m: int | None) -> str:
    return "" if m is None else str(minute_to_ts(m))[:16]


# ---------------------------------------------------------------------------- News-Kalender
def load_calendar(cfg: dict, path: str | Path | None = None) -> dict:
    """CSV: date,time,event,impact  (NY-Zeit; impact = red|orange). Rückgabe je Datum:
    no_trade (FOMC/CPI/NFP), halve (andere rote News), blocks [(start,end)] in Minuten, red_times."""
    path = Path(path or ROOT / cfg["news_calendar"])
    out: dict = {}
    if not path.exists():
        return out
    wait = cfg["post_release_wait_min"]
    with path.open() as f:
        for row in csv.DictReader(r for r in f if not r.lstrip().startswith("#")):
            date, tm = row["date"].strip(), (row.get("time") or "").strip()
            ev, imp = row["event"].strip(), row.get("impact", "red").strip().lower()
            dd = out.setdefault(date, {"blocks": [], "red_times": []})
            is_nt = imp == "red" and any(k.lower() in ev.lower() for k in cfg["no_trade_events"])
            if is_nt:
                dd["no_trade"] = ev
                continue
            if not tm:
                continue
            ts = pd.Timestamp(f"{date} {tm}")
            m = int((ts - pd.Timestamp("1970-01-01")) // pd.Timedelta(minutes=1))
            if imp == "red":
                dd["halve"] = True
                dd["red_times"].append(m)
            if ts.hour * 60 + ts.minute >= hm("09:30") or imp == "orange":
                dd["blocks"].append((m - 2, m + wait))
    return out
