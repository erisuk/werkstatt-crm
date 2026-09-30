"""Live-Signale (Paper-Trading) + Morgen-Briefing per Telegram.

Läuft z. B. alle 5 Minuten per GitHub Actions während der NY-Session:
    python -m tjrbot.live              # Daten holen, Engine laufen lassen, neue Signale melden
    python -m tjrbot.live --dry-run    # nur ausgeben

Datenquelle: Yahoo Finance (ES=F, NQ=F, 1m, ~7 Tage). ACHTUNG: CME-Daten bei Yahoo sind ~10 Min. verzögert,
und GitHub-Cron läuft oft einige Minuten zu spät. Die Signale sind deshalb zum Lernen/Paper-Trading gedacht,
nicht zum sekundengenauen Nachhandeln. Für echtes Live-Trading einen Echtzeit-Feed/Broker anbinden.

Es werden KEINE Orders platziert.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from . import backtest, config, data, engine, notify
from .tfstate import DOWN, UP

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state" / "live_state.json"
PAPER_LOG = ROOT / "state" / "paper_trades.csv"
NY = ZoneInfo("America/New_York")
DISCLAIMER = "Inoffizieller TJR-inspirierter Bot – nicht von TJR. Keine Anlageberatung, nur Paper-Trading."


def champion_overrides() -> dict:
    """Gelernten Champion nur nutzen, wenn in config.yaml `learning: use_champion: true` steht."""
    import yaml

    cfg_file = ROOT / "config.yaml"
    doc = yaml.safe_load(cfg_file.read_text()) if cfg_file.exists() else {}
    champ = ROOT / "state" / "champion.yaml"
    if (doc or {}).get("learning", {}).get("use_champion") and champ.exists():
        return (yaml.safe_load(champ.read_text()) or {}).get("params", {})
    return {}


def _load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"notified": [], "briefs": []}


def _save_state(st: dict):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    st["notified"] = st["notified"][-200:]
    st["briefs"] = st["briefs"][-30:]
    STATE.write_text(json.dumps(st, indent=2) + "\n")


def fmt_price(ticks: int, index: str) -> str:
    return f"{ticks * config.INSTRUMENTS[index]['tick']:.2f}"


def signal_message(sig: engine.Signal) -> str:
    ix = sig.index
    arrow = "🔴 SHORT" if sig.dir == DOWN else "🟢 LONG"
    lv = ", ".join(sorted({t for L in sig.setup.levels for t in L.types}))
    tps = "\n".join(f"   TP{i + 1}: {fmt_price(p, ix)}  ({k})" for i, (p, k) in enumerate(zip(sig.targets, sig.target_kinds)))
    r1 = abs(sig.targets[0] - sig.trigger_close) / sig.risk_ticks
    return (
        f"{arrow} {sig.instrument} – TJR-Modell-Signal\n"
        f"⏰ {engine.minute_to_ts(sig.T):%Y-%m-%d %H:%M} NY\n"
        f"💧 Sweep: {lv}\n"
        f"✅ Bestätigung: 5m-{sig.setup.confirm_kind} → Retrace → {sig.trigger_kind}\n"
        f"🎯 Einstieg ~{fmt_price(sig.trigger_close, ix)} (Markt)\n"
        f"🛑 Stop: {fmt_price(sig.stop, ix)}  ({sig.risk_ticks} Ticks)\n{tps}\n"
        f"📐 TP1 = {r1:.1f}R · Größe {sig.qty}x{' (halbe Größe)' if sig.mult < 1 else ''}\n"
        f"🧭 Bias: {engine.DIR_NAME[sig.bias]}\n\n"
        f"⚠️ Daten ~10 Min. verzögert. {DISCLAIMER}"
    )


def brief_message(eng: engine.Engine) -> str:
    d = eng.d
    lines = [f"☀️ TJR-Modell Morgen-Briefing {d['date']}",
             f"🧭 HTF-Bias: {engine.DIR_NAME[d['bias']]} {d['bias_info']}"]
    if d["news"].get("no_trade"):
        lines.append(f"🚫 Heute kein Trade: {d['news']['no_trade']}")
    for name, xs in eng.X.items():
        if xs.last is None:
            continue
        close = xs.last.c
        above = sorted((L for L in xs.levels if L.alive and L.side == UP and L.price > close), key=lambda L: L.price)[:5]
        below = sorted((L for L in xs.levels if L.alive and L.side == DOWN and L.price < close), key=lambda L: -L.price)[:5]
        lines.append(f"\n{name} @ {fmt_price(close, name)}")
        lines.append("  ⬆️ Buy-Side-Liquidität: " + ", ".join(f"{fmt_price(L.price, name)} ({'/'.join(sorted(L.types))})" for L in above))
        lines.append("  ⬇️ Sell-Side-Liquidität: " + ", ".join(f"{fmt_price(L.price, name)} ({'/'.join(sorted(L.types))})" for L in below))
    lines.append("\nPlan: Sweep eines Levels → 5m-BOS/IFVG → Retrace → 1m-Einstieg zwischen 09:50 und 10:30, ES & NQ ausgerichtet.")
    lines.append(DISCLAIMER)
    return "\n".join(lines)


def update_paper_log(eng: engine.Engine):
    tf = eng.trades_frame()
    if not len(tf):
        return
    tf = tf[tf["R"].notna()]
    old = pd.read_csv(PAPER_LOG) if PAPER_LOG.exists() else pd.DataFrame()
    merged = pd.concat([old, tf]).drop_duplicates(subset=["signal", "index"], keep="last").sort_values("signal")
    PAPER_LOG.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(PAPER_LOG, index=False)


def run(dry_run: bool = False, window_min: int = 30, frames: dict | None = None, now: datetime | None = None):
    # Yahoo liefert nur ~7 Tage 1m -> kurze Aufwärmphase (4H-Lookback ist dadurch verkürzt)
    cfg = config.load(warmup_days=1, **champion_overrides())
    if frames is None:
        frames = {"NQ": data.download_yahoo("NQ=F", "1m", "7d"), "ES": data.download_yahoo("ES=F", "1m", "7d")}
        # letzte Zeile = noch laufende Kerze (teils mit Sekunden-Zeitstempel) -> nur geschlossene Bars verwenden
        frames = {k: v[v.index.second == 0].iloc[:-1] for k, v in frames.items()}
    eng = engine.Engine(frames, cfg).run()
    st = _load_state()
    now = now or datetime.now(NY)
    last_bar = engine.minute_to_ts(eng.X[eng.names[0]].bars[-1].ct)
    msgs = []

    # Morgen-Briefing einmal pro Tag, sobald Bias und Pre-Market-Levels berechnet sind (~09:30 Datenzeit)
    today = str(now.date())
    d = eng.d
    ready = bool(d["bias_info"]) and (d["pre_added"] or not cfg["include_premarket"])  # Bias (09:25) + PRE (09:30)
    if ready and today not in st["briefs"] and d["date"] == today:
        msgs.append(brief_message(eng))
        st["briefs"].append(today)

    for sig in eng.signals:
        key = f"{sig.index}:{sig.T}"
        age = (last_bar - engine.minute_to_ts(sig.T)).total_seconds() / 60
        if key in st["notified"] or age > window_min:
            continue
        msgs.append(signal_message(sig))
        st["notified"].append(key)

    for m in msgs:
        print(m, "\n" + "-" * 50) if dry_run else notify.send(m)
    if not dry_run:
        _save_state(st)
        update_paper_log(eng)
    rep = backtest.report(eng.trades_frame())
    print(f"[live] letzte Bar {last_bar} NY, {len(eng.signals)} Signale im Datenfenster, {len(msgs)} Nachrichten. {rep}")
    return msgs


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--window", type=int, default=30, help="nur Signale der letzten N Minuten melden")
    a = p.parse_args()
    run(a.dry_run, a.window)


if __name__ == "__main__":
    main()
