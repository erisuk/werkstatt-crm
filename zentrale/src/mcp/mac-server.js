// MCP-Server "mac": gibt Claude Werkzeuge für Kalender, Erinnerungen, Notizen, Mail, Outlook,
// Spotlight und AppleScript. Spricht JSON-RPC 2.0 zeilenweise über stdin/stdout.
// Mitteilungen schickt die Zentrale selbst; per osascript erschienen sie als "Skripteditor".
const { serve } = require('./core');
const mac = require('../mac');
const music = require('../music');

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

// readOnly: läuft ohne Rückfrage. Alles andere fragt in der Zentrale nach.
const TOOLS = [
  { name: 'calendar_events', readOnly: true,
    description: 'Termine aus dem Mac-Kalender ab heute für die angegebene Anzahl Tage (1 = nur heute).',
    inputSchema: { type: 'object', properties: { days: num('Anzahl Tage, 1 bis 31') } },
    run: (a) => mac.calendarEvents(a.days || 1) },
  { name: 'reminders_list', readOnly: true,
    description: 'Offene Erinnerungen aus der App Erinnerungen, optional nur aus einer Liste.',
    inputSchema: { type: 'object', properties: { list: str('Name der Liste (optional)') } },
    run: (a) => mac.reminders(a.list) },
  { name: 'reminders_add', readOnly: false,
    description: 'Legt eine neue Erinnerung an.',
    inputSchema: { type: 'object', required: ['title'], properties: {
      title: str('Text der Erinnerung'), due: str('Fälligkeit als ISO-Datum, z. B. 2026-10-27T09:00 (optional)'), list: str('Name der Liste (optional)') } },
    run: (a) => mac.addReminder(a.title, a.due, a.list) },
  { name: 'notes_search', readOnly: true,
    description: 'Sucht in der App Notizen nach Titel oder Inhalt (max. 20 Treffer).',
    inputSchema: { type: 'object', properties: { query: str('Suchbegriff') } },
    run: (a) => mac.searchNotes(a.query) },
  { name: 'notes_create', readOnly: false,
    description: 'Erstellt eine neue Notiz in der App Notizen.',
    inputSchema: { type: 'object', required: ['title'], properties: { title: str('Titel'), body: str('Inhalt') } },
    run: (a) => mac.createNote(a.title, a.body) },
  { name: 'mail_unread', readOnly: true,
    description: 'Ungelesene Mails im Posteingang der App Apple Mail (nur wenn Mail geöffnet ist).',
    inputSchema: { type: 'object', properties: { limit: num('Höchstzahl, Standard 10') } },
    run: (a) => mac.mailUnread(a.limit || 10) },
  { name: 'outlook_unread', readOnly: true,
    description: 'Ungelesene Mails im Posteingang der Outlook-App auf dem Mac (klassisches Outlook, nur wenn geöffnet).',
    inputSchema: { type: 'object', properties: { limit: num('Höchstzahl, Standard 10') } },
    run: (a) => mac.outlookUnread(a.limit || 10) },
  { name: 'spotlight_search', readOnly: true,
    description: 'Sucht Dateien auf dem Mac mit Spotlight und gibt bis zu 30 Pfade zurück.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: str('Suchbegriff oder Spotlight-Abfrage') } },
    run: (a) => mac.spotlight(a.query) },
  { name: 'music_now_playing', readOnly: true,
    description: 'Was gerade in Spotify oder Apple Music läuft (Titel, Interpret, spielt/pausiert). Öffnet keine App.',
    inputSchema: { type: 'object', properties: {} },
    run: () => music.nowPlaying() },
  { name: 'music_control', readOnly: false,
    description: 'Steuert Spotify oder Apple Music: abspielen/pausieren, nächster oder vorheriger Titel. Die App muss geöffnet sein.',
    inputSchema: { type: 'object', required: ['app', 'action'], properties: {
      app: { type: 'string', enum: ['spotify', 'music'], description: 'spotify oder music (Apple Music)' },
      action: { type: 'string', enum: ['playpause', 'play', 'pause', 'next', 'previous'], description: 'Was passieren soll' } } },
    run: (a) => music.control(a.app, a.action) },
  { name: 'open', readOnly: false,
    description: 'Öffnet eine Webadresse, eine Datei (Pfad) oder eine App (App-Name) auf dem Mac.',
    inputSchema: { type: 'object', required: ['target'], properties: { target: str('URL, Pfad oder App-Name, z. B. "Microsoft Outlook"') } },
    run: (a) => mac.open(a.target) },
  { name: 'run_applescript', readOnly: false,
    description: 'Führt ein AppleScript oder JavaScript-for-Automation-Skript aus, um beliebige Mac-Apps zu steuern '
      + '(z. B. Outlook, Mail, Finder, Musik). Nutze es, wenn kein spezielleres Werkzeug passt.',
    inputSchema: { type: 'object', required: ['script'], properties: {
      script: str('Das Skript'), language: { type: 'string', enum: ['AppleScript', 'JavaScript'], description: 'Standard: AppleScript' } } },
    run: (a) => mac.runUserScript(a.script, a.language) },
];

const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name);

if (require.main === module) serve(TOOLS, 'zentrale-mac');

module.exports = { TOOLS, READ_ONLY_TOOLS };
