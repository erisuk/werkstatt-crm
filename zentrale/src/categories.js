// Sortiert Gespräche in Themen: zuerst nach deinem Emoji-Schema im Titel („📈 Trading – …“),
// dann nach Stichwörtern in Titel und erster Nachricht. Selbst gewählte Themen gewinnen immer.
const fs = require('fs');
const path = require('path');

// Reihenfolge = Reihenfolge in der Oberfläche. Die Stichwörter werden in dieser Reihenfolge geprüft,
// der erste Treffer gewinnt (z. B. „TikTok Shop“ landet bei Shop, nicht bei Media).
const CATEGORIES = [
  { id: 'trading', emoji: '📈', label: 'Trading', words: /trading|daytrad|gold-?desk|\bgold\b|xau|\bmt5\b|metatrader|börse|aktie|krypto|bitcoin|memecoin|forex|vantage|qanat|\bbot\b/ },
  { id: 'shop', emoji: '🛒', label: 'Shop', words: /\bshop|muris|sol[eé]va|dropship|\be-?commerce|\becom\b|meta ads|produkt/ },
  { id: 'media', emoji: '🎬', label: 'Media · TikTok & Videos', words: /tiktok|instagram|\breel|youtube|shorts|video|clip|higgsfield|magnific|bit ai|ki-kanal|influencer|social media|viral|kurzfilm|werbefilm|\bspot\b|elevenlabs|\bnoa\b|beat/ },
  { id: 'werkstatt', emoji: '🏭', label: 'Werkstatt', words: /werkstatt|\bcrm\b|kfz|autohaus/ },
  { id: 'garten', emoji: '🌿', label: 'Garten · ESA & Büro', words: /\besa\b|reinigung|wisag|angebot|rechnung|minijob|büro|buero|steuer|garten|lohn/ },
  { id: 'game', emoji: '🎮', label: 'Game', words: /roblox|godot|\bspiel|\bgame|port maren/ },
  { id: '3d', emoji: '🧊', label: '3D', words: /blender|\b3d\b|3d-/ },
  { id: 'gehirn', emoji: '🧠', label: 'Gehirn', words: /obsidian|\bvault|gehirn|global brain|world-desk|second brain/ },
  { id: 'web', emoji: '🌐', label: 'Web', words: /website|webseite|landing ?page|\bwix\b|digitalspatz|domain|\bseo\b/ },
  { id: 'agenten', emoji: '⚙️', label: 'Agenten', words: /agent|n8n|automatisier|workflow|agentic|jarvis|kommandozentrale/ },
  { id: 'venture', emoji: '🚀', label: 'Venture', words: /venture|geschäftsidee|business|geld (zu )?verdienen|30k/ },
  { id: 'job', emoji: '💼', label: 'Job', words: /lebenslauf|bewerbung|\bjob|stellensuche/ },
  { id: 'system', emoji: '🖥️', label: 'System · Mac & Claude', words: /\bmac\b|speicher|terminal|claude|sitzung|installier|hosting|ollama|handy|telegram|gmail|mail|kalender|zentrale|werkzeug|github/ },
  { id: 'div', emoji: '📄', label: 'Div', words: null },
  { id: 'auto', emoji: '🤖', label: 'Automatik & Tests', words: null },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
// Emoji-Schema aus der Seitenleiste der Claude-App. Varianten-Selektoren (U+FE0F) werden ignoriert.
const BY_EMOJI = new Map(CATEGORIES.map((c) => [c.emoji.replace(/️/g, ''), c.id]));

// Titel, die mindestens so oft vorkommen, stammen von geplanten Läufen.
const REPEAT_LIMIT = 5;
// Fortsetzungs-Chats haben alle denselben Titel, sind aber echte Arbeit.
const CONTINUATION = /^(↪|wir setzen eine arbeit fort|unten steht der verlauf|previous session continuation)/i;
// Prüf- und Testaufträge erkennt man am wörtlichen Befehl als Titel.
const TEST_PROMPT = /^(antworte (nur|ausschließlich|ausschliesslich)|run exactly|f(ue|ü)hre (mit|diese|den)|ziel: |lies die datei|lege (zuerst|im)|z(ae|ä)hle|starte genau|liste mit ls|merk dir das kennwort|sieh dir das bild|base directory for this skill|rauchtest|dispatcher probe|ohne titel$)/i;

function emojiCategory(title) {
  const first = String(title || '').trim().split(/\s/)[0].replace(/️/g, '');
  return BY_EMOJI.get(first) || null;
}

// session: { title, snippet, cwd, scheduled }. repeats: wie oft genau dieser Titel vorkommt.
function categorize(session, repeats = 1) {
  const title = String(session.title || '');
  const fromEmoji = emojiCategory(title);
  if (fromEmoji) return fromEmoji;
  if (session.scheduled) return 'auto';
  const isContinuation = CONTINUATION.test(title);
  if (!isContinuation && (repeats >= REPEAT_LIMIT || TEST_PROMPT.test(title.trim()))) return 'auto';
  const text = `${title}\n${session.snippet || ''}\n${session.cwd || ''}`.toLowerCase();
  for (const c of CATEGORIES) if (c.words && c.words.test(text)) return c.id;
  return 'div';
}

// Von dir gewählte Themen, gespeichert als { sessionId: themaId }.
class TopicStore {
  constructor(file) {
    this.file = file;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
    this.map = new Map(entries.filter(([, v]) => BY_ID.has(v)));
  }

  get(id) {
    return this.map.get(id) || null;
  }

  // topic: Themen-ID oder null (= wieder automatisch einsortieren).
  set(ids, topic) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string');
    const next = new Map(this.map);
    for (const id of list) {
      if (topic && BY_ID.has(topic)) next.set(id, topic); else next.delete(id);
    }
    this.map = next;
    this.save();
  }

  forget(ids) {
    this.set(ids, null);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.map), null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }
}

// Ergänzt jede Sitzung um ihr Thema und gibt die Themen mit ihren Gesprächen zurück.
function groupByTopic(projects, store) {
  const all = projects.flatMap((p) => p.sessions);
  const counts = new Map();
  for (const s of all) counts.set(s.title, (counts.get(s.title) || 0) + 1);
  const groups = new Map(CATEGORIES.map((c) => [c.id, []]));
  for (const s of all) {
    const manual = store ? store.get(s.id) : null;
    const topic = manual || categorize(s, counts.get(s.title));
    groups.get(topic).push({ ...s, topic, topicManual: !!manual });
  }
  return CATEGORIES.map((c) => {
    const sessions = groups.get(c.id).sort((a, b) => b.updatedAt - a.updatedAt);
    return { id: c.id, emoji: c.emoji, label: c.label, sessions, updatedAt: sessions.length ? sessions[0].updatedAt : 0 };
  });
}

const TOPICS = CATEGORIES.map(({ id, emoji, label }) => ({ id, emoji, label }));

module.exports = { CATEGORIES, TOPICS, categorize, emojiCategory, TopicStore, groupByTopic };
