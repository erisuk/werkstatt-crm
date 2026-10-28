// Fehler-Meldungen: prüft regelmäßig, ob wichtige lokale Server noch laufen und ob n8n-Workflows
// fehlgeschlagen sind, und meldet es als Mac-Mitteilung. Merkt sich die letzten Meldungen für „Heute“.
const MAX_RECENT = 30;
const ERROR_STATUS = new Set(['error', 'crashed', 'failed']);
const RUNNING_STATUS = new Set(['running', 'waiting', 'new', 'unknown']);

// Wichtig = von der Zentrale gestartet, startet automatisch (launchd) oder ein geschützter Dienst wie der Signal-Server.
function isWatched(s) {
  return !s.system && (s.startedByZentrale || s.launchd || /signalserver|8788/.test(String(s.protected || '')) || s.port === 8788);
}

class AlertWatch {
  constructor({ listServers, listExecutions, listWorkflows, notify, now = () => Date.now() }) {
    this.listServers = listServers;
    this.listExecutions = listExecutions;
    this.listWorkflows = listWorkflows;
    this.notify = notify;
    this.now = now;
    this.watched = new Map(); // port → { name, missing }
    this.expected = new Set(); // Ports, die gerade bewusst gestoppt wurden
    this.seenExecutions = null; // null = erster Durchlauf, nur merken
    this.recent = [];
    this.timer = null;
  }

  add(kind, title, body, view) {
    this.recent = [{ kind, title, body, view, at: this.now() }, ...this.recent].slice(0, MAX_RECENT);
    this.notify(title, body, view);
  }

  // Wurde in der Zentrale gestoppt → kein Alarm.
  expectStop(port) { this.expected.add(Number(port)); }

  async checkServers() {
    let list;
    try { list = await this.listServers(); } catch { return; }
    const ports = new Set(list.map((s) => s.port));
    for (const s of list.filter(isWatched)) this.watched.set(s.port, { name: s.title || s.project || s.proc, missing: 0 });
    for (const [port, w] of [...this.watched]) {
      if (ports.has(port)) { this.expected.delete(port); continue; }
      if (this.expected.has(port)) { this.watched.delete(port); this.expected.delete(port); continue; }
      // Erst beim zweiten Fehlen melden – ein kurzer Neustart ist kein Ausfall.
      const missing = w.missing + 1;
      if (missing < 2) { this.watched.set(port, { ...w, missing }); continue; }
      this.watched.delete(port);
      this.add('server', 'Server ausgefallen', `${w.name} auf Port ${port} läuft nicht mehr.`, 'projects');
    }
  }

  async checkN8n() {
    if (!this.listExecutions) return;
    let res;
    try { res = await this.listExecutions(); } catch { return; }
    if (!res || !res.ok) return;
    // Nur fertige Läufe merken – ein Lauf, der noch „running“ ist, kann später noch fehlschlagen.
    const finished = res.data.filter((e) => !RUNNING_STATUS.has(e.status));
    const ids = finished.map((e) => e.id);
    if (!this.seenExecutions) { this.seenExecutions = new Set(ids); return; }
    const fresh = finished.filter((e) => !this.seenExecutions.has(e.id) && ERROR_STATUS.has(e.status));
    for (const id of ids) this.seenExecutions.add(id);
    if (this.seenExecutions.size > 500) this.seenExecutions = new Set(ids);
    if (!fresh.length) return;
    let names = new Map();
    try {
      const wf = await this.listWorkflows();
      if (wf && wf.ok) names = new Map(wf.data.map((w) => [String(w.id), w.name]));
    } catch {}
    for (const e of fresh) {
      this.add('n8n', 'n8n-Workflow fehlgeschlagen', `„${names.get(e.workflowId) || `Workflow ${e.workflowId}`}“ ist mit einem Fehler abgebrochen.`, 'automations');
    }
  }

  async check() {
    await Promise.all([this.checkServers(), this.checkN8n()]);
  }

  start(intervalMs = 60000) {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  get() { return [...this.recent]; }
}

module.exports = { AlertWatch, isWatched };
