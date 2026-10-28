// MCP-Server "kommentare": Claude liest und füllt die Kommentar-Liste der Zentrale („Wer will den Code?“).
// Alles bleibt in einer lokalen Datei – deshalb gehen diese Werkzeuge ohne Rückfrage.
// Nachrichten verschickt Claude hier nie: das läuft über die Web-Tabs, und auf „Senden“ drückt der Nutzer.
const { serve } = require('./core');
const k = require('../kommentare');

const FILE = process.env.ZENTRALE_KOMMENTARE_FILE;

const TOOLS = [
  { name: 'kommentare_liste', readOnly: true,
    description: 'Zeigt die Kommentar-Liste: Stichwort, eigenes Konto, Nachrichten-Vorlage, wie viele Nachrichten diese Stunde noch gehen, und alle Einträge (id, plattform, name, kommentar, video, status).',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const d = k.load(FILE);
      return { ok: true, data: { stichwort: d.stichwort, konto: d.konto, vorlage: d.vorlage, nochFreiDieseStunde: k.nochFrei(d.eintraege), eintraege: d.eintraege } };
    } },
  { name: 'kommentare_eintragen', readOnly: false,
    description: 'Trägt gefundene Kommentare ein. Nur Kommentare, die das Stichwort enthalten – alles andere wird abgelehnt. Doppelte (gleiche Person, gleiche Plattform) werden zusammengeführt.',
    inputSchema: { type: 'object', required: ['kommentare'], properties: { kommentare: { type: 'array', items: { type: 'object', required: ['plattform', 'name', 'kommentar'], properties: {
      plattform: { type: 'string', enum: k.PLATTFORMEN }, name: { type: 'string', description: 'Profilname mit @' },
      kommentar: { type: 'string', description: 'Kommentartext wörtlich' }, video: { type: 'string', description: 'Adresse des Posts' },
      profil: { type: 'string', description: 'Adresse des Profils' }, datum: { type: 'string' } } } } } },
    run: (a) => k.eintragen(FILE, a.kommentare) },
  { name: 'kommentare_status', readOnly: false,
    description: 'Setzt den Status eines Eintrags: offen, vorbereitet (Nachricht steht im Chatfeld, noch nicht gesendet), gesendet, ignoriert. „gesendet“ nur, wenn der Nutzer selbst auf Senden gedrückt hat.',
    inputSchema: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: k.STATUS } } },
    run: (a) => k.status(FILE, a.id, a.status) },
];

// Lokale Liste, nichts geht nach draußen: alle drei ohne Rückfrage.
const ALLOWED_TOOLS = TOOLS.map((t) => t.name);

if (require.main === module) serve(TOOLS, 'zentrale-kommentare');

module.exports = { TOOLS, ALLOWED_TOOLS };
