// Data Layer: alle Abfragen der Zentrale laufen hier durch. Er
//  1. misst jede Abfrage (Dauer, Fehler, Häufigkeit) – so findet die Seite „Kontrollraum“ langsame und kaputte Stellen,
//  2. hält häufig gebrauchte Daten kurz im Zwischenspeicher und fasst gleichzeitige Anfragen zusammen,
//  3. merkt sich, welche Seiten du benutzt – so fallen ungenutzte oder vergessene Bereiche auf.
// Alles bleibt auf diesem Mac. Gespeichert werden nur Namen, Zeiten und Fehlercodes – nie Inhalte.
// Für private Kanäle (Finanzen) zählt er nur Dauer und Anzahl, ohne Fehlertext.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SLOW_MS = 800;
const MAX_ERRORS = 50;
const SAVE_MS = 60000;
const DAY = 24 * 3600 * 1000;

const round = (n) => Math.round(n);

class DataLayer extends EventEmitter {
  constructor({ file = null, privateChannel = /^fin-/, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.privateChannel = privateChannel;
    this.now = now;
    this.sources = new Map();
    const saved = this.read();
    this.stats = saved.stats || {};   // Name → { count, totalMs, maxMs, errors, slow, lastAt, lastError }
    this.views = saved.views || {};   // Seite → { visits, lastAt }
    this.errors = saved.errors || []; // letzte Fehler { at, where, code }
    this.since = saved.since || this.now();
    this.dirty = false;
    this.timer = file ? setInterval(() => this.save(), SAVE_MS) : null;
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  read() {
    if (!this.file) return {};
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { return {}; }
  }

  save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ since: this.since, stats: this.stats, views: this.views, errors: this.errors }));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }

  // Eine Messung eintragen. code: kurzer Fehlercode (nie Inhalte).
  measure(name, ms, ok = true, code = null) {
    const s = this.stats[name] || (this.stats[name] = { count: 0, totalMs: 0, maxMs: 0, errors: 0, slow: 0, lastAt: 0, lastError: null });
    s.count += 1;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.lastAt = this.now();
    if (ms > SLOW_MS) s.slow += 1;
    if (!ok) {
      s.errors += 1;
      const priv = this.privateChannel.test(name.replace(/^(ipc|daten|ansicht):/, '')); // z. B. ipc:fin-save
      s.lastError = priv ? 'Fehler' : String(code || 'Fehler').slice(0, 120);
      this.errors = [{ at: this.now(), where: name, code: s.lastError }, ...this.errors].slice(0, MAX_ERRORS);
      this.emit('error-recorded', name);
    }
    this.dirty = true;
  }

  // Fehlercode aus einem Ergebnis {ok:false,error} oder einer Ausnahme – kurz und ohne Daten.
  static codeOf(x) {
    if (!x) return null;
    if (x instanceof Error) return x.code || x.name || 'Ausnahme';
    if (typeof x === 'object' && x.ok === false && !x.cancelled && !x.locked) return String(x.error || 'Fehler').split(/[:\n]/)[0].slice(0, 80);
    return null;
  }

  // Alle IPC-Kanäle messen, ohne jeden einzelnen anzufassen.
  wrapIpc(ipcMain) {
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
      const t = process.hrtime.bigint();
      try {
        const res = await fn(...args);
        const code = DataLayer.codeOf(res);
        this.measure(`ipc:${channel}`, Number(process.hrtime.bigint() - t) / 1e6, !code, code);
        return res;
      } catch (e) {
        this.measure(`ipc:${channel}`, Number(process.hrtime.bigint() - t) / 1e6, false, DataLayer.codeOf(e));
        throw e;
      }
    });
  }

  // Zwischengespeicherte Quelle: gleichzeitige Anfragen teilen sich einen Lauf, Ergebnisse halten ttl ms.
  source(name, load, { ttl = 0 } = {}) {
    const entry = { value: undefined, at: 0, running: null, gen: 0 };
    this.sources.set(name, entry);
    const get = async (force = false) => {
      if (!force && entry.at && this.now() - entry.at < ttl) return entry.value;
      if (entry.running) return entry.running;
      const gen = entry.gen;
      const t = process.hrtime.bigint();
      entry.running = Promise.resolve().then(load).then((v) => {
        this.measure(`daten:${name}`, Number(process.hrtime.bigint() - t) / 1e6, true);
        if (gen === entry.gen) { entry.value = v; entry.at = this.now(); }
        return v;
      }, (e) => {
        this.measure(`daten:${name}`, Number(process.hrtime.bigint() - t) / 1e6, false, DataLayer.codeOf(e));
        throw e;
      }).finally(() => { entry.running = null; });
      return entry.running;
    };
    get.invalidate = () => { entry.at = 0; entry.gen += 1; };
    return get;
  }

  trackView(name) {
    if (typeof name !== 'string' || !/^[a-z-]{2,30}$/.test(name)) return;
    const v = this.views[name] || (this.views[name] = { visits: 0, lastAt: 0 });
    v.visits += 1;
    v.lastAt = this.now();
    this.dirty = true;
  }

  trackRendererError(where, code) {
    this.measure(`ansicht:${String(where || 'unbekannt').slice(0, 40)}`, 0, false, String(code || 'Fehler').slice(0, 120));
  }

  // Übersicht für den Kontrollraum.
  report() {
    const now = this.now();
    const rows = Object.entries(this.stats).map(([name, s]) => ({ name, count: s.count, avgMs: round(s.totalMs / Math.max(1, s.count)),
      maxMs: round(s.maxMs), errors: s.errors, slow: s.slow, lastAt: s.lastAt, lastError: s.lastError }));
    return {
      since: this.since,
      slowest: rows.filter((r) => r.count).sort((a, b) => b.avgMs - a.avgMs).slice(0, 12),
      failing: rows.filter((r) => r.errors).sort((a, b) => b.lastAt - a.lastAt).slice(0, 12),
      busiest: rows.sort((a, b) => b.count - a.count).slice(0, 8),
      errors: this.errors.filter((e) => now - e.at < 7 * DAY).slice(0, 20),
      views: { ...this.views },
      total: rows.reduce((n, r) => n + r.count, 0),
    };
  }

  reset() {
    this.stats = {}; this.views = {}; this.errors = []; this.since = this.now(); this.dirty = true; this.save();
  }

  stop() { clearInterval(this.timer); this.dirty = true; this.save(); }
}

module.exports = { DataLayer, SLOW_MS };
