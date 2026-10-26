// Tägliche Aufgaben: werden in einer JSON-Datei gespeichert und zur eingestellten Uhrzeit ausgeführt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fällig, wenn eingeschaltet, die Uhrzeit heute erreicht ist und sie heute noch nicht lief.
function isDue(task, now = new Date()) {
  if (!task.enabled) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(task.time || '');
  if (!m) return false;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (now < at) return false;
  return task.lastRunDay !== dayKey(now);
}

// Neue, umgestellte oder wieder eingeschaltete Aufgaben, deren Uhrzeit heute schon vorbei ist,
// sollen nicht sofort loslaufen, sondern erst morgen.
function skipToday(task, now) {
  if (isDue({ ...task, enabled: true }, now)) task.lastRunDay = dayKey(now);
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
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.tasks, null, 2));
    this.emit('change');
  }

  list() {
    return this.tasks.map((t) => ({ ...t, running: this.running.has(t.id) }));
  }

  upsert(input, now = new Date()) {
    const clean = {
      name: String(input.name || '').trim() || 'Neue Aufgabe',
      time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time : '08:00',
      prompt: String(input.prompt || ''),
      cwd: input.cwd || null,
    };
    let task = input.id && this.tasks.find((t) => t.id === input.id);
    const timeChanged = !task || task.time !== clean.time;
    if (task) Object.assign(task, clean);
    else {
      task = { id: crypto.randomUUID(), enabled: true, lastRunDay: null, lastStatus: null, lastText: null, ...clean };
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

  async run(id, now = new Date()) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || this.running.has(id)) return;
    this.running.add(id);
    t.lastRunDay = dayKey(now);
    this.save();
    const res = await this.runner(t);
    this.running.delete(id);
    t.lastStatus = res.ok ? 'ok' : 'error';
    t.lastText = (res.text || '').slice(0, 2000);
    t.lastRunAt = Date.now();
    this.save();
  }

  tick(now = new Date()) {
    for (const t of this.tasks) if (isDue(t, now)) this.run(t.id, now);
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
