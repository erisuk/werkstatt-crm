// MCP-Server "web": Claude bedient die Web-Tabs der Zentrale (nicht dein Chrome).
// Lesen, Screenshot und Scrollen gehen ohne Rückfrage; Klicken, Tippen, Tasten und Öffnen nur mit Freigabe.
// Jede Aktion läuft über die Zentrale (Unix-Socket) – dort sind Passwort- und Kartenfelder gesperrt.
const { serve } = require('./core');
const { callProxy } = require('../n8n-proxy');

const call = (op, args) => callProxy(op, args, process.env.ZENTRALE_BROWSER_SOCKET, 60000);
const tab = { type: 'string', description: 'Tab-ID aus zentrale_web_tabs (ohne Angabe: der gerade angezeigte Tab)' };
const ref = { type: 'number', description: 'Nummer des Elements aus zentrale_web_read' };

const TOOLS = [
  { name: 'zentrale_web_tabs', readOnly: true,
    description: 'Listet die Web-Tabs der Zentrale (ID, Name, Adresse, Titel). Dort ist der Nutzer dauerhaft angemeldet, z. B. Gmail, Outlook, Meta.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('listTabs', {}) },
  { name: 'zentrale_web_read', readOnly: true,
    description: 'Liest einen Tab: Titel, Adresse, sichtbarer Text und alle Bedienelemente mit Nummer (ref) für zentrale_web_click/zentrale_web_type. Nach jeder Aktion neu lesen.',
    inputSchema: { type: 'object', properties: { tab } },
    run: (a) => call('read', { tab: a.tab }) },
  { name: 'zentrale_web_screenshot', readOnly: true,
    description: 'Bildschirmfoto eines Tabs, um Aufbau und Zustand der Seite zu sehen.',
    inputSchema: { type: 'object', properties: { tab } },
    run: (a) => call('screenshot', { tab: a.tab }) },
  { name: 'zentrale_web_scroll', readOnly: true,
    description: 'Scrollt einen Tab nach unten oder oben.',
    inputSchema: { type: 'object', properties: { tab, direction: { type: 'string', enum: ['down', 'up'] } } },
    run: (a) => call('scroll', { tab: a.tab, direction: a.direction }) },
  { name: 'zentrale_web_open', readOnly: false,
    description: 'Öffnet eine Webadresse in der Zentrale – im Tab derselben Website, sonst in einem neuen Tab.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'https-Adresse' } } },
    run: (a) => call('open', { url: a.url }) },
  { name: 'zentrale_web_click', readOnly: false,
    description: 'Klickt auf ein Element (ref aus zentrale_web_read). Vorher lesen, danach erneut lesen.',
    inputSchema: { type: 'object', required: ['ref'], properties: { tab, ref } },
    run: (a) => call('click', { tab: a.tab, ref: a.ref }) },
  { name: 'zentrale_web_type', readOnly: false,
    description: 'Tippt Text in ein Feld (ref aus zentrale_web_read), optional mit Enter. Passwort-, Karten- und Bankfelder sind gesperrt – die füllt der Nutzer selbst.',
    inputSchema: { type: 'object', required: ['ref', 'text'], properties: { tab, ref, text: { type: 'string' }, submit: { type: 'boolean', description: 'danach Enter drücken' } } },
    run: (a) => call('type', { tab: a.tab, ref: a.ref, text: a.text, submit: a.submit === true }) },
  { name: 'zentrale_web_key', readOnly: false,
    description: 'Drückt eine Taste im Tab: enter, tab, escape, down, up, backspace.',
    inputSchema: { type: 'object', required: ['key'], properties: { tab, key: { type: 'string', enum: ['enter', 'tab', 'escape', 'down', 'up', 'backspace'] } } },
    run: (a) => call('key', { tab: a.tab, key: a.key }) },
];

const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name);

if (require.main === module) serve(TOOLS, 'zentrale-web');

module.exports = { TOOLS, READ_ONLY_TOOLS };
