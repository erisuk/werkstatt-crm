// Einstellungen der Zentrale (Design und Verbindungen), gespeichert als JSON.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'system', // 'system' | 'light' | 'dark'
  connections: { mac: false, chrome: false },
};

const THEMES = ['system', 'light', 'dark'];

function sanitize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const c = s.connections && typeof s.connections === 'object' ? s.connections : {};
  return {
    theme: THEMES.includes(s.theme) ? s.theme : DEFAULTS.theme,
    connections: { mac: c.mac === true, chrome: c.chrome === true },
  };
}

class Settings {
  constructor(file) {
    this.file = file;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.value = sanitize(raw);
  }

  get() {
    return JSON.parse(JSON.stringify(this.value));
  }

  // Übernimmt nur bekannte Felder mit gültigen Werten; ungültige lassen den alten Wert stehen.
  update(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const pc = p.connections && typeof p.connections === 'object' ? p.connections : {};
    const connections = { ...this.value.connections };
    for (const key of Object.keys(DEFAULTS.connections)) if (typeof pc[key] === 'boolean') connections[key] = pc[key];
    this.value = sanitize({ theme: THEMES.includes(p.theme) ? p.theme : this.value.theme, connections });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.value, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS, sanitize };
