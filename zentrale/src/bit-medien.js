// Eigenes Protokoll „bitvideo://“, damit die Bit-Videos-Seite fertige Videos abspielen und Titelbilder zeigen kann.
// Ausgeliefert wird nur aus studio/out, nur Dateien wie v018.mp4 oder v018_cover.png – nichts anderes auf dem Mac.
// Mit Bereichs-Anfragen (Range), damit man im Video springen kann.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const SCHEME = 'bitvideo';
const NAME = /^v\d{3}(\.mp4|_cover\.png)$/;
const TYPEN = { '.mp4': 'video/mp4', '.png': 'image/png' };

// bitvideo://out/v018.mp4 → absoluter Pfad oder null
function dateiAus(url, studio) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (u.host !== 'out' || !NAME.test(name)) return null;
  const voll = path.join(studio, 'out', name);
  try { return fs.statSync(voll).isFile() ? voll : null; } catch { return null; }
}

// „bytes=100-“ oder „bytes=100-200“ → { start, end } innerhalb der Datei, sonst null
function bereich(header, groesse) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, groesse - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : groesse - 1;
  end = Math.min(end, groesse - 1);
  if (start > end || start >= groesse) return null;
  return { start, end };
}

function antwort(request, studio) {
  const voll = dateiAus(request.url, studio);
  if (!voll) return new Response('Nicht gefunden', { status: 404 });
  const groesse = fs.statSync(voll).size;
  const typ = TYPEN[path.extname(voll)];
  const r = bereich(request.headers.get('range'), groesse);
  if (r) {
    return new Response(Readable.toWeb(fs.createReadStream(voll, r)), { status: 206, headers: {
      'Content-Type': typ, 'Content-Length': String(r.end - r.start + 1), 'Content-Range': `bytes ${r.start}-${r.end}/${groesse}`, 'Accept-Ranges': 'bytes' } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(voll)), { status: 200, headers: {
    'Content-Type': typ, 'Content-Length': String(groesse), 'Accept-Ranges': 'bytes' } });
}

module.exports = { SCHEME, dateiAus, bereich, antwort };
