// Die MCP-Server laufen mit dem normalen Node außerhalb der App – sie sehen nur ausgepackte Dateien.
// Fehlt eine Datei in asarUnpack, startet der Server in der installierten App nicht (so geschehen mit bit-posten.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const unpack = require('../package.json').build.asarUnpack;
const unpacked = (rel) => unpack.some((p) => p === rel || (p.endsWith('/**') && rel.startsWith(p.slice(0, -2))));

test('Verpackung: alles, was die MCP-Server laden, ist ausgepackt', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    assert.ok(unpacked(rel), `${rel} fehlt in build.asarUnpack`);
    const src = fs.readFileSync(file, 'utf8');
    for (const [, dep] of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), dep));
      visit(target);
    }
  };
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'mcp'))) if (f.endsWith('.js')) visit(path.join(ROOT, 'src', 'mcp', f));
  assert.ok(seen.size > 6);
});
