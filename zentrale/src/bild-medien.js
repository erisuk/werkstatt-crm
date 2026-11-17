// Bilder im Chat: Claude schreibt ![Beschreibung](/pfad/bild.png) – die Zentrale zeigt das Bild direkt an.
// Lokale Bilder kommen über das eigene Protokoll zbild://datei?p=… – nur Bilddateien, nur aus dem Benutzerordner
// und den Arbeitsordnern für Zwischenstände (/tmp), höchstens 40 MB. Alles andere: 404.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const SCHEME = 'zbild';
const MAX_BYTES = 40 * 1024 * 1024;
const TYPEN = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff' };

function wurzeln(home) {
  const out = [];
  for (const p of [home, '/tmp', '/private/tmp', os.tmpdir()]) {
    try { out.push(fs.realpathSync.native(p)); } catch { /* fehlt */ }
  }
  return out;
}

// Adresse → erlaubter Dateipfad oder null.
function bildAus(url, home = os.homedir()) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || u.hostname !== 'datei') return null;
  let p = u.searchParams.get('p') || '';
  if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p) || p.includes('\0')) return null;
  if (!TYPEN[path.extname(p).toLowerCase()]) return null;
  let echt;
  try { echt = fs.realpathSync.native(p); } catch { return null; }
  // Auch das Ziel einer Verknüpfung muss ein Bild an einem erlaubten Ort sein.
  if (!TYPEN[path.extname(echt).toLowerCase()]) return null;
  if (!wurzeln(home).some((w) => echt === w || echt.startsWith(w + path.sep))) return null;
  let st;
  try { st = fs.statSync(echt); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  return echt;
}

function antwort(request, home = os.homedir()) {
  const datei = bildAus(request.url, home);
  if (!datei) return new Response('Nicht gefunden', { status: 404 });
  // SVG kann Skripte enthalten – nur als Bild (img) erlaubt, und hier zusätzlich ohne Skripte ausgeliefert.
  const headers = { 'Content-Type': TYPEN[path.extname(datei).toLowerCase()], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' };
  return new Response(Readable.toWeb(fs.createReadStream(datei)), { status: 200, headers });
}

module.exports = { SCHEME, bildAus, antwort, TYPEN };
