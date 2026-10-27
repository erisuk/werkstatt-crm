// Webseiten-Tabs („Portale“): welche Seiten es gibt, wo sie zuletzt standen, Vorschläge.
// Reine Logik ohne Electron, damit sie sich testen lässt; die Anzeige macht web-tabs.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = [
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Outlook', url: 'https://outlook.live.com/mail/' },
  { name: 'Outlook (Firma)', url: 'https://outlook.office.com/mail/' },
  { name: 'Google Kalender', url: 'https://calendar.google.com/' },
  { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { name: 'Shopify', url: 'https://admin.shopify.com/' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Google Drive', url: 'https://drive.google.com/' },
];

const MAX_PORTALS = 30;

// Nur echte Webadressen; ohne "https://" ergänzen wir es. Gibt null bei ungültiger Eingabe.
function normalizeUrl(input) {
  let t = String(input || '').trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
  let u;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || !u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  if (u.username || u.password) return null; // keine Zugangsdaten in der Adresse
  return u.href;
}

// Ungelesene aus dem Seitentitel, z. B. „Posteingang (3) – Gmail“ oder „(12) WhatsApp“.
function unreadFromTitle(title) {
  const m = /\((\d{1,4})\)/.exec(String(title || ''));
  return m ? Number(m[1]) : 0;
}

// Google und Microsoft lehnen Anmeldungen ab, wenn sich der Browser als „Electron“ ausgibt.
// Wir melden uns deshalb wie das Chrome, auf dem Electron beruht.
function chromeUserAgent(ua) {
  return String(ua || '').replace(/\s(Electron|zentrale|Zentrale)\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const url = normalizeUrl(p.url);
    if (!url) continue;
    const last = normalizeUrl(p.lastUrl);
    out.push({
      id: typeof p.id === 'string' && /^[\w-]{1,64}$/.test(p.id) ? p.id : crypto.randomUUID(),
      name: String(p.name || new URL(url).hostname).trim().slice(0, 40) || new URL(url).hostname,
      url,
      lastUrl: last && new URL(last).origin === new URL(url).origin ? last : null,
    });
    if (out.length >= MAX_PORTALS) break;
  }
  return out;
}

class PortalStore {
  constructor(file) {
    this.file = file;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.list = sanitize(raw && raw.portals);
    this.active = raw && this.list.some((p) => p.id === raw.active) ? raw.active : null;
    this.timer = null;
  }

  get() {
    return { portals: this.list.map((p) => ({ ...p })), active: this.active };
  }

  add(name, url) {
    const clean = normalizeUrl(url);
    if (!clean) return { ok: false, error: 'Das ist keine gültige Webadresse (z. B. https://outlook.com).' };
    if (this.list.length >= MAX_PORTALS) return { ok: false, error: `Höchstens ${MAX_PORTALS} Seiten.` };
    const portal = sanitize([{ name: String(name || '').trim() || new URL(clean).hostname, url: clean }])[0];
    this.list = [...this.list, portal];
    this.active = portal.id;
    this.save();
    return { ok: true, portal };
  }

  rename(id, name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return false;
    this.list = this.list.map((p) => (p.id === id ? { ...p, name: n } : p));
    this.save();
    return true;
  }

  remove(id) {
    this.list = this.list.filter((p) => p.id !== id);
    if (this.active === id) this.active = this.list[0] ? this.list[0].id : null;
    this.save();
  }

  setActive(id) {
    if (!this.list.some((p) => p.id === id)) return false;
    this.active = id;
    this.save();
    return true;
  }

  // Wo die Seite zuletzt war; beim Neustart geht es dort weiter (nur auf derselben Website).
  remember(id, url) {
    const p = this.list.find((x) => x.id === id);
    const clean = normalizeUrl(url);
    if (!p || !clean || new URL(clean).origin !== new URL(p.url).origin || p.lastUrl === clean) return;
    this.list = this.list.map((x) => (x.id === id ? { ...x, lastUrl: clean } : x));
    // Beim Surfen ändert sich die Adresse ständig: gebündelt speichern.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 1500);
  }

  save() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ portals: this.list, active: this.active }, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }
}

module.exports = { PRESETS, PortalStore, normalizeUrl, unreadFromTitle, chromeUserAgent, sanitize, MAX_PORTALS };
