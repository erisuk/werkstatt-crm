// Welche Gespräche gerade in der Claude-App (Desktop) laufen – erkennbar an deren Claude-Prozessen
// (Programm unter …/Application Support/Claude/claude-code/…, mit --resume=<ID> oder --session-id <ID>).
// Wichtig, damit nie zwei Claude-Prozesse gleichzeitig in denselben Verlauf schreiben (der würde sich aufspalten).
const { execFile } = require('child_process');

const DESKTOP_BIN = /\/Application Support\/Claude\/claude-code\//;
const SESSION_ARG = /--(?:resume|session-id)[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const TTL_MS = 4000;

// ps-Ausgabe (eine Befehlszeile pro Prozess) → Gesprächs-IDs, die die Claude-App gerade offen hat.
function parsePs(text) {
  const ids = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!DESKTOP_BIN.test(line)) continue;
    const m = SESSION_ARG.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function psText() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'command'], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// Liefert eine Funktion: await desktopOpen() → Set der IDs (kurz zwischengespeichert; force = frisch nachsehen).
function createDesktopLive({ read = psText, now = Date.now, ttl = TTL_MS } = {}) {
  let cache = { at: -Infinity, ids: new Set() };
  return async function desktopOpen({ force = false } = {}) {
    if (!force && now() - cache.at < ttl) return cache.ids;
    cache = { at: now(), ids: parsePs(await read()) };
    return cache.ids;
  };
}

module.exports = { parsePs, createDesktopLive };
