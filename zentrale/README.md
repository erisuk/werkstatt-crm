# Zentrale

Deine Kommandozentrale für Claude Code auf dem Mac – im hellen Milchglas-Look.

- **Startet Claude automatisch mit:** Öffnest du die Zentrale, läuft Claude Code sofort im Hintergrund (Anzeige oben: „Claude verbunden“).
- **Projekte & Sitzungen:** Alle Projekte, in denen du mit Claude gearbeitet hast, stehen schon da. Klick auf ein Projekt zeigt die passenden Sitzungen, „Öffnen“ setzt die Unterhaltung fort.
- **Live synchron:** Neue Sitzungen – auch aus dem Terminal – erscheinen automatisch in der Liste.
- **Agenten:** Rechts siehst du, welcher Claude gerade arbeitet.
- **Tägliche Aufgaben:** Aufträge, die Claude jeden Tag zu einer festen Uhrzeit erledigt.

## Voraussetzungen

1. **Node.js** (Version 20 oder neuer): https://nodejs.org
2. **Claude Code**, installiert und angemeldet:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude   # einmal starten und anmelden
   ```
   Die Zentrale nutzt dein Claude-Abo – kein API-Key nötig.

## Starten

```bash
cd zentrale
npm install
npm start
```

## Als richtige Mac-App bauen

```bash
npm run dist
```

Danach liegt die Installationsdatei in `dist/` (`Zentrale-0.1.0-arm64.dmg` bzw. `-x64.dmg`). Öffnen, Zentrale in den Programme-Ordner ziehen, fertig.

Die App ist nicht von Apple signiert. Beim ersten Start daher **Rechtsklick → Öffnen → Öffnen**. Wenn macOS trotzdem meldet, die App sei beschädigt: Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“.

## Gut zu wissen

- Das rote X schließt nur das Fenster, Claude arbeitet weiter. Ganz beenden mit **⌘Q**.
- Claude darf in der Zentrale Dateien im Projektordner bearbeiten (Modus „acceptEdits“). Befehle, die eine Freigabe bräuchten, werden abgelehnt.
- Tägliche Aufgaben laufen, solange die Zentrale geöffnet ist. War sie zur Uhrzeit geschlossen, läuft die Aufgabe, sobald du die Zentrale am selben Tag öffnest. Gespeichert werden sie unter `~/Library/Application Support/Zentrale/tasks.json`.
- „Stoppen“ bricht Claudes aktuelle Arbeit ab; die nächste Nachricht setzt dieselbe Sitzung fort.
- Es kann immer nur eine Zentrale gleichzeitig laufen, damit Aufgaben nicht doppelt ausgeführt werden.
- Deine Cloud-Aufgaben auf claude.ai laufen davon unabhängig weiter.

## Entwicklung

```bash
npm test   # Tests für Sitzungen, Aufgaben und Claude-Anbindung
```

| Datei | Aufgabe |
| --- | --- |
| `src/main.js` | Fenster, startet Claude, verbindet alles |
| `src/claude.js` | Spricht mit Claude Code (stream-json) |
| `src/sessions.js` | Liest die Sitzungen aus `~/.claude/projects` |
| `src/tasks.js` | Plant und speichert tägliche Aufgaben |
| `src/renderer/` | Oberfläche (HTML, CSS, JS) |
