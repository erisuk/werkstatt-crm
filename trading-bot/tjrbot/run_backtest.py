"""Backtest des TJR-Modells.

Beispiele:
    python -m tjrbot.run_backtest --nq data/NQ_1m.csv --es data/ES_1m.csv
    python -m tjrbot.run_backtest --yahoo                  # letzte ~7 Tage 1m von Yahoo (verzögert, nur Demo)
    python -m tjrbot.run_backtest --nq ... --es ... --set bias_mode=filter --set cutoff=11:00
    python -m tjrbot.run_backtest --nq ... --es ... --variants   # TJR-Default vs. Varianten vergleichen

CSV-Format: Spalten timestamp (UTC oder mit Offset), open, high, low, close[, volume]; 1-Minuten-Bars,
Futures inkl. Overnight-Session (für Asia/London-Levels). Kontrakt-Rollover vorher sauber behandeln.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import yaml

from . import backtest, config, data, engine

VARIANTS = {
    "TJR-Default (2026)": {},
    "Zone optional (TJR 06/2026: nur 1m-BOS)": {"require_zone_touch": False},
    "Bias hart gefiltert": {"bias_mode": "filter"},
    "Bias aus": {"bias_mode": "off"},
    "Cutoff 11:00 (Boot Camp 2023)": {"cutoff": "11:00"},
    "Stop am Sweep-Extrem (2023)": {},  # Platzhalter, siehe README – nicht implementiert
    "Ohne ES/NQ-Abgleich": {"require_index_alignment": False},
    "Nur externe Ziele": {"tp_include_internal": False},
}
VARIANTS.pop("Stop am Sweep-Extrem (2023)")


def parse_set(items: list[str]) -> dict:
    out = {}
    for it in items or []:
        k, v = it.split("=", 1)
        out[k] = yaml.safe_load(v)
    return out


def load_frames(args) -> dict:
    if args.yahoo:
        return {"NQ": data.download_yahoo("NQ=F", "1m", "7d"), "ES": data.download_yahoo("ES=F", "1m", "7d")}
    if args.synthetic:
        return {"NQ": data.synthetic(days=args.synthetic, freq="1min", seed=1),
                "ES": data.synthetic(days=args.synthetic, freq="1min", seed=2, start_price=6000.0)}
    frames = {}
    if args.nq:
        frames["NQ"] = data.load_csv(args.nq)
    if args.es:
        frames["ES"] = data.load_csv(args.es)
    if not frames:
        raise SystemExit("Keine Daten: --nq/--es CSV, --yahoo oder --synthetic N angeben")
    return frames


def run_once(frames, cfg) -> tuple[engine.Engine, pd.DataFrame, dict]:
    eng = engine.Engine(frames, cfg).run()
    tf = eng.trades_frame()
    return eng, tf, backtest.report(tf)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nq"); p.add_argument("--es")
    p.add_argument("--yahoo", action="store_true")
    p.add_argument("--synthetic", type=int, default=0, help="N Tage Zufallsdaten (nur Funktionstest!)")
    p.add_argument("--config")
    p.add_argument("--set", action="append", default=[], help="Parameter überschreiben, z. B. cutoff=11:00")
    p.add_argument("--variants", action="store_true")
    p.add_argument("--out", default="reports")
    a = p.parse_args()

    frames = load_frames(a)
    cfg = config.load(a.config, **parse_set(a.set))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if not engine.load_calendar(cfg):
        print("⚠️  Kein News-Kalender (data/news_calendar.csv) – FOMC/CPI/NFP-Tage werden NICHT ausgelassen.")

    if a.variants:
        rows = []
        for name, over in VARIANTS.items():
            c = dict(cfg); c.update(over)
            _, tf, rep = run_once(frames, c)
            rows.append({"Variante": name, **{k: rep.get(k) for k in
                         ("trades", "winrate_pct", "avg_R", "total_R", "net_usd", "profit_factor", "max_drawdown_usd")}})
        df = pd.DataFrame(rows)
        print(df.to_string(index=False))
        df.to_csv(out / "variants.csv", index=False)
        return

    eng, tf, rep = run_once(frames, cfg)
    tf.to_csv(out / "trades.csv", index=False)
    pd.DataFrame(eng.journal).to_csv(out / "setups_journal.csv", index=False)
    pd.DataFrame(eng.days).to_csv(out / "days.csv", index=False)
    (out / "report.json").write_text(json.dumps(rep, indent=2, ensure_ascii=False))
    print(json.dumps(rep, indent=2, ensure_ascii=False))
    if len(tf):
        print(tf[["signal", "index", "instrument", "dir", "trigger", "levels", "entry", "stop", "tp", "exit", "R", "usd"]]
              .to_string(index=False))
    ends = pd.Series([j["end"].split(" ")[0] for j in eng.journal]).value_counts()
    print("\nSetup-Ausgänge:\n" + ends.to_string())
    print(f"\nDateien in {out}/: trades.csv, setups_journal.csv, days.csv, report.json")


if __name__ == "__main__":
    main()
