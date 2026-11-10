// Konten: Wo ist Eris überall angemeldet – und mit welcher E-Mail bzw. welchem Konto?
// Gesammelt aus dem Claude-Konto, den Konnektoren, den Web-Tabs und YouTube; was sich nicht erkennen lässt,
// trägt Eris selbst ein. Hier stehen nie Passwörter, Schlüssel oder Tokens – nur Namen und Adressen.
const fs = require('fs');

const MAX_TEXT = 200;
const MAX_OWN = 100;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

const SERVICES = [
  [/(^|\.)mail\.google\.com$|(^|\.)gmail\.com$/, 'Gmail'],
  [/(^|\.)(calendar|drive|docs)\.google\.com$/, 'Google'],
  [/(^|\.)studio\.youtube\.com$|(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)business\.facebook\.com$/, 'Meta Business'],
  [/(^|\.)facebook\.com$/, 'Facebook'],
  [/(^|\.)outlook\.(live|office)\.com$/, 'Outlook'],
  [/(^|\.)(admin\.)?shopify\.com$|\.myshopify\.com$/, 'Shopify'],
  [/(^|\.)higgsfield\.ai$/, 'Higgsfield'],
  [/(^|\.)amazon\.[a-z.]+$/, 'Amazon'],
  [/^(localhost|127\.0\.0\.1)$/, 'Lokal'],
];

const clip = (s) => String(s == null ? '' : s).trim().slice(0, MAX_TEXT);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function serviceOf(url) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { return null; }
  const hit = SERVICES.find(([re]) => re.test(host));
  return hit ? hit[1] : host.replace(/^www\./, '');
}

function emailIn(text) {
  const m = String(text || '').match(EMAIL);
  return m ? m[0] : '';
}

// „claude.ai Gmail“ → „Gmail“, „plugin:marketing:canva“ → „Canva“
function connectorName(name) {
  const n = String(name).replace(/^claude\.ai\s+/, '').replace(/^plugin:[^:]+:/, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// Eigene Angaben: Zuordnungen (welches Konto steckt hinter einem erkannten Eintrag) und eigene Einträge.
function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const zuordnung = raw && typeof raw.zuordnung === 'object' && !Array.isArray(raw.zuordnung) ? raw.zuordnung : {};
    const eigene = Array.isArray(raw && raw.eigene) ? raw.eigene.filter((e) => e && typeof e.id === 'string') : [];
    return { zuordnung, eigene };
  } catch { return { zuordnung: {}, eigene: [] }; }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Neue Daten mit geänderter Zuordnung (leer = löschen). Die alten bleiben unverändert.
function assign(data, key, konto) {
  const k = clip(key);
  if (!k) return data;
  const { [k]: _old, ...rest } = data.zuordnung;
  const v = clip(konto);
  return { ...data, zuordnung: v ? { ...rest, [k]: v } : rest };
}

function addOwn(data, { dienst, konto, notiz }, id) {
  const d = clip(dienst);
  if (!d || data.eigene.length >= MAX_OWN) return data;
  return { ...data, eigene: [...data.eigene, { id, dienst: d, konto: clip(konto), notiz: clip(notiz) }] };
}

function removeOwn(data, id) {
  return { ...data, eigene: data.eigene.filter((e) => e.id !== id) };
}

// Alle Konten als Liste. Eingaben: claude { email, name, org }, tabs [{ id, name, url, profile, title }],
// mcp [{ name, status }], youtube { title, handle }, n8n bool, data (aus load).
function collect({ claude = null, tabs = [], mcp = [], youtube = null, n8n = false, data = { zuordnung: {}, eigene: [] } }) {
  const own = (key) => data.zuordnung[key] || '';
  const out = [];
  if (claude && claude.email) {
    out.push({ key: 'claude', gruppe: 'Claude', dienst: 'Claude (Abo)', konto: claude.email, stand: 'angemeldet',
      wo: claude.org ? `Organisation: ${claude.org}` : 'Claude Code und alle Chats der Zentrale', auto: true });
  }
  for (const m of mcp) {
    const key = `mcp:${m.name}`;
    const stand = m.status === 'connected' ? 'angemeldet' : m.status === 'needs-auth' ? 'anmelden' : m.status === 'failed' ? 'fehler' : 'aus';
    out.push({ key, gruppe: 'Konnektoren', dienst: connectorName(m.name), konto: own(key), stand,
      wo: /^claude\.ai\s/.test(m.name) ? 'Konnektor auf claude.ai' : 'Konnektor in Claude Code', match: norm(m.name) });
  }
  if (youtube && (youtube.title || youtube.handle)) {
    out.push({ key: 'youtube', gruppe: 'Dienste', dienst: 'YouTube (Hochladen)', konto: [youtube.title, youtube.handle].filter(Boolean).join(' · '),
      stand: 'angemeldet', wo: 'Zentrale lädt Bit-Videos direkt hoch', auto: true });
  }
  if (n8n) out.push({ key: 'n8n', gruppe: 'Dienste', dienst: 'n8n', konto: own('n8n') || 'lokal (localhost:5678)', stand: 'angemeldet', wo: 'Automatisierungen' });
  for (const t of tabs) {
    const key = `tab:${t.id}`;
    const seen = emailIn(t.title);
    out.push({ key, gruppe: 'Web-Tabs', dienst: `${serviceOf(t.url) || t.name}`, tab: t.id, tabName: t.name,
      konto: seen || own(key), stand: seen ? 'angemeldet' : 'unbekannt', auto: !!seen,
      wo: `Web-Tab „${t.name}“${t.profile && t.profile !== 'standard' ? ` · eigener Anmelde-Speicher „${t.profile}“` : ''}` });
  }
  for (const e of data.eigene) {
    out.push({ key: `eigen:${e.id}`, id: e.id, gruppe: 'Selbst eingetragen', dienst: e.dienst, konto: e.konto, stand: 'eingetragen', wo: e.notiz || '', eigen: true });
  }
  return out;
}

module.exports = { serviceOf, emailIn, connectorName, load, save, assign, addOwn, removeOwn, collect };
