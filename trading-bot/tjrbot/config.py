"""Parameter des TJR-Modells. Defaults = TJR-nächste Variante laut research/tjr_spec_final.json.

Jeder Wert kann in config.yaml (Abschnitt `strategy:`) überschrieben werden.
"""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

INSTRUMENTS = {
    # tick in Preis-Einheiten, tick_value in USD, commission_rt = Round-Turn inkl. Börse/NFA
    "ES": {"tick": 0.25, "tick_value": 12.50, "commission_rt": 4.50, "micro": "MES"},
    "NQ": {"tick": 0.25, "tick_value": 5.00, "commission_rt": 4.50, "micro": "MNQ"},
    "MES": {"tick": 0.25, "tick_value": 1.25, "commission_rt": 1.25, "micro": None},
    "MNQ": {"tick": 0.25, "tick_value": 0.50, "commission_rt": 1.25, "micro": None},
}

DEFAULTS: dict = {
    # --- Sessions (NY-Zeit) ---
    "asia_start": "18:00", "asia_end": "03:00",
    "london_start": "03:00", "london_end": "08:30",
    "ny_pre_start": "08:30", "ny_rth_start": "09:30", "ny_rth_end": "17:00",
    "session_end": "17:00",
    # --- Tagesablauf ---
    "scan_start": "08:30",
    "entry_start": "09:50",
    "cutoff": "10:30",              # TJR persönlich; Varianten 11:00 / 11:30 / None
    "alignment_deadline": "10:20",
    "flat_time": "15:55",
    "max_hold_minutes": 180,
    "stall_minutes": 120,
    # --- Timeframes (Leiter L_aligned) ---
    "confirm_tf": 5, "trigger_tf": 1, "tp_ref_tf": 15,
    # --- Key Levels ---
    "lookback_1h_days": 3, "lookback_4h_days": 10,
    "include_prev_ny": True, "include_premarket": True,
    # --- Struktur ---
    "min_fvg_ticks": 1,
    "fvg_max_age_min": {1: 120, 5: 1440, 15: 3 * 1440, 60: 10 * 1440, 240: 20 * 1440},
    "ifvg_enabled": True,
    # --- Sweep / Setup ---
    "sweep_max_age_bars": 12,       # in confirm_tf-Bars (60 Min auf 5m)
    "leg_max_bars": 48,
    "require_close_back_inside": False,
    "continuation_zones": ["EQ", "FVG"],
    "require_zone_touch": True,     # TJR 2026-06-05 erlaubt auch False ("nur 1m BOS")
    "allow_trigger_on_new_extreme": True,
    # --- Filter / Gates ---
    "require_index_alignment": True,
    "bias_mode": "off",             # TJR 06/2026: kein Bias-Schritt mehr (5m-Orderflow entscheidet) | lean | filter
    "lean_requires_smt": True,
    "htf_conflict_action": "ignore",  # TJR 2026: immer 5m/1m | escalate_15m (2024: 15m/5m) | stand_down (2023)
    "draw_radius_pct": 0.01,
    "draw_imbalance_min": 2,
    "smt_window_bars": 6, "smt_align_bars": 1,
    # --- Stop / Ziele ---
    "stop_buffer_ticks": 2, "stop_buffer_pct": 0.00007,
    "min_stop_pct": 0.0004, "wide_stop_pct": 0.0015, "max_stop_pct": 0.003,
    "tp1_min_R": 1.0, "tp_min_gap_R": 0.25, "max_targets": 3,
    "tp_include_internal": True, "fallback_R": None, "tp_fill_through_ticks": 1,
    # --- Management ---
    "tp1_close_frac": 0.5, "tp2_close_frac_of_remaining": 0.5, "be_offset_ticks": 1,
    # --- Risiko ---
    "account": 50_000.0, "risk_pct": 0.01, "max_contracts": 10, "allow_micros": True,
    "max_cost_R": 0.15, "max_trades_per_day": 1,
    "slippage_ticks": 1, "stop_slippage_ticks": 1,
    # --- News ---
    "news_calendar": "data/news_calendar.csv",
    "post_release_wait_min": 20,
    # Regex (Anfang des Event-Namens): FOMC-Entscheid, CPI, NFP -> kein Trade. NICHT: ADP, FOMC-Minutes, PPI.
    # TJR 01/2026: an CPI/FOMC-Tagen nur halbe Größe (+ Wartezeit), kein Aussetzen mehr. 2023-Regel (ganzer Tag frei):
    # [r"^FOMC (Statement|Rate Decision|Press Conference|Economic Projections)", r"^Federal Funds Rate",
    #  r"^(Core )?CPI\b", r"^(Non-?Farm (Employment Change|Payrolls)|NFP)\b"]
    "no_trade_events": [],
    "include_news_candle": True,    # TJR 01/2026: Hoch/Tief der roten News-Kerze ist ein Draw on Liquidity
    # --- Daten / Historie ---
    "warmup_days": 20,              # vollständige Sessions vor dem ersten Trade (Spec: lookback_4h_days + 10)
    "session_start_tol_min": 5,
    "big_win_R": 3.0,               # Tag nach >= 3R -> halbe Größe (None = aus)
}


def load(path: str | Path | None = None, **overrides) -> dict:
    cfg = {k: (v.copy() if isinstance(v, (dict, list)) else v) for k, v in DEFAULTS.items()}
    path = Path(path) if path else ROOT / "config.yaml"
    if path.exists():
        doc = yaml.safe_load(path.read_text()) or {}
        for k, v in (doc.get("strategy") or {}).items():
            if k not in DEFAULTS:
                raise KeyError(f"unbekannter Parameter in {path}: {k}")
            cfg[k] = v
    for k, v in overrides.items():
        if k not in DEFAULTS:
            raise KeyError(f"unbekannter Parameter: {k}")
        cfg[k] = v
    return cfg


def hm(s: str | int | None) -> int | None:
    """'09:50' -> Minuten seit Mitternacht."""
    if s is None:
        return None
    if isinstance(s, int) and not isinstance(s, bool):
        return s  # YAML 1.1 liest unquotiertes 11:00 als 660 (= Minuten)
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)
