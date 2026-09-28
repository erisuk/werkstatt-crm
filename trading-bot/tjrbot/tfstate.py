"""Marktstruktur je (Index, Timeframe) – exakt nach TJRs Definitionen, inkrementell und lookahead-frei.

Zeiten sind ganze Minuten NY-Wanduhr (siehe timeline.py). Preise sind ganze Ticks.
  * Swing (TJR "two-candle"): Aufwärtskerze gefolgt von Abwärtskerze -> Swing High (Doji werden übersprungen).
  * BOS: Schlusskurs (Body) durch den jüngsten Swing; Dochte zählen nie; Gleichstand ist kein Bruch.
  * FVG: 3-Kerzen-Lücke, wird nie gelöscht; `inverted_at` = Schluss der ersten Kerze, die durch die Lücke schließt.
  * Stack: gleichgerichtete FVGs, zwischen deren Mittelkerzen nur gleichfarbige Kerzen liegen.
  * Stack-IFVG: Schluss unter den Boden (bullisher Stack) bzw. über die Decke (bearisher Stack).
  * Orderflow: Richtung des letzten BOS- oder Stack-IFVG-Ereignisses.
"""
from __future__ import annotations

from dataclasses import dataclass, field

UP, DOWN, NONE = 1, -1, 0


@dataclass
class Bar:
    t: int      # Open-Zeit (Minuten)
    ct: int     # Close-Zeit
    o: int
    h: int
    l: int
    c: int
    day: int    # Anker (18:00-Minute) des Handelstags

    @property
    def color(self) -> int:
        return UP if self.c > self.o else DOWN if self.c < self.o else NONE


@dataclass(eq=False)
class Swing:
    kind: int           # UP = Swing High, DOWN = Swing Low
    price: int
    anchor_t: int
    detected_at: int
    broken_at: int | None = None


@dataclass(eq=False)
class Gap:
    dir: int            # UP = bullish, DOWN = bearish
    bottom: int
    top: int
    c1_t: int
    anchor_t: int
    detected_at: int
    stack: "Stack"
    touched_at: int | None = None
    inverted_at: int | None = None
    expired_at: int | None = None
    exp_sw: "Swing | None" = None      # erster gleichgerichteter Swing nach der Lücke (für Ablauf-Regel a)

    def eligible(self, bar_t: int, bar_ct: int) -> bool:
        return (self.detected_at <= bar_t
                and (self.inverted_at is None or self.inverted_at >= bar_ct)
                and (self.expired_at is None or self.expired_at > bar_t))


@dataclass(eq=False)
class Stack:
    dir: int
    members: list = field(default_factory=list)
    ifvg_at: int | None = None       # globales Stack-IFVG-Ereignis

    def edge(self, as_of: int, t0: int | None = None) -> int | None:
        """Bullish: Boden (min bottom); bearish: Decke (max top). Nur Mitglieder, die zu `as_of` bekannt sind."""
        ms = [g for g in self.members if g.detected_at <= as_of and (t0 is None or g.c1_t >= t0)]
        if not ms:
            return None
        return min(g.bottom for g in ms) if self.dir == UP else max(g.top for g in ms)


@dataclass
class Event:
    kind: str           # "BOS" | "IFVG"
    dir: int
    t: int              # detected_at


class TFState:
    def __init__(self, tf: int, fvg_max_age: int, min_fvg_ticks: int = 1):
        self.tf = tf
        self.fvg_max_age = fvg_max_age
        self.min_fvg = min_fvg_ticks
        self.bars: list[Bar] = []
        self.swings: list[Swing] = []
        self.highs: list[Swing] = []
        self.lows: list[Swing] = []
        self.sh: Swing | None = None
        self.sl: Swing | None = None
        self.pre: tuple = (None, None)        # (sh, sl) ungebrochen, Stand bei Open der letzten Bar
        self._prev_nd: int | None = None
        self.gaps: dict[int, list[Gap]] = {UP: [], DOWN: []}
        self._live: dict[int, list[Gap]] = {UP: [], DOWN: []}
        self._last_stack: dict[int, Stack | None] = {UP: None, DOWN: None}
        self._last_gap_mid: dict[int, int | None] = {UP: None, DOWN: None}
        self.events: list[Event] = []
        self.orderflow = NONE
        self.last_bos: Event | None = None

    # ------------------------------------------------------------------ Update
    def update(self, b: Bar) -> list[Event]:
        i = len(self.bars)
        self.bars.append(b)
        new: list[Event] = []
        sh = self.sh if self.sh and self.sh.broken_at is None else None
        sl = self.sl if self.sl and self.sl.broken_at is None else None
        self.pre = (sh, sl)

        # 1) BOS gegen den jüngsten Swing (Stand bei Bar-Open)
        if sl is not None and b.c < sl.price:
            sl.broken_at = b.ct
            new.append(Event("BOS", DOWN, b.ct))
        if sh is not None and b.c > sh.price:
            sh.broken_at = b.ct
            new.append(Event("BOS", UP, b.ct))

        # 2) Globales Stack-IFVG: Stack der jüngsten wählbaren Lücke je Richtung (vor Lifecycle-Update)
        for d in (UP, DOWN):
            g = self.latest_gap(d, b)
            if g is None or g.stack.ifvg_at is not None:
                continue
            edge = g.stack.edge(b.t)
            if edge is not None and ((d == UP and b.c < edge) or (d == DOWN and b.c > edge)):
                g.stack.ifvg_at = b.ct
                new.append(Event("IFVG", -d, b.ct))

        # 3) FVG-Lifecycle
        for d in (UP, DOWN):
            keep = []
            for g in self._live[d]:
                if g.touched_at is None and ((d == UP and b.l <= g.top) or (d == DOWN and b.h >= g.bottom)):
                    g.touched_at = b.ct
                if (d == UP and b.c < g.bottom) or (d == DOWN and b.c > g.top):
                    g.inverted_at = b.ct
                elif b.t - g.detected_at > self.fvg_max_age:
                    g.expired_at = b.t
                else:
                    keep.append(g)
            self._live[d] = keep

        # 4) Neue FVG (c1, c2, c3 = i-2, i-1, i; zusammenhängend, gleicher Handelstag)
        if i >= 2:
            c1, c2 = self.bars[i - 2], self.bars[i - 1]
            if c2.t == c1.ct and b.t == c2.ct and c1.day == b.day:
                if b.l - c1.h >= self.min_fvg:
                    self._add_gap(UP, c1.h, b.l, c1, c2, b, i - 1)
                if c1.l - b.h >= self.min_fvg:
                    self._add_gap(DOWN, b.h, c1.l, c1, c2, b, i - 1)

        # 5) Two-candle Swings
        if b.color != NONE:
            if self._prev_nd is not None:
                p = self.bars[self._prev_nd]
                seg = self.bars[self._prev_nd:i + 1]
                if p.color == UP and b.color == DOWN:
                    top = max(seg, key=lambda x: x.h)
                    s = Swing(UP, top.h, top.t, b.ct)
                    self.swings.append(s); self.highs.append(s); self.sh = s
                elif p.color == DOWN and b.color == UP:
                    bot = min(seg, key=lambda x: x.l)
                    s = Swing(DOWN, bot.l, bot.t, b.ct)
                    self.swings.append(s); self.lows.append(s); self.sl = s
            self._prev_nd = i

        for e in new:
            self.events.append(e)
            self.orderflow = e.dir
            if e.kind == "BOS":
                self.last_bos = e
        return new

    def _add_gap(self, d, bottom, top, c1, c2, c3, mid_idx):
        stack = self._last_stack[d]
        prev_mid = self._last_gap_mid[d]
        same = False
        if stack is not None and prev_mid is not None:
            between = self.bars[prev_mid + 1:mid_idx]
            same = all(x.color in (d, NONE) for x in between) and self.bars[prev_mid].day == c2.day
        if not same:
            stack = Stack(d)
            self._last_stack[d] = stack
        g = Gap(d, bottom, top, c1.t, c2.t, c3.ct, stack)
        stack.members.append(g)
        self.gaps[d].append(g)
        self._live[d].append(g)
        self._last_gap_mid[d] = mid_idx

    def wick_expire(self, b1: Bar) -> None:
        """FVG-Ablauf (a): unberührte Lücke, 1m-Docht jenseits des ersten gleichgerichteten Swings nach der Lücke
        ("once we push above the high ... we no longer need these gaps"). Nur mit bereits bestätigten Swings."""
        for d in (UP, DOWN):
            pool = self.highs if d == UP else self.lows
            keep = []
            for g in self._live[d]:
                sw = g.exp_sw
                if sw is None:
                    for s in reversed(pool):        # Swings sind nach Erkennung sortiert; Lücken sind jung
                        if s.anchor_t <= g.anchor_t:
                            break
                        if s.detected_at <= b1.t:
                            sw = s
                    g.exp_sw = sw
                if (g.touched_at is None and sw is not None
                        and (b1.h > sw.price if d == UP else b1.l < sw.price)):
                    g.expired_at = b1.ct   # für b1 selbst noch wählbar, ab der nächsten Bar nicht mehr
                else:
                    keep.append(g)
            self._live[d] = keep

    # ------------------------------------------------------------------ Abfragen
    def latest_gap(self, d: int, b: Bar, t0: int | None = None, min_anchor: int | None = None) -> Gap | None:
        """Jüngste für Bar b wählbare Lücke in Richtung d (optional c1_t >= t0 / anchor_t >= min_anchor)."""
        for g in reversed(self.gaps[d]):
            if b.t - g.detected_at > self.fvg_max_age:
                break
            if t0 is not None and g.c1_t < t0:
                continue
            if min_anchor is not None and g.anchor_t < min_anchor:
                continue
            if g.eligible(b.t, b.ct):
                return g
        return None

    def eligible_gaps(self, d: int, b: Bar, min_anchor: int | None = None) -> list[Gap]:
        out = []
        for g in reversed(self.gaps[d]):
            if b.t - g.detected_at > self.fvg_max_age:
                break
            if (min_anchor is None or g.anchor_t >= min_anchor) and g.eligible(b.t, b.ct):
                out.append(g)
        return out

    def ifvg_against(self, d_stack: int, b: Bar, t0: int | None) -> Stack | None:
        """Setup-IFVG: schließt b durch den Rand des Stacks der jüngsten Lücke (Richtung d_stack, c1_t >= t0)?"""
        g = self.latest_gap(d_stack, b, t0=t0)
        if g is None:
            return None
        edge = g.stack.edge(b.t, t0)
        if edge is None:
            return None
        if (d_stack == UP and b.c < edge) or (d_stack == DOWN and b.c > edge):
            return g.stack
        return None

    def trend_hh_hl(self, as_of: int) -> int:
        """HTF-Trend: letzter BOS UP + höheres Hoch + höheres Tief -> UP (DOWN spiegelbildlich), sonst NONE (Range)."""
        if self.last_bos is None:
            return NONE
        hs = [s for s in self.highs[-4:] if s.detected_at <= as_of][-2:]
        ls = [s for s in self.lows[-4:] if s.detected_at <= as_of][-2:]
        if len(hs) < 2 or len(ls) < 2:
            return NONE
        if self.last_bos.dir == UP and hs[1].price > hs[0].price and ls[1].price > ls[0].price:
            return UP
        if self.last_bos.dir == DOWN and hs[1].price < hs[0].price and ls[1].price < ls[0].price:
            return DOWN
        return NONE

    def trend_with_gap_flip(self, as_of: int) -> int:
        """Trend, der kippt, wenn der jüngste Stack in Trendrichtung (nach dem trendsetzenden BOS) invertiert wurde."""
        tr = self.trend_hh_hl(as_of)
        if tr == NONE or self.last_bos is None:
            return tr
        cand = [g for g in self.gaps[tr] if g.detected_at > self.last_bos.t and g.detected_at <= as_of]
        if cand:
            st = cand[-1].stack
            if st.ifvg_at is not None and st.ifvg_at <= as_of:
                return -tr
        return tr

    def orderflow_events_since(self, d: int, t_from: int, t_to: int) -> bool:
        for e in reversed(self.events):
            if e.t < t_from:
                break
            if e.t <= t_to and e.dir == d:
                return True
        return False
