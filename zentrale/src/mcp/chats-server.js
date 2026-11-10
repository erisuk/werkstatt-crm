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
];

if (require.main === module) serve(TOOLS, 'zentrale-chats');

module.exports = { TOOLS, CHATS_TOOLS: TOOLS.map((t) => t.name) };
