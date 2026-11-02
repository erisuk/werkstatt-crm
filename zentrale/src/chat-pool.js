// Mehrere Chats gleichzeitig: Der sichtbare Chat gehört dem Hauptprozess, alle anderen „parken“ hier
// und arbeiten im Hintergrund weiter. Jeder hat einen eigenen Claude-Prozess samt Konnektoren –
// darum gibt es eine Obergrenze, und untätige Hintergrund-Chats schließen sich nach einer Weile.
const path = require('path');

const MAX_CHATS = 3; // 16 GB Arbeitsspeicher: mehr Claude-Prozesse samt Konnektoren werden zäh
const CHAT_IDLE_MS = 30 * 60 * 1000;

const chatTitle = (c) => c.title || 'Neues Gespräch';
// Schließen darf man nur, was gerade nicht arbeitet und auf keine Freigabe wartet.
const closable = (c) => c.status !== 'busy' && c.pendingApprovals().length === 0;

class ChatPool {
  constructor({ max = MAX_CHATS, idleMs = CHAT_IDLE_MS } = {}) {
    this.max = max;
    this.idleMs = idleMs;
    this.parked = new Map(); // sessionId → Chat im Hintergrund
  }

  all(active) {
    return [active, ...this.parked.values()].filter(Boolean);
  }

  get(sessionId) {
    return this.parked.get(sessionId) || null;
  }

  // Holt einen Hintergrund-Chat nach vorn (er läuft einfach weiter).
  take(sessionId) {
    const c = this.parked.get(sessionId) || null;
    if (c) this.parked.delete(sessionId);
    return c;
  }

  close(c) {
    if (this.parked.get(c.sessionId) === c) this.parked.delete(c.sessionId);
    c.dispose().catch(() => {});
  }

  // Der bisher sichtbare Chat wandert in den Hintergrund – außer er hatte noch keine einzige Nachricht.
  park(c) {
    if (!c || c.disposed) return;
    if (!c.sessionSaved() && c.status !== 'busy') { c.dispose().catch(() => {}); return; }
    const prev = this.parked.get(c.sessionId);
    if (prev && prev !== c) prev.dispose().catch(() => {});
    this.parked.set(c.sessionId, c);
  }

  // Zu viele: der am längsten untätige Hintergrund-Chat schließt sich (sein Gespräch bleibt gespeichert).
  trim() {
    while (this.parked.size >= this.max) {
      const idle = [...this.parked.values()].filter(closable).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle) break;
      this.close(idle);
    }
  }

  // Platz für einen weiteren Claude-Prozess? Sonst muss erst ein Chat fertig werden.
  hasRoom(active) {
    const all = this.all(active);
    return all.length < this.max || all.some(closable) || (!!active && !active.sessionSaved());
  }

  // Untätige Hintergrund-Chats nach idleMs schließen. Gibt zurück, wie viele es waren.
  sweep(now = Date.now()) {
    const stale = [...this.parked.values()].filter((c) => closable(c) && now - c.lastActive > this.idleMs);
    for (const c of stale) this.close(c);
    return stale.length;
  }

  list(active) {
    return this.all(active).map((c) => ({ sessionId: c.sessionId, title: chatTitle(c), name: path.basename(c.cwd) || c.cwd,
      status: c.status, active: c === active, waiting: c.pendingApprovals().length }));
  }

  fullMessage() {
    return `Es arbeiten schon ${this.max} Chats gleichzeitig. Warte, bis einer fertig ist, oder schließ einen rechts unter „Agenten“.`;
  }
}

module.exports = { ChatPool, chatTitle, closable, MAX_CHATS, CHAT_IDLE_MS };
