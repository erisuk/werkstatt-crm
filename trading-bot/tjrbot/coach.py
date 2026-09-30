"""Coach-Agent: der zweite Agent, der mit dem Bot zusammenarbeitet.

Er liest Trades, Setup-Journal, Tagesstatus und die Lern-Bestenliste, findet Fehler und Verlustursachen,
vergleicht mit TJRs Regeln und schlägt konkrete Experimente vor. Die Vorschläge landen in
state/coach_proposals.json und werden vom Optimierer beim nächsten Lauf mitgetestet – übernommen wird
aber nur, was auf ungesehenen Daten besteht (siehe optimize.py).

    python -m tjrbot.coach --reports reports            # nach run_backtest
    python -m tjrbot.coach --paper                      # Paper-Trades aus state/paper_trades.csv
Ohne ANTHROPIC_API_KEY gibt es den regelbasierten Bericht aus analysis.py.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date
from pathlib import Path

import pandas as pd

from . import analysis, notify
from .optimize import BOARD, CHAMPION, PROPOSALS, SPACE

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / "coach"
MODEL = "claude-opus-5"

SYSTEM = """Du bist der Coach-Agent eines inoffiziellen, TJR-inspirierten Trading-Bots (ES/NQ-Futures, Paper-Trading).
Das Modell: Liquidity-Sweep eines markierten Levels -> 5m-BOS/IFVG-Bestätigung -> Retrace -> 1m-Einstieg
09:50-10:30 NY, ES/NQ-Abgleich, Stop hinter dem Retrace-Extrem, Ziele an gegenüberliegender Liquidität, 1 Trade/Tag.
Du sprichst nicht als TJR. Du bist ehrlich und datengetrieben: Aussagen nur mit Zahlen aus den Daten belegen.
Kleine Stichproben (< 30 Trades in einer Gruppe) ausdrücklich als unsicher kennzeichnen.
Deine Aufgabe, auf Deutsch:
1. Zusammenfassung: Wie läuft der Bot? Warum rote/grüne Zahlen?
2. Konkrete Probleme/Fehler mit Beleg (Gruppe, Anzahl, Ø R) und Schweregrad.
3. Verlustursachen (z. B. Uhrzeit, Level-Typ, gegen den Bias, Stop zu eng, Ziele zu weit, Filter blockiert zu viel).
4. Bis zu 5 Experimente: jeweils EIN Parameter aus der erlaubten Liste mit neuem Wert und Hypothese.
Keine Garantien, keine Anlageberatung. Warne vor Überanpassung, wenn die Datenbasis klein ist."""

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "problems": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "evidence": {"type": "string"},
            "severity": {"type": "string", "enum": ["hoch", "mittel", "niedrig"]}},
            "required": ["title", "evidence", "severity"], "additionalProperties": False}},
        "loss_reasons": {"type": "array", "items": {"type": "string"}},
        "experiments": {"type": "array", "items": {"type": "object", "properties": {
            "param": {"type": "string", "enum": sorted(SPACE)}, "value": {"type": "string"},
            "hypothesis": {"type": "string"}},
            "required": ["param", "value", "hypothesis"], "additionalProperties": False}},
    },
    "required": ["summary", "problems", "loss_reasons", "experiments"],
    "additionalProperties": False,
}


def load_inputs(reports: Path | None, paper: bool):
    if paper:
        p = ROOT / "state" / "paper_trades.csv"
        return (pd.read_csv(p) if p.exists() else pd.DataFrame()), [], []
    tr = pd.read_csv(reports / "trades.csv") if (reports / "trades.csv").exists() else pd.DataFrame()
    jr = pd.read_csv(reports / "setups_journal.csv").fillna("").to_dict("records") \
        if (reports / "setups_journal.csv").exists() else []
    dy = pd.read_csv(reports / "days.csv").fillna("").to_dict("records") if (reports / "days.csv").exists() else []
    return tr, jr, dy


def ask_claude(payload: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=MODEL, max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        thinking={"type": "adaptive"}, output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=SYSTEM,
        messages=[{"role": "user", "content": "Analysiere diese Bot-Daten (JSON):\n" + json.dumps(payload, ensure_ascii=False, default=str)}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError("Coach-Anfrage abgelehnt")
    return json.loads(next(b.text for b in msg.content if b.type == "text"))


def to_markdown(res: dict, a: dict) -> str:
    lines = [f"# Coach-Bericht {date.today()}", "", res["summary"], "", "## Probleme"]
    lines += [f"- **[{p['severity']}] {p['title']}** – {p['evidence']}" for p in res["problems"]] or ["- keine"]
    lines += ["", "## Warum rote Zahlen"] + [f"- {x}" for x in res["loss_reasons"]]
    lines += ["", "## Experimente für die Lernschleife"]
    lines += [f"- `{e['param']} = {e['value']}` – {e['hypothesis']}" for e in res["experiments"]] or ["- keine"]
    lines += ["", "## Rohanalyse", "```", analysis.text_report(a), "```"]
    return "\n".join(lines)


def run(reports: Path | None = None, paper: bool = False, send: bool = True) -> dict:
    tr, jr, dy = load_inputs(reports, paper)
    a = analysis.analyze(tr, jr, dy)
    board = pd.read_csv(BOARD) if BOARD.exists() else pd.DataFrame()
    payload = {
        "analyse": a,
        "erlaubte_parameter": {k: [str(v) for v in vs] for k, vs in SPACE.items()},
        "champion": CHAMPION.read_text() if CHAMPION.exists() else None,
        "top10_lernlauf": board.nlargest(10, "train_t").to_dict("records") if len(board) and "train_t" in board else [],
    }
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        res = ask_claude(payload)
    else:
        res = {"summary": "(Regelbasierter Bericht – ANTHROPIC_API_KEY fehlt)\n" + analysis.text_report(a),
               "problems": [], "loss_reasons": [], "experiments": []}
    OUT.mkdir(parents=True, exist_ok=True)
    md = to_markdown(res, a)
    (OUT / f"{date.today()}.md").write_text(md, encoding="utf-8")
    PROPOSALS.parent.mkdir(parents=True, exist_ok=True)
    PROPOSALS.write_text(json.dumps({"date": str(date.today()), "experiments": res["experiments"]}, indent=2,
                                    ensure_ascii=False))
    if send:
        notify.send("🧑‍🏫 Coach-Bericht\n\n" + res["summary"] + "\n\n"
                    + "\n".join(f"• [{p['severity']}] {p['title']}" for p in res["problems"][:6])
                    + ("\n\nExperimente: " + ", ".join(f"{e['param']}={e['value']}" for e in res["experiments"])
                       if res["experiments"] else ""))
    return res


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--reports", default="reports")
    p.add_argument("--paper", action="store_true")
    p.add_argument("--no-send", action="store_true")
    a = p.parse_args()
    res = run(Path(a.reports), a.paper, not a.no_send)
    print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
