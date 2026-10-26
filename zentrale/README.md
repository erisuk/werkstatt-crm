# Zentrale

Deine Kommandozentrale für Claude Code und deinen Mac – im Milchglas-Look, hell oder dunkel.

- **Startet Claude automatisch mit:** Öffnest du die Zentrale, läuft Claude Code sofort im Hintergrund (oben: „Claude bereit“).
- **Projekte & Gespräche:** Alle Projekte, in denen du mit Claude gearbeitet hast, stehen schon da. Klick auf ein Projekt zeigt die Gespräche dazu, „Öffnen“ setzt sie fort. Neue Gespräche – auch aus dem Terminal – erscheinen automatisch.
- **Mit dem ganzen Mac verbunden:** Kalender, Erinnerungen, Notizen, Apple Mail, Outlook, Dateisuche und jede andere App per AppleScript. Dazu Gmail und Microsoft 365 über deine claude.ai-Verbindungen und Chrome über „Claude in Chrome“.
- **Freigaben:** Lesen geht ohne Rückfrage. Bevor Claude etwas sendet, anlegt, öffnet, löscht oder einen Befehl ausführt, fragt die Zentrale dich – mit genau dem, was passieren soll (z. B. Empfänger und Text einer Mail). Ist das Fenster im Hintergrund, kommt eine Mac-Mitteilung.
- **Heute-Ansicht:** Termine, offene Erinnerungen und ungelesene Mails auf einen Blick, dazu Knöpfe wie „Mein Tag“ und „Mails zusammenfassen“.
- **Tägliche Aufgaben:** Aufträge, die Claude jeden Tag zu einer festen Uhrzeit erledigt – mit denselben Freigaben.

## Voraussetzungen

1. **Node.js** (Version 20 oder neuer): https://nodejs.org
2. **Claude Code**, installiert und mit deinem claude.ai-Konto angemeldet:
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

Danach liegt die Installationsdatei in `dist/`. Öffnen, Zentrale in den Programme-Ordner ziehen, fertig. Die App ist nicht von Apple signiert: beim ersten Start **Rechtsklick → Öffnen → Öffnen**.

## Verbindungen einrichten

Alles unter **Verbindungen** in der Seitenleiste:

| Verbindung | So geht's |
| --- | --- |
| **Mein Mac** | Schalter an, dann „Zugriff testen“. macOS fragt einmal pro App, ob die Zentrale sie steuern darf – jeweils „OK“. Später änderbar unter Systemeinstellungen → Datenschutz & Sicherheit → Automation. |
| **Gmail** | Einmal auf claude.ai unter Einstellungen → Connectors verbinden. Danach erkennt die Zentrale es automatisch („Status prüfen“). |
| **Outlook** | Drei Wege: Outlook-App über „Mein Mac“ (klassisches Outlook – das „neue Outlook“ lässt sich nicht per AppleScript steuern), Outlook im Browser über Chrome, oder Microsoft 365 als claude.ai-Connector (nur mit Firmenkonto). |
| **Chrome** | Erweiterung „Claude in Chrome“ installieren und dort anmelden, dann den Schalter einschalten. |

## Gut zu wissen

- Das rote X schließt nur das Fenster, Claude arbeitet weiter. Ganz beenden mit **⌘Q**.
- Claude darf Dateien im Projektordner ohne Rückfrage bearbeiten. Alles andere läuft über die Freigaben. „Immer erlauben“ gilt nur für das aktuelle Gespräch – und bei Befehlen nur für genau diesen Befehl.
- Tägliche Aufgaben laufen, solange die Zentrale geöffnet ist. War sie zur Uhrzeit geschlossen, läuft die Aufgabe, sobald du die Zentrale am selben Tag öffnest.
- Es kann immer nur eine Zentrale gleichzeitig laufen.
- Wiederkehrende Kalendertermine zeigt der Mac-Kalender per Skript nur eingeschränkt an; im Zweifel frag Claude („Was steht heute an?“).

## Entwicklung

```bash
npm test   # Tests für Gespräche, Aufgaben, Freigaben, Mac-Anbindung und Einstellungen
```

| Datei | Aufgabe |
| --- | --- |
| `src/main.js` | Fenster, startet Claude, Freigaben, Verbindungen |
| `src/claude.js` | Spricht mit Claude Code (stream-json, Freigabe-Protokoll) |
| `src/mac.js` | Steuert Mac-Apps per JavaScript for Automation |
| `src/mcp/mac-server.js` | Stellt die Mac-Werkzeuge Claude als MCP-Server bereit |
| `src/sessions.js` | Liest die Gespräche aus `~/.claude/projects` |
| `src/tasks.js` | Plant und speichert tägliche Aufgaben |
| `src/settings.js` | Darstellung und Verbindungen |
| `src/renderer/` | Oberfläche (HTML, CSS, JS) |
