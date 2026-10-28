// Tägliche Aufgaben: werden in einer JSON-Datei gespeichert und zur eingestellten Uhrzeit ausgeführt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fällig, wenn eingeschaltet, die Uhrzeit heute erreicht ist und sie heute weder lief
// noch bewusst übersprungen wurde.
function isDue(task, now = new Date()) {
  if (!task.enabled) return false;
  const m = TIME_RE.exec(task.time || '');
  if (!m) return false;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (now < at) return false;
  const today = dayKey(now);
  return task.lastRunDay !== today && task.skipDay !== today;
}

// Neue, umgestellte oder wieder eingeschaltete Aufgaben, deren Uhrzeit heute schon vorbei ist,
// sollen nicht sofort loslaufen, sondern erst morgen.
function skipToday(task, now) {
  task.skipDay = null;
  if (isDue({ ...task, enabled: true }, now)) task.skipDay = dayKey(now);
}

class TaskScheduler extends EventEmitter {
  constructor(file, runner) {
    super();
    this.file = file;
    this.runner = runner;
    this.running = new Set();
    this.tasks = this.load();
    this.timer = null;
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    let tasks;
    try { tasks = JSON.parse(raw); } catch { tasks = null; }
    if (!Array.isArray(tasks)) {
      // Kaputte Datei nicht überschreiben, sondern zur Sicherheit aufheben.
      try { fs.copyFileSync(this.file, `${this.file}.kaputt-${Date.now()}`); } catch {}
      return [];
    }
    tasks = tasks.filter((t) => t && typeof t === 'object' && t.id);
    // Lief beim letzten Beenden noch eine Aufgabe, war sie unterbrochen.
    for (const t of tasks) {
      if (t.runningSince) {
        t.lastStatus = 'error';
        t.lastText = 'Unterbrochen: Die Zentrale wurde während der Aufgabe beendet.';
        t.lastRunAt = t.runningSince;
        delete t.runningSince;
      }
    }
    return tasks;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.emit('save-error', e);
    }
    this.emit('change');
  }

  list() {
    return this.tasks.map((t) => ({ ...t, running: this.running.has(t.id) }));
  }

  upsert(input, now = new Date()) {
    if (!input || typeof input !== 'object') return;
    const clean = {
      name: String(input.name || '').trim().slice(0, 120) || 'Neue Aufgabe',
      time: TIME_RE.test(input.time || '') ? input.time : '08:00',
      prompt: String(input.prompt || ''),
      cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : null,
    };
    let task = input.id && this.tasks.find((t) => t.id === input.id);
    const timeChanged = !task || task.time !== clean.time;
    if (task) Object.assign(task, clean);
    else {
      task = { id: crypto.randomUUID(), enabled: true, lastRunDay: null, skipDay: null, lastStatus: null, lastText: null, ...clean };
      this.tasks.push(task);
    }
    if (timeChanged) skipToday(task, now);
    this.save();
  }

  remove(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.save();
  }

  toggle(id, now = new Date()) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.enabled = !t.enabled;
    if (t.enabled) skipToday(t, now);
    this.save();
  }

  // scheduled: true nur für den Lauf zur Uhrzeit. "Jetzt ausführen" verbraucht den heutigen Lauf nicht.
  async run(id, { now = new Date(), scheduled = false } = {}) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || this.running.has(id)) return;
    this.running.add(id);
    if (scheduled) t.lastRunDay = dayKey(now);
    t.runningSince = Date.now();
    this.save();
    let res;
    try {
      res = await this.runner(t);
    } catch (e) {
      res = { ok: false, text: e && e.message ? e.message : String(e) };
    } finally {
      this.running.delete(id);
    }
    delete t.runningSince;
    t.lastStatus = res && res.ok ? 'ok' : 'error';
    t.lastText = String((res && res.text) || '').slice(0, 4000);
    t.lastRunAt = Date.now();
    this.save();
  }

  // Nach dem Aufwachen kurz warten, bis das Netz wieder da ist – sonst ist der heutige Lauf verbraucht.
  pause(ms) { this.pausedUntil = Date.now() + ms; }

  tick(now = new Date()) {
    if (this.pausedUntil && Date.now() < this.pausedUntil) return;
    for (const t of this.tasks) if (isDue(t, now)) this.run(t.id, { now, scheduled: true });
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 30 * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { TaskScheduler, isDue, dayKey };
