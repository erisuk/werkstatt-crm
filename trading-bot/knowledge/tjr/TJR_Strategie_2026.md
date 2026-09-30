# TJRs Strategie – Wissensbasis (Stand: 30.09.2026)

Zusammengefasst aus: Notizen zu ~765 TJR-Videos (öffentliches Projekt *traders-debate-system*), vollständigen
Transkripten von „My UPDATED Day Trading Strategy (2026)“ (8PYgFVB0GHE, 05.06.2026), dem 6h-Tutorial
„How to start Day Trading in 2026“, dem Liquidity Guide (21./22.07.2026), dem Boot Camp 2023 und Web-Recherche.
Eigene Zusammenfassung, keine Transkript-Kopien. Inoffiziell – nicht von TJR.

**Lücke:** Zu Videos ab August 2026 gab es keine Inhalte (YouTube ist in dieser Umgebung gesperrt). Bekannte Titel
(„7 Years of Trading Advice in 10 Minutes“, Prop-Firm-Guide, Live-Trading, Vlogs) deuten auf keine Regeländerung hin.

## Das aktuelle Modell (2026) – so handelt der Bot jetzt

| Schritt | TJR 2026 | Bot-Parameter |
|---|---|---|
| Markt | Nur NQ + ES Futures, immer als Paar gelesen | ES + NQ |
| Levels | 1H-/4H-Hochs/-Tiefs, Session-Hochs/-Tiefs (Asia 18–03, London 03–08:30), Vortag, Hoch/Tief roter News-Kerzen. 5m-Hochs lohnen nicht. | `include_news_candle: true` |
| Hoch/Tief | Zwei Kerzen: Aufwärts- dann Abwärtskerze = Hoch (höchster Docht) | Two-candle-Swings |
| 1. Sweep | Docht durch ein Level genügt – ist nur eine *Gelegenheit*. Ohne Sweep kein Trade. | `require_close_back_inside: false` |
| 2. Bestätigung | 5m-BOS (Body-Close) oder 5m-IFVG (unterste Lücke im Stack), was zuerst kommt | `confirm_tf: 5` |
| 3. Retrace | Nie direkt auf der Bestätigung einsteigen. 1m-BOS gegen die Richtung, idealerweise in 5m-FVG/Equilibrium. „Ihr könnt beides nutzen“ | `require_zone_touch` (Varianten true/false) |
| 4. Einstieg | 1m-BOS oder 1m-IFVG zurück in Trade-Richtung | `trigger_tf: 1` |
| Zeit | 09:30–09:50 Manipulation, Einstieg ab 09:50 (Fenster 09:50–10:10), Deadline 10:20, Schluss 10:30. Nie Pre-Market. | `entry_start 09:50`, `alignment_deadline 10:20`, `cutoff 10:30` |
| ES/NQ | Beide müssen im 5m in dieselbe Richtung laufen, sonst kein Trade | `require_index_alignment: true` |
| Bias | Im Juni-2026-Modell kein eigener Bias-Schritt; der 5m-Orderflow entscheidet | `bias_mode: off` |
| Timeframes | Immer 5m Bestätigung / 1m Einstieg (15m-Eskalation war 2024) | `htf_conflict_action: ignore` |
| Stop | Hinter dem „zweiten Hoch/Tief“ (Retrace-Swing) | Retrace-Extrem + Puffer |
| Ziele | Nächste gegenüberliegende Liquidität, ca. 1:1 und mehr; FVGs zählen als Ziel | `tp1_min_R: 1.0` |
| Management | Teilgewinn bei TP1, Stop auf Break-even, Runner | 50 % / BE |
| News | CPI/FOMC: Größe halbieren (2023 noch: ganzer Tag frei) | `no_trade_events: []` |
| Risiko | 1–3 % pro Trade, „je weniger Trades, desto besser“ | 1 %, 1 Trade/Tag |

Seine eigenen Zahlen (selbst berichtet): 64 % Gewinntage Jan–Jun 2026, Ø Gewinn : Verlust ≈ 1,33.

## Wie sich seine Strategie entwickelt hat

| Zeit | Änderung |
|---|---|
| 2018–2021 | Forex (GBP/JPY, London-Session), „London Fakeout“ = Liquidity Sweep |
| 2022 | Fünf Bausteine: Sweep, BOS, Order Block, FVG, Equilibrium |
| 2023 | Boot Camp: Weekly→Daily→4H/1H→5m/15m, Order Blocks, News-Tage frei, 3. Konfluenz Pflicht |
| 2024 | IFVG, SMT (nachlaufender Index), Makro 09:50–10:10, 4H/1H-Konflikt → 15m, „kein Sweep = kein Trade“ |
| 2025 | SMT jetzt führender Index; Order Blocks & Breaker gestrichen; „wirklich nur ein Trade pro Tag“; FOMC selektiv (Polymarket) |
| 2026 | Feste 4 Schritte, IFVG = BOS, ES/NQ-5m-Abgleich, Cutoff 10:30, CPI/FOMC nur halbe Größe |

## Was er ausdrücklich meidet
Pre-Market-Einstiege · Einstieg direkt auf der 5m-Bestätigung · ES/NQ uneinig · nach 10:20–10:30 ohne Setup ·
Chop („Klaviertasten“) · gleiche Hochs/Tiefs direkt vor dem Einstieg · Indikatoren · Strategie wechseln nach
Verlustwochen · Revenge-Trades · Traden krank/betrunken/wütend.

## Ergebnis der Backtests (echte NQ/ES-Minutendaten 2016–05/2020, inkl. Kosten)

| Version | Trades | Treffer | Ø R | Summe R |
|---|---|---|---|---|
| TJR 2026 (neue Standardeinstellung) | 308 | 31,8 % | −0,24 | −73,6 |
| TJR 2026, Retrace-Zone optional | 335 | 34,6 % | −0,16 | −53,2 |
| Vorheriger Stand (Bias lean, 15m-Eskalation) | 210 | 32,9 % | −0,18 | −37,8 |

Mechanisch nachgebaut ist sein Modell auf diesen Daten nicht profitabel – dasselbe Ergebnis wie unabhängige
Nachbauten. Die Lernschleife (`tjrbot/optimize.py`) sucht deshalb Varianten innerhalb seines Modells.
