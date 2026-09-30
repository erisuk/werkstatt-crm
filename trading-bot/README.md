# TJR-Strategie-Bot (inoffiziell)

Ein regelbasierter Bot, der die **öffentlich gelehrte** Day-Trading-Strategie des YouTubers **TJR (@TJRTrades)**
nachbildet, plus ein Monitor, der dir jedes neue TJR-Video zusammengefasst per Telegram schickt.

> ⚠️ **Inoffiziell** – nicht von TJR, nicht mit ihm verbunden. Der Bot spricht nie als TJR, sondern berichtet
> „TJR sagt …“. **Keine Anlageberatung.** Futures sind gehebelt. Erst Backtest, dann mindestens 3 Monate
> Paper-Trading, bevor echtes Geld ins Spiel kommt.

## Was drin ist

| Teil | Datei | Was es tut |
|---|---|---|
| Strategie-Engine | `tjrbot/engine.py`, `tjrbot/tfstate.py` | TJRs Modell als Zustandsmaschine auf ES + NQ (1m-Daten) |
| Backtest | `tjrbot/run_backtest.py`, `tjrbot/backtest.py` | Pessimistische Simulation inkl. Kosten, Teilgewinn, Break-even |
| Live-Signale | `tjrbot/live.py` + `.github/workflows/tjr-live.yml` | Morgen-Briefing + Signale per Telegram (Paper, keine Orders) |
| Video-Monitor | `tjrbot/monitor.py` + `.github/workflows/tjr-monitor.yml` | Neue TJR-Videos → deutsche Zusammenfassung → Telegram + `knowledge/` |
| Recherche | `research/` | Vollständige Regel-Spezifikation mit Quellen (277 Fundstellen) |

## Die Strategie (TJR, Stand 2026)

1. **Draws on Liquidity markieren (08:30 NY):** Vortages-High/Low, Asia- (18–03 Uhr) und London-Range (03–08:30),
   Vortags-NY-High/Low, 1H/4H-Swings, ab 09:30 Pre-Market-High/Low. Was vorher schon durchbrochen wurde, ist tot.
2. **Sweep:** Ein Docht handelt durch ein Level → Setup in Gegenrichtung.
3. **Bestätigung (5m):** Body-Close durch den letzten 5m-Swing (**BOS**) oder durch die FVGs, die den Preis ins
   Level getragen haben (**IFVG**). Nie direkt auf der Bestätigung einsteigen.
4. **Retrace:** Preis kommt zurück (bis Equilibrium oder in eine 5m-FVG) und macht einen 1m-BOS gegen die Richtung.
5. **Einstieg (1m):** 1m-BOS oder 1m-IFVG zurück in Trade-Richtung, **nur 09:50–10:30 NY**, nur wenn **ES und NQ**
   in dieselbe Richtung zeigen. Höherer-Timeframe-Bias (4H/1H) als „Lean“.
6. **Stop** hinter dem Retrace-Hoch/-Tief („second high“) + Puffer. **Ziele** = nächste gegenüberliegende
   Liquidität, TP1 ≥ 1R → Hälfte raus, Stop auf Break-even, Runner.
7. **Risiko:** 1 % pro Trade, **1 Trade pro Tag**, FOMC/CPI/NFP-Tage kein Trade.

Jede Regel + Quelle + TJR-Zitat steht in `research/tjr_spec_final.json`. Alle Zahlen, die TJR nie genannt hat
(z. B. Puffer, Ablaufzeiten), sind dort als „our_assumption“ markiert und in `tjrbot/config.py` einstellbar.

## Schnellstart

```bash
cd trading-bot
pip install -r requirements.txt
python -m pytest -q                                   # Tests

# Backtest mit eigenen 1m-Daten (CSV: timestamp,open,high,low,close,volume)
python -m tjrbot.run_backtest --nq data/NQ_1m.csv --es data/ES_1m.csv
python -m tjrbot.run_backtest --nq data/NQ_1m.csv --es data/ES_1m.csv --variants   # TJR-Varianten vergleichen
python -m tjrbot.run_backtest --yahoo                 # letzte ~7 Tage (Yahoo, nur Demo)

python -m tjrbot.live --dry-run                       # Live-Check ohne Telegram
python -m tjrbot.monitor --dry-run                    # neue Videos anzeigen
```

**Gute Backtest-Daten:** ≥ 2 Jahre 1m-Futures ES + NQ **inkl. Overnight-Session** (für Asia/London), sauber
pro Kontrakt gerollt – z. B. Databento, FirstRate Data, Kibot, oder Export aus deinem Broker/TradingView.
Yahoo liefert nur 7 Tage 1m und ist ~10 Min. verzögert.

## Automatisch im Hintergrund (GitHub Actions)

1. Telegram: bei [@BotFather](https://t.me/BotFather) einen Bot anlegen → Token. Dem Bot eine Nachricht
   schicken, dann `https://api.telegram.org/bot<TOKEN>/getUpdates` öffnen → `chat.id`.
2. Im GitHub-Repo unter **Settings → Secrets and variables → Actions** anlegen:
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY` (für Video-Zusammenfassungen).
3. Unter **Actions** die Workflows „TJR Video-Monitor“ und „TJR Live-Signale“ aktivieren.
   Einmalig `python -m tjrbot.monitor --init` laufen lassen (oder den ersten Lauf abwarten), damit nicht alle
   alten Videos auf einmal kommen – standardmäßig werden max. 5 gemeldet.

## Lernschleife: Analyse, Coach-Agent, Optimierer

| Teil | Datei | Aufgabe |
|---|---|---|
| Analyse | `tjrbot/analysis.py` | Gewinne/Verluste nach Uhrzeit, Level, Bestätigung, Bias, Ausstieg; welche Filter blockieren |
| Coach-Agent | `tjrbot/coach.py` | Zweiter Agent (Claude): erklärt Fehler und rote Zahlen, schlägt Experimente vor |
| Optimierer | `tjrbot/optimize.py` | Testet laufend Varianten + Coach-Vorschläge, kürt einen Champion |
| Automatik | `.github/workflows/tjr-learn.yml` | Jede Nacht: Backtest → Coach → Optimierer → Telegram |

Der Bot „lernt“ nur Parameter innerhalb von TJRs Modell. Ein neuer Champion wird nur gekürt, wenn er auf
**ungesehenen Daten** (letzte 40 % der Historie) statistisch überzeugt (t-Wert, Schwelle steigt mit der Zahl
der Versuche) und auch seine Nachbar-Varianten gut sind. Live nutzt ihn erst mit `learning.use_champion: true`.

```bash
python -m tjrbot.run_backtest --nq data/NQ_1m.csv --es data/ES_1m.csv --out reports
python -m tjrbot.coach --reports reports
python -m tjrbot.optimize --nq data/NQ_1m.csv --es data/ES_1m.csv --trials 500 --workers 8
```

## Ehrliche Grenzen

- **TJRs Handel ist teils diskretionär** („welcher Draw ist *der* Draw“, genaues „second high“, Chop, News-Reaktion).
  Der Bot nutzt feste Näherungen – er handelt nie 100 % wie TJR selbst.
- **Unabhängige Nachbauten** kamen auf 23–52 % Trefferquote und waren nach Kosten meist um die Null. TJRs
  eigene Zahlen (z. B. 64 % Gewinntage 2026) sind selbst berichtet und nicht geprüft. Kosten fressen bei den
  engen Stops viel Edge → im Report immer auf `avg_R` nach Kosten schauen.
- TJRs Regeln haben sich über die Zeit geändert (Order Blocks raus, 10:30 vs. 11:00 Cutoff, Zone Pflicht vs.
  optional, SMT leading vs. lagging). Default = neueste klare Version, der Rest als Parameter/Varianten.
- Noch nicht umgesetzt (in der Spezifikation beschrieben): 79 %-Extension, Chop-Filter, Spike-Test nach News,
  Stop am Sweep-Extrem (2023), PM-Session, Prop-Firm-Regeln, Live-Kill-Switches, 2. Trade nur nach BE/Gewinn
  mit neuem Sweep (der Parameter `max_trades_per_day: 2` ist nur grob umgesetzt).
- **Aufwärmphase:** Standardmäßig werden die ersten 20 vollständigen Sessions nur zum Aufbau von Levels/Struktur
  genutzt (`warmup_days`). Live/Yahoo nutzt 1 Tag, weil nur 7 Tage Daten verfügbar sind (4H-Lookback verkürzt).
- Feiertage (Globex-Halbtage) und frühe Schlüsse werden automatisch ausgelassen (`tjrbot/cme_calendar.py`).
- Video-Transkripte: YouTube blockiert die inoffizielle Transkript-Abfrage oft von Cloud-Servern und sie
  verstößt gegen die YouTube-AGB. Abschaltbar in `config.yaml` (`fetch_transcripts: false`); dann fasst der Bot
  Titel + Beschreibung zusammen, oder du fügst ein Transkript selbst ein:
  `python -m tjrbot.monitor --video <ID> --transcript-file transkript.txt`.
- Bezahlte/private Inhalte (Discord, Whop, Kurse) werden nicht genutzt.
