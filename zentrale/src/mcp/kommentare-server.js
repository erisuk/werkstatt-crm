// MCP-Server "kommentare": Claude liest und füllt die Kommentar-Liste von Bits Videos.
// Jedes Video hat sein eigenes Stichwort und seine Antwort (bitvideos.js → aktionen).
// Alles bleibt in lokalen Dateien – deshalb gehen diese Werkzeuge ohne Rückfrage.
// Nachrichten verschickt Claude hier nie: das läuft über die Web-Tabs, und auf „Senden“ drückt der Nutzer.
const { serve } = require('./core');
const k = require('../kommentare');
const bitvideos = require('../bitvideos');

const FILE = process.env.ZENTRALE_KOMMENTARE_FILE;

const TOOLS = [
  { name: 'kommentare_auftrag', readOnly: true,
    description: 'Gibt den aktuellen Auftrag zum Einsammeln der Kommentare zurück: welche Stichwörter zu welchem Video gehören und wie vorzugehen ist. Für die tägliche Aufgabe „Bit: Kommentare einsammeln“ zuerst aufrufen und dann genau so vorgehen.',
    inputSchema: { type: 'object', properties: {} },
    run: () => k.auftragEinsammeln(k.load(FILE), bitvideos.aktionen()) },
  { name: 'kommentare_liste', readOnly: true,
    description: 'Zeigt die Kommentar-Liste: eigenes Konto, die Kommentar-Aktionen der Videos (video, stichwort, antwort, aktiv), wie viele Nachrichten diese Stunde noch gehen, und alle Einträge (id, plattform, name, kommentar, video, status).',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const d = k.load(FILE);
      return { ok: true, data: { konto: d.konto, aktionen: bitvideos.aktionen(), nochFreiDieseStunde: k.nochFrei(d.eintraege), eintraege: d.eintraege } };
    } },
  { name: 'kommentare_eintragen', readOnly: false,
    description: 'Trägt gefundene Kommentare ein. Nur Kommentare, die das Stichwort eines aktiven Videos enthalten – alles andere wird abgelehnt. Doppelte (gleiche Person, gleiches Video) werden zusammengeführt.',
    inputSchema: { type: 'object', required: ['kommentare'], properties: { kommentare: { type: 'array', items: { type: 'object', required: ['plattform', 'name', 'kommentar'], properties: {
      plattform: { type: 'string', enum: k.PLATTFORMEN }, name: { type: 'string', description: 'Profilname mit @' },
      kommentar: { type: 'string', description: 'Kommentartext wörtlich' }, video_id: { type: 'string', description: 'Video zum Stichwort, z. B. v016' },
      post: { type: 'string', description: 'Adresse des Beitrags' }, profil: { type: 'string', description: 'Adresse des Profils' },
      datum: { type: 'string' } } } } } },
    run: (a) => k.eintragen(FILE, a.kommentare, bitvideos.aktionen()) },
  { name: 'kommentare_status', readOnly: false,
    description: 'Setzt den Status eines Eintrags: offen, vorbereitet (Nachricht steht im Chatfeld, noch nicht gesendet), gesendet, ignoriert. „gesendet“ nur, wenn der Nutzer selbst auf Senden gedrückt hat.',
    inputSchema: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: k.STATUS } } },
    run: (a) => k.status(FILE, a.id, a.status) },
];

// Lokale Listen, nichts geht nach draußen: alle ohne Rückfrage.
const ALLOWED_TOOLS = TOOLS.map((t) => t.name);

if (require.main === module) serve(TOOLS, 'zentrale-kommentare');

module.exports = { TOOLS, ALLOWED_TOOLS };
