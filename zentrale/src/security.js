// Sicherheits-Check: prüft am echten Mac, ob die Zentrale dicht ist – offene Netzwerk-Zugänge,
// Rechte der Datenordner, Verschlüsselung, Sperre, Härtung der App. Nur lesen, nichts ändern.
const { execFile } = require('child_process');
const fs = require('fs');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout))));
}

const mode = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };

// facts: { pids, userData, sockets[], packaged, appLock, touchId, safeStorage, nodeForTools, fuses, backup: { dir, lastAt } }
async function check(facts) {
  const out = [];
  const add = (ok, title, detail, level = 'gelb') => out.push({ ok, title, detail, level: ok ? 'ok' : level });

  // 1. Niemand im Netz kann die Zentrale erreichen: kein offener Port.
  const pids = (facts.pids || []).filter((p) => Number.isInteger(p)).join(',');
  const listen = pids ? await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pids, '-iTCP', '-sTCP:LISTEN']) : '';
  const ports = listen.split('\n').slice(1).filter(Boolean);
  add(ports.length === 0, 'Kein offener Netzwerk-Zugang', ports.length ? `Die Zentrale lauscht auf ${ports.length} Port(s) – das sollte nicht sein.` : 'Die Zentrale nimmt aus dem Netz keine Verbindung an – auch nicht im selben WLAN.', 'rot');

  // 2. Datenordner und Vermittlungs-Sockets nur für dich.
  const ud = mode(facts.userData);
  add(ud !== null && (ud & 0o077) === 0, 'Datenordner nur für dich', ud === null ? 'Nicht prüfbar.' : `Rechte ${ud.toString(8)} – andere Benutzer dieses Macs kommen nicht hinein.`, 'rot');
  const badSock = (facts.sockets || []).filter((s) => fs.existsSync(s) && (mode(s) & 0o077) !== 0);
  add(badSock.length === 0, 'Werkzeug-Vermittlung nur für dich', badSock.length ? `${badSock.length} Socket(s) sind für andere lesbar.` : 'Die Verbindungen zwischen Claude-Werkzeugen und Zentrale sind nur für deinen Benutzer.', 'rot');

  // 3. Verschlüsselung.
  const fv = await run('/usr/bin/fdesetup', ['status']);
  add(/FileVault is On/.test(fv), 'Festplatte verschlüsselt (FileVault)', /On/.test(fv) ? 'Wird der Mac gestohlen, sind die Daten ohne dein Passwort nicht lesbar.' : 'FileVault ist aus – bei Diebstahl wäre alles lesbar. Einschalten: Systemeinstellungen → Datenschutz & Sicherheit → FileVault.', 'rot');
  add(!!facts.safeStorage, 'Schlüsselbund für Geheimnisse', facts.safeStorage ? 'n8n-Schlüssel, Finanzen und Web-Anmeldungen liegen verschlüsselt im macOS-Schlüsselbund.' : 'Der Schlüsselbund ist nicht verfügbar – dann speichert die Zentrale keine Geheimnisse.', 'rot');

  // 4. Sperre.
  add(!!(facts.appLock && facts.appLock.enabled), 'App-Sperre an', facts.appLock && facts.appLock.enabled ? `Sperrt beim Start, nach ${facts.appLock.minutes} Min ohne Nutzung, beim Ruhezustand und wenn der Mac gesperrt wird.` : 'Ohne Sperre sieht jeder, der an deinen Mac kommt, alles in der Zentrale.');
  add(!!facts.touchId, 'Touch ID verfügbar', facts.touchId ? 'Entsperren per Fingerabdruck.' : 'Gerade kein Touch ID (z. B. zugeklappt) – entsperren geht dann mit dem Mac-Passwort.', 'info');

  // 5. Härtung der App selbst.
  add(!!facts.nodeForTools, 'Claude-Werkzeuge laufen getrennt', facts.nodeForTools ? 'Die Werkzeuge laufen mit Node, nicht mit der Identität der Zentrale.' : 'Node wurde nicht gefunden – die Werkzeuge laufen noch über die Zentrale selbst.');
  if (facts.packaged) {
    const f = facts.fuses || {};
    add(f.runAsNode === false && f.enableNodeOptionsEnvironmentVariable === false && f.enableNodeCliInspectArguments === false,
      'Kein fremder Code als Zentrale', 'Kein Programm kann die Zentrale als Werkzeug missbrauchen, um an ihren Schlüsselbund zu kommen.', 'rot');
    add(f.enableEmbeddedAsarIntegrityValidation === true && f.onlyLoadAppFromAsar === true, 'App-Dateien gegen Veränderung geschützt', 'Wird der Programmcode verändert, startet die Zentrale nicht.', 'rot');
    add(f.enableCookieEncryption === true, 'Web-Anmeldungen verschlüsselt', 'Die Cookies deiner Web-Tabs liegen verschlüsselt auf der Platte.');
    add(true, 'Entwicklerwerkzeuge gesperrt', 'In der installierten App lassen sich die Entwicklerwerkzeuge nicht öffnen.');
  } else {
    add(true, 'Entwicklungs-Version', 'Härtung (Fuses, Entwicklerwerkzeuge aus) gilt in der installierten App.', 'info');
  }

  // 6. Backup: sonst ist bei einem Defekt alles weg (auch Projekte und Finanzen).
  const tm = await run('/usr/bin/tmutil', ['destinationinfo']);
  add(/Name\s*:/.test(tm), 'Backup (Time Machine)', /Name\s*:/.test(tm) ? 'Time Machine sichert den Mac – inklusive der Daten der Zentrale.' : 'Kein Backup eingerichtet. Geht der Mac kaputt oder verloren, sind alle lokalen Daten weg. Einrichten: unten unter „Backup“ → „Time Machine einrichten“ (externe Platte).', 'rot');
  const b = facts.backup || {};
  const fresh = b.lastAt && Date.now() - b.lastAt < 3 * 24 * 3600 * 1000;
  add(!!fresh, 'Sicherung der Zentrale', fresh ? `Zuletzt gesichert am ${new Date(b.lastAt).toLocaleDateString('de-DE')}.` : b.dir ? 'Seit über 3 Tagen keine Sicherung – ist die Platte angesteckt?' : 'Noch kein Ordner für die eigene Sicherung gewählt (unten unter „Backup“).', b.dir ? 'gelb' : 'info');

  // 7. Mac-Firewall (Systemeinstellung – ändert nur Eris).
  const fw = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
  add(/enabled|State = [12]/.test(fw), 'Mac-Firewall', /enabled|State = [12]/.test(fw) ? 'Eingehende Verbindungen werden gefiltert.' : 'Aus. Die Zentrale selbst lauscht nicht, andere Programme vielleicht schon. Einschalten: unten unter „Firewall“.', 'info');

  return out;
}

module.exports = { check };
