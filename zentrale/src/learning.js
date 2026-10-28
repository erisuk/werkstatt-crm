// Lernloop für Claude: Themen, die Eris aufschreibt (etwas klappte nicht, etwas gefiel nicht), werden zu
// Lernrunden mit Protokoll. Gelerntes landet dauerhaft in ~/.claude/lernen/LEKTIONEN.md (jedes Gespräch der
// Zentrale bekommt den Hinweis darauf) und als Notiz im Gehirn. Nachprüfungen nach 1, 3 und 7 Tagen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LESSONS_FILE = path.join(os.homedir(), '.claude', 'lernen', 'LEKTIONEN.md');
const METHODS_FILE = path.join(os.homedir(), '.claude', 'lernen', 'LERNMETHODEN.md');
const REVIEW_DAYS = [1, 3, 7];
const DAY = 24 * 3600 * 1000;
const SECTIONS = [
  ['improved', 'Was verbessert wurde'],
  ['unclear', 'Was ich noch nicht verstehe'],
  ['plan', 'Wie ich es verstehen werde'],
  ['todo', 'Was ich dafür tue'],
  ['method', 'Wie ich am besten gelernt habe'],
];
const clip = (v, n) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, n);
const slug = (s) => clip(s, 60).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Thema';
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Protokoll-Datei lesen: Abschnitte nach den festen Überschriften, plus Nachprüfungen.
function parseProtocol(text) {
  const out = {};
  for (const [key, title] of SECTIONS) {
    const m = new RegExp(`##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i').exec(text);
    out[key] = m ? m[1].trim().slice(0, 4000) : '';
  }
  out.reviews = [...text.matchAll(/##\s*Nachprüfung\s+(\d{4}-\d{2}-\d{2})\s*[–-]\s*(bestanden|nicht bestanden)/gi)]
    .map((m) => ({ day: m[1], passed: /^bestanden/i.test(m[2]) }));
  return out;
}

class LearningStore {
  constructor(file, protocolDir) {
    this.file = file;
    this.protocolDir = protocolDir;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    this.lessons = Array.isArray(d.lessons) ? d.lessons.filter((l) => l && typeof l.id === 'string') : [];
    this.active = typeof d.active === 'string' ? d.active : null;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ lessons: this.lessons, active: this.active }, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }

  protocolPath(l) { return path.join(this.protocolDir, `${l.day} ${slug(l.topic)}.md`); }

  add(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const topic = clip(r.topic, 120);
    if (!topic) return { ok: false, error: 'Bitte ein Thema angeben – was soll ich lernen?' };
    const l = { id: crypto.randomUUID(), topic, problem: clip(r.problem, 2000), example: clip(r.example, 1000), day: localDay(),
      status: 'offen', createdAt: Date.now(), learnedAt: null };
    this.lessons = [l, ...this.lessons].slice(0, 200);
    if (r.activate !== false) this.active = l.id;
    this.save();
    return { ok: true, lesson: l };
  }

  remove(id) {
    this.lessons = this.lessons.filter((l) => l.id !== id);
    if (this.active === id) this.active = null;
    this.save();
  }

  setActive(id) { this.active = this.lessons.some((l) => l.id === id) ? id : null; this.save(); }

  activeLesson() { return this.lessons.find((l) => l.id === this.active) || null; }

  // Protokolle einlesen: liegt eins vor, ist das Thema gelernt. Nächste Nachprüfung = gelernt am + 1/3/7 Tage,
  // je nachdem, wie viele schon im Protokoll stehen.
  refresh(now = Date.now()) {
    let changed = false;
    this.lessons = this.lessons.map((l) => {
      let text = null;
      try { text = fs.readFileSync(this.protocolPath(l), 'utf8'); } catch {}
      if (!text) return l;
      const protocol = parseProtocol(text);
      const next = { ...l, protocol };
      if (l.status === 'offen') { next.status = 'gelernt'; next.learnedAt = now; changed = true; }
      if (next.status === 'gelernt' && protocol.reviews.filter((x) => x.passed).length >= REVIEW_DAYS.length) { next.status = 'geprüft'; changed = true; }
      return next;
    });
    if (changed) this.save();
    return this.list(now);
  }

  nextReview(l) {
    if (l.status !== 'gelernt' || !l.learnedAt) return null;
    const done = l.protocol ? l.protocol.reviews.length : 0;
    return done < REVIEW_DAYS.length ? l.learnedAt + REVIEW_DAYS[done] * DAY : null;
  }

  dueReviews(now = Date.now()) {
    return this.lessons.filter((l) => { const t = this.nextReview(l); return t !== null && t <= now; });
  }

  list(now = Date.now()) {
    return { active: this.active, lessons: this.lessons.map((l) => {
      const next = this.nextReview(l);
      return { ...l, protocolFile: this.protocolPath(l), nextReview: next, reviewDue: next !== null && next <= now };
    }) };
  }
}

const q = (s) => JSON.stringify(String(s || ''));

// Auftrag für eine Lernrunde.
function learnPrompt(l, protocolFile) {
  return [
    `LERNRUNDE: Heute lernst du ${q(l.topic)} und verbesserst dich darin.`,
    l.problem ? `Was nicht geklappt hat bzw. Eris nicht gefallen hat: ${q(l.problem)}` : null,
    l.example ? `Beispiel/Fundstelle: ${q(l.example)}` : null,
    '',
    'So gehst du vor (Lernen lernen):',
    '1. Verstehen: Beschreib in 2–3 Sätzen, was genau schiefging und warum. Frag Eris höchstens eine Rückfrage, wenn es unklar ist.',
    '2. Ursache finden: Schau in frühere Gespräche, Notizen im Gehirn und offizielle Quellen (Doku, Hersteller). Rate nicht – belege.',
    `3. Üben: Mach eine kleine echte Übung dazu und prüf das Ergebnis selbst. Lies vorher ${METHODS_FILE}, falls vorhanden – dort steht, wie du am besten lernst.`,
    `4. Festhalten: Schreib die Lektion als kurze Regel (Was, Warum, Wie anwenden) unten an ${LESSONS_FILE} an (Datei anlegen, falls es sie nicht gibt; nie Bestehendes löschen). Passt sie zu deinem Gedächtnis-System, lege zusätzlich eine feedback-Erinnerung an.`,
    `5. Protokoll: Schreib das Protokoll nach ${q(protocolFile)} mit genau diesen Überschriften:`,
    ...SECTIONS.map(([, t]) => `   ## ${t}`),
    `6. Was beim Lernen geholfen hat, ergänze kurz in ${METHODS_FILE}.`,
    '',
    'Sei ehrlich: Was du noch nicht verstehst, gehört ins Protokoll – nicht weglassen. Keine Zugangsdaten, keine privaten Finanzdaten in Dateien.',
  ].filter((x) => x !== null).join('\n');
}

// Auftrag für eine Nachprüfung (verteilte Wiederholung).
function reviewPrompt(l, protocolFile) {
  return [
    `NACHPRÜFUNG: Thema ${q(l.topic)}. Lies dein Protokoll ${q(protocolFile)} und die Lektion in ${LESSONS_FILE}.`,
    'Stell dir selbst eine neue, kleine Aufgabe dazu (nicht dieselbe wie beim Lernen), löse sie und prüf das Ergebnis ehrlich.',
    `Häng ans Protokoll an: „## Nachprüfung ${localDay()} – bestanden“ oder „– nicht bestanden“, darunter 2–4 Sätze, was gut lief und was nicht.`,
    'Nicht bestanden: passe die Lektion und „Was ich dafür tue“ an.',
  ].join('\n');
}

// Kurzer Hinweis für jedes Gespräch der Zentrale.
function systemHint(active) {
  const parts = [`Deine gelernten Lektionen stehen in ${LESSONS_FILE} – lies sie, wenn sie zur Aufgabe passen, und halte dich daran.`];
  if (active) parts.push(`Heutiges Lernthema: ${q(active.topic)}${active.problem ? ` (${clip(active.problem, 200)})` : ''}. Achte heute in allem, was du tust, besonders darauf.`);
  return parts.join(' ');
}

module.exports = { LearningStore, parseProtocol, learnPrompt, reviewPrompt, systemHint, LESSONS_FILE, METHODS_FILE, SECTIONS, REVIEW_DAYS };
