// Backup & Firewall: Time Machine und Mac-Firewall anzeigen und mit einem Klick (und deinem Mac-Passwort) einschalten,
// dazu eine eigene Sicherung der Zentrale-Daten auf eine Platte deiner Wahl. Nie in die Cloud: iCloud-, Dropbox-,
// Google-Drive- und OneDrive-Ordner werden abgelehnt, damit keine Daten der Zentrale auf einem fremden Server landen.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
const KEEP = 7; // so viele Sicherungen bleiben liegen, ältere wandern in den Papierkorb
const FOLDER = 'Zentrale-Backup';
const DIRS = ['privat', 'lernen-protokolle']; // Unterordner mit eigenen Daten (keine Caches, keine Anmeldungen)
const SKIP_FILE = /^mcp-.*\.json$|\.tmp$/; // mcp-*.json schreibt die Zentrale bei jedem Start neu
const TM_SETTINGS = 'x-apple.systempreferences:com.apple.Time-Machine-Settings.extension';
const FW_SETTINGS = 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall';

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inside = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);

// Ordner, die macOS oder ein Programm in die Cloud spiegelt.
function cloudRoots(home = os.homedir()) {
  try { home = fs.realpathSync(home); } catch {} // verlinkte Pfade (z. B. /var → /private/var) gleich vergleichen
  const roots = ['Library/Mobile Documents', 'Library/CloudStorage', 'Dropbox', 'Google Drive', 'OneDrive', 'iCloud Drive']
    .map((r) => path.join(home, r));
  // „Schreibtisch & Dokumente in iCloud“: dann liegen ~/Desktop und ~/Documents ebenfalls in der Cloud.
  for (const d of ['Desktop', 'Documents']) {
    if (fs.existsSync(path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs', d))) roots.push(path.join(home, d));
  }
  return roots;
}

// Ziel prüfen. sameDisk = liegt auf der Mac-Platte (schützt vor Fehlbedienung, nicht vor einem Defekt).
function checkTarget(dir, { userData, home = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'Bitte einen Ordner wählen.' };
  let real;
  try { real = fs.realpathSync(dir); } catch { return { ok: false, error: 'Den Ordner gibt es gerade nicht – ist die Platte angeschlossen?', missing: true }; }
  if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'Das ist kein Ordner.' };
  if (cloudRoots(home).some((r) => inside(real, r))) return { ok: false, error: 'Dieser Ordner wird in die Cloud hochgeladen. Die Zentrale sichert nur auf Platten bei dir – bitte eine externe Platte oder einen Ordner außerhalb von iCloud, Dropbox & Co. wählen.' };
  if (userData && inside(real, fs.realpathSync(userData))) return { ok: false, error: 'Eine Sicherung im Datenordner selbst hilft nicht.' };
  try { fs.accessSync(real, fs.constants.W_OK); } catch { return { ok: false, error: 'In diesen Ordner darf die Zentrale nicht schreiben.' }; }
  let sameDisk = false;
  try { sameDisk = fs.statSync(real).dev === fs.statSync(home).dev; } catch {}
  return { ok: true, dir: real, sameDisk };
}

// Was gesichert wird: eigene Dateien der Zentrale (Einstellungen, Planer, Lernen, Training, Privat – verschlüsselt).
function backupItems(userData) {
  let names = [];
  try { names = fs.readdirSync(userData); } catch { return []; }
  return names.filter((n) => {
    const p = path.join(userData, n);
    let st;
    try { st = fs.lstatSync(p); } catch { return false; }
    if (st.isFile()) return /\.json$/.test(n) && !SKIP_FILE.test(n);
    return st.isDirectory() && DIRS.includes(n);
  });
}

function listBackups(dir) {
  const root = path.join(dir, FOLDER);
  try {
    return fs.readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(n)).sort().reverse()
      .map((n) => ({ name: n, path: path.join(root, n) }));
  } catch { return []; }
}

const README = [
  'Sicherung der Zentrale',
  '',
  'Was drin ist: Einstellungen, Planer, Web-Tabs (ohne Anmeldungen), Lernen, Training, Kommentare und der private Finanzbereich.',
  'Der Finanzbereich und der n8n-Schlüssel bleiben verschlüsselt – lesbar nur mit dem Schlüsselbund dieses Macs.',
  '',
  'Zurückholen: Zentrale beenden, die Dateien aus diesem Ordner nach',
  '~/Library/Application Support/Zentrale kopieren, Zentrale starten.',
  '',
].join('\n');

// Eine Sicherung anlegen. trash(p) wirft alte Sicherungen in den Papierkorb (nie endgültig löschen).
async function runBackup({ userData, target, now = new Date(), trash, home }) {
  const t = checkTarget(target, { userData, home });
  if (!t.ok) return t;
  const dest = path.join(t.dir, FOLDER, stamp(now));
  const items = backupItems(userData);
  if (!items.length) return { ok: false, error: 'Es gibt noch nichts zu sichern.' };
  try {
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const n of items) fs.cpSync(path.join(userData, n), path.join(dest, n), { recursive: true, preserveTimestamps: true });
    fs.writeFileSync(path.join(dest, 'LIESMICH.txt'), README);
  } catch (err) {
    // Halbe Sicherung weg (Papierkorb), sonst zählte sie zu den 7 und schöbe eine vollständige hinaus.
    try { await trash(dest); } catch {}
    return { ok: false, error: `Sicherung ging nicht: ${err.code === 'ENOSPC' ? 'Platte voll.' : err.message}` };
  }
  const old = listBackups(t.dir).slice(KEEP);
  for (const b of old) { try { await trash(b.path); } catch {} }
  return { ok: true, dir: dest, items: items.length, sameDisk: t.sameDisk, removed: old.length };
}

// Einmal am Tag automatisch – nur wenn ein Ziel gewählt und erreichbar ist (externe Platte angesteckt).
// failDay: Tag des letzten echten Fehlers (nicht „Platte fehlt“) – dann erst morgen wieder, „Jetzt sichern“ geht immer.
function isDue(cfg, lastDay, now = new Date(), failDay = null) {
  const today = localDay(now);
  return !!(cfg && cfg.auto && cfg.dir) && lastDay !== today && failDay !== today;
}

// ---------- Time Machine ----------
async function timeMachine() {
  const dest = await run('/usr/bin/tmutil', ['destinationinfo']);
  const names = [...dest.out.matchAll(/^Name\s*:\s*(.+)$/gm)].map((m) => m[1].trim());
  const status = await run('/usr/bin/tmutil', ['status']);
  const running = /Running\s*=\s*1/.test(status.out);
  const latest = names.length ? await run('/usr/bin/tmutil', ['latestbackup']) : { ok: false, out: '' };
  const m = /(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/.exec(latest.out);
  return { configured: names.length > 0, disks: names, running, latest: m ? `${m[1]} ${m[2]}:${m[3]}` : null };
}

async function startTimeMachine() {
  const r = await run('/usr/bin/tmutil', ['startbackup', '--auto']);
  return r.ok ? { ok: true } : { ok: false, error: /No destinations/i.test(r.err) ? 'Time Machine hat noch keine Platte.' : `Time Machine startete nicht: ${r.err.split('\n')[0]}` };
}

// ---------- Firewall ----------
async function firewall() {
  const g = await run(FW, ['--getglobalstate']);
  const s = await run(FW, ['--getstealthmode']);
  return { on: /enabled|State = [12]/.test(g.out), stealth: /stealth mode is on|enabled/i.test(s.out) && !/off|disabled/i.test(s.out) };
}

// Programme, die gerade aus dem Netz erreichbar sind (nicht nur vom Mac selbst) – die fragt macOS nach dem Einschalten ggf. einmal.
async function exposedApps() {
  const r = await run('/usr/sbin/lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN']);
  const seen = new Map();
  for (const line of r.out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    const addr = cols[cols.length - 2] || '';
    if (!addr || /^(127\.|\[::1\]|localhost)/.test(addr)) continue;
    const port = (/:(\d+)$/.exec(addr) || [])[1];
    const name = cols[0].replace(/\\x20/g, ' ');
    if (port) seen.set(name, [...new Set([...(seen.get(name) || []), port])]);
  }
  return [...seen].map(([name, ports]) => ({ name, ports })).sort((a, b) => a.name.localeCompare(b.name));
}

// Einschalten braucht Admin-Rechte: macOS fragt selbst nach deinem Passwort (die Zentrale sieht es nie).
function firewallScript(stealth) {
  const cmds = [`${FW} --setglobalstate on`];
  if (stealth) cmds.push(`${FW} --setstealthmode on`);
  return `do shell script "${cmds.join(' && ')}" with prompt "Die Zentrale möchte die Mac-Firewall einschalten." with administrator privileges`;
}

async function enableFirewall({ stealth = false } = {}) {
  const r = await run('/usr/bin/osascript', ['-e', firewallScript(stealth)], 120000);
  if (!r.ok) return { ok: false, cancelled: /-128|abgebrochen|canceled/i.test(r.err), error: /-128|abgebrochen|canceled/i.test(r.err) ? 'Abgebrochen – nichts geändert.' : `Ging nicht: ${r.err.split('\n')[0]}` };
  return { ok: true, ...(await firewall()) };
}

module.exports = { checkTarget, backupItems, listBackups, runBackup, isDue, localDay, cloudRoots, timeMachine, startTimeMachine,
  firewall, exposedApps, enableFirewall, firewallScript, TM_SETTINGS, FW_SETTINGS, FOLDER, KEEP };
