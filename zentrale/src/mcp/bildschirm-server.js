// MCP-Server "bildschirm": Claude bedient Mac-Apps per Bildschirmfoto, Klick, Tippen, Tasten und Scrollen –
// wie „Computer use“ in der Claude-App. Jede Aktion läuft über die Zentrale (Unix-Socket); dort gelten die
// Schutzregeln: Freigabe je App, App muss vorne sein, keine gesperrten Apps, nie in Passwortfelder.
const { serve } = require('./core');
const { callProxy } = require('../n8n-proxy');

const call = (op, args) => callProxy(op, args, process.env.ZENTRALE_BILDSCHIRM_SOCKET, 120000);
const app = { type: 'string', description: 'Name der App wie in bildschirm_apps (z. B. "Labelnize", "Finder", "Notizen")' };
const x = { type: 'number', description: 'Bildpunkt von links, aus bildschirm_foto' };
const y = { type: 'number', description: 'Bildpunkt von oben, aus bildschirm_foto' };

const TOOLS = [
  { name: 'bildschirm_apps', readOnly: true,
    description: 'Listet die offenen Mac-Apps (Name, welche vorne ist, ob gesperrt oder schon freigegeben). Für Webseiten nicht nötig – dafür Chrome-Erweiterung oder Web-Tabs.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('apps', {}) },
  { name: 'bildschirm_foto', readOnly: true,
    description: 'Bildschirmfoto des Hauptbildschirms. Vor jedem Klick und nach jeder Aktion machen, um zu sehen, was passiert ist. Koordinaten im Bild = Koordinaten für klick/scrollen.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('foto', {}) },
  { name: 'bildschirm_klick', readOnly: false,
    description: 'Klickt in einer App an einer Stelle (Bildpunkte aus bildschirm_foto). Holt die App vorher nach vorn; beim ersten Mal fragt die Zentrale Eris um Erlaubnis.',
    inputSchema: { type: 'object', required: ['app', 'x', 'y'], properties: { app, x, y,
      taste: { type: 'string', enum: ['links', 'rechts'] }, doppelt: { type: 'boolean', description: 'Doppelklick' } } },
    run: (a) => call('klick', a) },
  { name: 'bildschirm_tippen', readOnly: false,
    description: 'Tippt Text in das gerade ausgewählte Feld der App (ohne Enter – dafür bildschirm_taste). In Passwortfelder wird nie getippt.',
    inputSchema: { type: 'object', required: ['app', 'text'], properties: { app, text: { type: 'string' } } },
    run: (a) => call('tippen', a) },
  { name: 'bildschirm_taste', readOnly: false,
    description: 'Drückt eine Taste in der App: enter, tab, escape, backspace, loeschen, leertaste, links/rechts/hoch/runter, pos1, ende – oder eine Kombination wie taste "v" mit ["cmd"].',
    inputSchema: { type: 'object', required: ['app', 'taste'], properties: { app, taste: { type: 'string' },
      mit: { type: 'array', items: { type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl'] } } } },
    run: (a) => call('taste', a) },
  { name: 'bildschirm_scrollen', readOnly: false,
    description: 'Scrollt in der App an einer Stelle hoch oder runter.',
    inputSchema: { type: 'object', required: ['app', 'x', 'y'], properties: { app, x, y,
      richtung: { type: 'string', enum: ['hoch', 'runter'] }, menge: { type: 'number', description: '1–20, Standard 5' } } },
    run: (a) => call('scrollen', a) },
];

if (require.main === module) serve(TOOLS, 'zentrale-bildschirm');

module.exports = { TOOLS, BILDSCHIRM_TOOLS: TOOLS.map((t) => t.name) };
