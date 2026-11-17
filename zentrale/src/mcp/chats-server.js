// MCP-Server "chats": Ein Chat der Zentrale sieht die anderen offenen Chats, liest ihren Verlauf und schreibt ihnen.
// Jeder Chat startet seinen eigenen Server mit seiner Gesprächs-ID – so weiß die Zentrale, wer schreibt.
const { serve } = require('./core');
const { callProxy } = require('../n8n-proxy');

const FROM = process.env.ZENTRALE_CHAT_ID || '';
const call = (op, args, timeout = 30000) => callProxy(op, { ...args, from: FROM }, process.env.ZENTRALE_CHATS_SOCKET, timeout);
const chat = { type: 'string', description: 'Chat-ID aus chats_liste' };

const TOOLS = [
  { name: 'chats_liste', readOnly: true,
    description: 'Listet die anderen offenen Chats in der Zentrale (Chat-ID, Titel, Ordner, Stand: arbeitet/bereit/schläft/wartet auf Eris). Nutze das, wenn Eris sagt „frag den …-Chat“ oder „schau, was der andere Chat gemacht hat“.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('list', {}) },
  { name: 'chats_lesen', readOnly: true,
    description: 'Liest die letzten Nachrichten eines anderen Chats (Eris und Claude), z. B. um an dessen Ergebnis anzuknüpfen.',
    inputSchema: { type: 'object', required: ['chat'], properties: { chat, letzte: { type: 'number', description: 'wie viele Nachrichten (Standard 12, höchstens 40)' } } },
    run: (a) => call('read', { chat: a.chat, last: a.letzte }) },
  { name: 'chats_senden', readOnly: false,
    description: 'Schickt einem anderen Chat eine Nachricht und wartet (bis 10 Minuten) auf seine Antwort. Ein schlafender Chat wacht dafür auf. Der andere Chat sieht, dass die Nachricht von diesem Chat kommt. Schreib die Nachricht so, dass sie ohne diesen Verlauf verständlich ist.',
    inputSchema: { type: 'object', required: ['chat', 'text'], properties: { chat, text: { type: 'string' },
      warten: { type: 'boolean', description: 'auf die Antwort warten (Standard: ja)' } } },
    run: (a) => call('send', { chat: a.chat, text: a.text, wait: a.warten !== false }, 11 * 60 * 1000) },
  { name: 'chats_starten', readOnly: false,
    description: 'Startet einen neuen Chat in der Zentrale für eine eigenständige Nebenaufgabe (erscheint bei Eris rechts unter „Agenten“ und arbeitet im Hintergrund). Nur wenn Eris das will oder die Aufgabe wirklich für sich steht – nicht für Teile der aktuellen Aufgabe. Der Auftrag muss ohne diesen Verlauf verständlich sein.',
    inputSchema: { type: 'object', required: ['auftrag'], properties: {
      auftrag: { type: 'string', description: 'Vollständiger Auftrag für den neuen Chat' },
      titel: { type: 'string', description: 'Kurzer Name für die Liste' },
      ordner: { type: 'string', description: 'Arbeitsordner (absoluter Pfad); ohne Angabe derselbe wie dieser Chat' } } },
    run: (a) => call('start', { auftrag: a.auftrag, titel: a.titel, ordner: a.ordner }) },
  { name: 'aufgaben', readOnly: true,
    description: 'Zeigt Eris unter deiner Antwort die Aufgabenliste mit Häkchen – wie in der Claude-App. Bei jeder Aufgabe mit mehreren Schritten gleich zu Beginn die ganze Liste setzen (kurze Schritte, genau einer „läuft“), danach bei jedem Schritt die ganze Liste mit neuem Stand erneut schicken.',
    inputSchema: { type: 'object', required: ['schritte'], properties: { schritte: { type: 'array', maxItems: 12, items: { type: 'object', required: ['text', 'status'],
      properties: { text: { type: 'string', description: 'kurz, z. B. „Rechnung prüfen“' }, status: { type: 'string', enum: ['offen', 'läuft', 'erledigt'] } } } } } },
    run: (a) => call('plan', { schritte: a.schritte }) },
  { name: 'abschluss', readOnly: true,
    description: 'Am Ende jeder Aufgabe mit mehreren Schritten: zeigt Eris die Box „Nächster Schritt“ – 2–3 Sätze, was jetzt fertig ist und was noch offen ist. Muss Eris etwas entscheiden oder freigeben, dazu genau eine kurze Frage und 1–2 Knöpfe (Text 1–3 Wörter; nachricht = was der Klick dir schickt). Danach trotzdem deine normale Antwort schreiben.',
    inputSchema: { type: 'object', required: ['zusammenfassung'], properties: {
      zusammenfassung: { type: 'string' }, frage: { type: 'string' },
      knoepfe: { type: 'array', maxItems: 3, items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, nachricht: { type: 'string' } } } } } },
    run: (a) => call('abschluss', { zusammenfassung: a.zusammenfassung, frage: a.frage, knoepfe: a.knoepfe }) },
];

if (require.main === module) serve(TOOLS, 'zentrale-chats');

module.exports = { TOOLS, CHATS_TOOLS: TOOLS.map((t) => t.name) };
