// Nach dem Bauen signieren. Nötig, weil das Setzen der Electron-Fuses das Programm verändert – mit kaputter
// Signatur beendet macOS die App sofort.
// Mit dem Zertifikat „Zentrale Signatur“ (build/zertifikat-anlegen.sh) erkennt macOS die App an diesem Zertifikat:
// Erlaubnisse für Kalender, Erinnerungen und Schlüsselbund bleiben auch nach einem Neubau. Ohne Zertifikat
// signieren wir „ad hoc“ – dann sieht macOS jeden Neubau als neues Programm und fragt erneut.
const { execFileSync } = require('child_process');
const path = require('path');

const CERT_NAME = 'Zentrale Signatur';

// Fingerabdruck des Zertifikats, auch wenn macOS ihm nicht „vertraut“ (selbst ausgestellt – fürs Signieren egal).
function signingIdentity() {
  try {
    const out = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes(`"${CERT_NAME}"`));
    const m = line && /\b([0-9A-F]{40})\b/.exec(line);
    return m ? m[1] : null;
  } catch { return null; }
}

exports.default = async function sign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = signingIdentity();
  if (!identity) {
    console.log(`  • Zertifikat „${CERT_NAME}“ fehlt – signiere ad hoc (macOS fragt nach jedem Neubau neu). Anlegen: build/zertifikat-anlegen.sh`);
    try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' }); return; } catch {}
  }
  const sign = (id) => execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', id, '--options', 'runtime',
    '--entitlements', path.join(__dirname, 'entitlements.mac.plist'), app], { stdio: 'inherit' });
  if (!identity) { sign('-'); return; }
  try { sign(identity); } catch (e) {
    // z. B. Schlüsselbund gesperrt: lieber ad hoc bauen als gar nicht (macOS fragt dann einmal neu nach Erlaubnissen).
    console.log(`  • Signieren mit „${CERT_NAME}“ ging nicht (${e.message.split('\n')[0]}) – signiere ad hoc.`);
    sign('-');
  }
};
