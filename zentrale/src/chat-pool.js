// Mehrere Chats gleichzeitig: Der sichtbare Chat gehört dem Hauptprozess, alle anderen „parken“ hier
// und arbeiten im Hintergrund weiter. Jeder wache Chat hat einen eigenen Claude-Prozess samt Konnektoren
// (~350 MB). Darum: viele Chats in der Liste, aber nur wenige wach – untätige schlafen ein (Prozess aus,
// Gespräch gespeichert) und wachen beim nächsten Senden mit dem ganzen Verlauf wieder auf.
const path = require('path');

const MAX_CHATS = 12; // Chats in der Liste rechts
const MAX_AWAKE = 5; // gleichzeitig laufende Claude-Prozesse – 16 GB Arbeitsspeicher
const CHAT_IDLE_MS = 10 * 60 * 1000; // so lange untätig, dann schläft ein Hintergrund-Chat ein

const chatTitle = (c) => c.title || 'Neues Gespräch';
// Schließen oder einschläfern darf man nur, was gerade nicht arbeitet und auf keine Freigabe wartet.
const closable = (c) => c.status !== 'busy' && c.pendingApprovals().length === 0;
const isAwake = (c) => !!c.alive;

class ChatPool {
  constructor({ max = MAX_CHATS, awakeMax = MAX_AWAKE, idleMs = CHAT_IDLE_MS } = {}) {
    this.max = max;
    this.awakeMax = awakeMax;
    this.idleMs = idleMs;
    this.parked = new Map(); // sessionId → Chat im Hintergrund (wach oder schlafend)
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

  // Gibt das Beenden zurück: Wer danach Dateien löscht, wartet darauf (sonst schreibt Claude noch hinein).
  close(c) {
    if (this.parked.get(c.sessionId) === c) this.parked.delete(c.sessionId);
    return c.dispose().catch(() => {});
  }

  // Der bisher sichtbare Chat wandert in den Hintergrund – außer er hatte noch keine einzige Nachricht.
  park(c) {
    if (!c || c.disposed) return;
    if (!c.sessionSaved() && c.status !== 'busy') { c.dispose().catch(() => {}); return; }
    const prev = this.parked.get(c.sessionId);
    if (prev && prev !== c) prev.dispose().catch(() => {});
    c.lastActive = Date.now(); // gerade noch angeschaut – nicht sofort als „untätig“ einschläfern
    this.parked.set(c.sessionId, c);
  }

  // Zu viele in der Liste: der am längsten untätige Hintergrund-Chat geht (sein Gespräch bleibt gespeichert).
  trim() {
    while (this.parked.size >= this.max) {
      const idle = [...this.parked.values()].filter(closable).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle) break;
      this.close(idle);
    }
  }

  // Platz für einen weiteren Chat in der Liste? Sonst muss erst einer fertig werden.
  hasRoom(active) {
    const all = this.all(active);
    return all.length < this.max || [...this.parked.values()].some(closable)
      || (!!active && active.status !== 'busy' && !active.sessionSaved());
  }

  // Bevor `next` seinen Prozess startet: Sind schon awakeMax Chats wach, schläft der am längsten untätige ein
  // (Hintergrund-Chats vor dem sichtbaren). false = alle wachen arbeiten gerade, kein Platz.
  wake(active, next) {
    let awake = this.all(active).filter((c) => c !== next && isAwake(c));
    while (awake.length >= this.awakeMax) {
      const idle = awake.filter(closable)
        .sort((a, b) => (a === active) - (b === active) || (a.lastActive || 0) - (b.lastActive || 0))[0];
      if (!idle) return false;
      idle.stop().catch(() => {});
      awake = awake.filter((c) => c !== idle);
    }
    return true;
  }

  // Untätige Hintergrund-Chats nach idleMs einschläfern. Gibt zurück, wie viele es waren.
  sweep(now = Date.now()) {
    const stale = [...this.parked.values()].filter((c) => isAwake(c) && closable(c) && now - (c.lastActive || 0) > this.idleMs);
    for (const c of stale) c.stop().catch(() => {});
    return stale.length;
  }

  awakeCount(active) {
    return this.all(active).filter(isAwake).length;
  }

  list(active) {
    return this.all(active).map((c) => ({ sessionId: c.sessionId, title: chatTitle(c), name: path.basename(c.cwd) || c.cwd,
      status: c.status, active: c === active, waiting: c.pendingApprovals().length,
      asleep: !isAwake(c) && c.status !== 'busy' && c.status !== 'error' }));
  }

  // Was beim Neustart der Zentrale wiederkommen soll: alle Chats mit gespeichertem Gespräch.
  saved(active) {
    return this.all(active).filter((c) => !c.disposed && c.sessionSaved())
      .map((c) => ({ sessionId: c.sessionId, cwd: c.cwd, title: c.title || null }));
  }

  fullMessage() {
    return `Es arbeiten schon ${this.awakeMax} Chats gleichzeitig. Warte, bis einer fertig ist – dann geht es sofort weiter.`;
  }

  listFullMessage() {
    return `Es sind schon ${this.max} Chats offen und alle arbeiten. Warte, bis einer fertig ist, oder schließ einen rechts unter „Agenten“.`;
  }
}

module.exports = { ChatPool, chatTitle, closable, MAX_CHATS, MAX_AWAKE, CHAT_IDLE_MS };
