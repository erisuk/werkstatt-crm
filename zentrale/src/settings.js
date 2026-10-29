// Einstellungen der Zentrale (Design und Verbindungen), gespeichert als JSON.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'system', // 'system' | 'light' | 'dark'
  connections: { mac: false, chrome: false, web: false },
  morning: { enabled: false, time: '08:00' }, // tägliche Morgen-Mitteilung
  appLock: { enabled: true, minutes: 15 }, // Sperre beim Start und nach Minuten ohne Nutzung
  backup: { dir: null, auto: false }, // eigene Sicherung der Zentrale-Daten (Ordner auf einer Platte, nie Cloud)
  askFirst: false, // false = Claude darf alles ohne Rückfrage (Eris' Wunsch), true = jede Aktion braucht eine Freigabe
};
const LOCK_MINUTES = [1, 5, 15, 30, 60];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const THEMES = ['system', 'light', 'dark'];
const absDir = (d) => (typeof d === 'string' && d.startsWith('/') && d.length < 1024 && !d.includes('\u0000') ? d : null);

function sanitize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const c = s.connections && typeof s.connections === 'object' ? s.connections : {};
  return {
    theme: THEMES.includes(s.theme) ? s.theme : DEFAULTS.theme,
    connections: { mac: c.mac === true, chrome: c.chrome === true, web: c.web === true },
    morning: { enabled: !!(s.morning && s.morning.enabled === true),
      time: s.morning && TIME.test(s.morning.time) ? s.morning.time : DEFAULTS.morning.time },
    appLock: { enabled: !(s.appLock && s.appLock.enabled === false),
      minutes: s.appLock && LOCK_MINUTES.includes(s.appLock.minutes) ? s.appLock.minutes : DEFAULTS.appLock.minutes },
    backup: { dir: absDir(s.backup && s.backup.dir), auto: !!(s.backup && s.backup.auto === true && absDir(s.backup.dir)) },
    askFirst: s.askFirst === true,
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
    const pm = p.morning && typeof p.morning === 'object' ? p.morning : {};
    const morning = { enabled: typeof pm.enabled === 'boolean' ? pm.enabled : this.value.morning.enabled,
      time: TIME.test(pm.time) ? pm.time : this.value.morning.time };
    const pl = p.appLock && typeof p.appLock === 'object' ? p.appLock : {};
    const appLock = { enabled: typeof pl.enabled === 'boolean' ? pl.enabled : this.value.appLock.enabled,
      minutes: LOCK_MINUTES.includes(pl.minutes) ? pl.minutes : this.value.appLock.minutes };
    const pb = p.backup && typeof p.backup === 'object' ? p.backup : {};
    const backup = { dir: 'dir' in pb ? absDir(pb.dir) : this.value.backup.dir, auto: typeof pb.auto === 'boolean' ? pb.auto : this.value.backup.auto };
    const askFirst = typeof p.askFirst === 'boolean' ? p.askFirst : this.value.askFirst;
    this.value = sanitize({ theme: THEMES.includes(p.theme) ? p.theme : this.value.theme, connections, morning, appLock, backup, askFirst });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.value, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS, sanitize };
