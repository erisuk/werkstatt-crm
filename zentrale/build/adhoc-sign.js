// Nach dem Bauen: ohne Entwickler-Zertifikat lokal („ad hoc“) signieren. Nötig, weil das Setzen der
// Electron-Fuses das Programm verändert – mit kaputter Signatur beendet macOS die App sofort.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' }); return; } catch {}
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime',
    '--entitlements', path.join(__dirname, 'entitlements.mac.plist'), app], { stdio: 'inherit' });
};
