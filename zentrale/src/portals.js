// Webseiten-Tabs („Portale“): welche Seiten es gibt, wo sie zuletzt standen, Vorschläge.
// Reine Logik ohne Electron, damit sie sich testen lässt; die Anzeige macht web-tabs.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = [
  { group: 'Mail & Büro', name: 'Gmail', url: 'https://mail.google.com/' },
  { group: 'Mail & Büro', name: 'Outlook', url: 'https://outlook.live.com/mail/' },
  { group: 'Mail & Büro', name: 'Outlook (Firma)', url: 'https://outlook.office.com/mail/' },
  { group: 'Mail & Büro', name: 'Google Kalender', url: 'https://calendar.google.com/' },
  { group: 'Mail & Büro', name: 'Google Drive', url: 'https://drive.google.com/' },
  { group: 'Mail & Büro', name: 'web.de', url: 'https://web.de/' },
  { group: 'Mail & Büro', name: 'GMX', url: 'https://www.gmx.net/' },
  { group: 'Social Media', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { group: 'Social Media', name: 'Instagram', url: 'https://www.instagram.com/' },
  { group: 'Social Media', name: 'TikTok', url: 'https://www.tiktok.com/' },
  { group: 'Social Media', name: 'Facebook', url: 'https://www.facebook.com/' },
  { group: 'Social Media', name: 'Messenger', url: 'https://www.messenger.com/' },
  { group: 'Social Media', name: 'Reddit', url: 'https://www.reddit.com/' },
  { group: 'Social Media', name: 'YouTube', url: 'https://www.youtube.com/' },
  { group: 'Social Media', name: 'YouTube Studio', url: 'https://studio.youtube.com/' },
  { group: 'Social Media', name: 'X', url: 'https://x.com/' },
  { group: 'Social Media', name: 'LinkedIn', url: 'https://www.linkedin.com/' },
  { group: 'Social Media', name: 'Telegram', url: 'https://web.telegram.org/' },
  { group: 'Sonstiges', name: 'Shopify', url: 'https://admin.shopify.com/' },
  { group: 'Sonstiges', name: 'Meta Business', url: 'https://business.facebook.com/' },
  { group: 'Sonstiges', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { group: 'Sonstiges', name: 'Spotify', url: 'https://open.spotify.com/' },
];

const MAX_PORTALS = 40;
// Die Kanäle von BIT AI News: eigenes Konto „bit“, damit sie nie mit privaten oder MURIS-Anmeldungen vermischt werden.
const BIT_PROFILE = 'bit';
const BIT_TABS = [
  { name: 'Bit · YouTube Studio', url: 'https://studio.youtube.com/' },
  { name: 'Bit · Instagram', url: 'https://www.instagram.com/' },
  { name: 'Bit · TikTok', url: 'https://www.tiktok.com/' },
];
// Jedes Konto hat seinen eigenen Anmelde-Speicher; „standard“ ist der bisherige gemeinsame.
const PROFILE = /^[a-z0-9-]{1,24}$/;
const profileOf = (v) => (typeof v === 'string' && PROFILE.test(v) ? v : 'standard');
const partitionFor = (profile) => (profileOf(profile) === 'standard' ? 'persist:portale' : `persist:portale-${profileOf(profile)}`);

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

// Google erlaubt keine Anmeldung in eingebauten Browsern (absichtlich, gegen Passwort-Diebstahl). Landet ein Tab
// auf der Anmeldung, öffnet die Zentrale die Seite im normalen Browser – dort klappt die Anmeldung ganz normal.
const isGoogleSignIn = (url) => /^https:\/\/accounts\.google\.com(\/|$)/i.test(String(url || ''));

// Google-Seiten, die eine Anmeldung brauchen: Sie öffnen gleich im normalen Browser (dort ist man angemeldet),
// statt im Tab an der gesperrten Anmeldung zu landen. youtube.com zum Anschauen bleibt im Tab.
const GOOGLE_APPS = new Set(['mail.google.com', 'workspace.google.com', 'accounts.google.com', 'studio.youtube.com', 'drive.google.com',
  'docs.google.com', 'calendar.google.com', 'myaccount.google.com', 'gmail.com', 'www.gmail.com', 'analytics.google.com',
  'business.google.com', 'ads.google.com', 'photos.google.com', 'contacts.google.com', 'keep.google.com']);
function isGoogleApp(url) {
  try { return GOOGLE_APPS.has(new URL(String(url)).hostname.toLowerCase()); } catch { return false; }
}

// Größe eines Anmelde-Fensters: was die Seite bei window.open wünscht (width=…,height=…),
// begrenzt auf vernünftige Maße; ohne Angabe 520 × 720.
const POPUP = { width: [360, 1400, 520], height: [400, 1000, 720] };
function popupSize(features) {
  const out = {};
  for (const [key, [min, max, fallback]] of Object.entries(POPUP)) {
    const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\d+)`, 'i').exec(String(features || ''));
    out[key] = m ? Math.min(max, Math.max(min, Number(m[1]))) : fallback;
  }
  return out;
}

// Wohin Google nach der Anmeldung wollte (continue=…); sonst die Adresse selbst.
function browserTarget(url) {
  if (!isGoogleSignIn(url)) return url;
  try {
    const next = new URL(url).searchParams.get('continue');
    if (next && /^https:\/\//i.test(next) && !isGoogleSignIn(next)) return next;
  } catch {}
  return 'https://accounts.google.com/';
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
      profile: profileOf(p.profile),
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

  // Alle Konten, die gerade benutzt werden (für Speichern/Abmelden), plus ein freier Name für ein neues.
  profiles() {
    return [...new Set(['standard', ...this.list.map((p) => p.profile)])];
  }

  nextProfile() {
    const used = new Set(this.profiles());
    for (let n = 2; n < 100; n += 1) if (!used.has(`konto-${n}`)) return `konto-${n}`;
    return `konto-${Date.now()}`;
  }

  add(name, url, profile = 'standard') {
    const clean = normalizeUrl(url);
    if (!clean) return { ok: false, error: 'Das ist keine gültige Webadresse (z. B. https://outlook.com).' };
    if (this.list.length >= MAX_PORTALS) return { ok: false, error: `Höchstens ${MAX_PORTALS} Seiten.` };
    const pr = profileOf(profile);
    // Das Konto zeigt der Tab als kleine Nummer – der Name bleibt, wie er ist.
    const label = String(name || '').trim() || new URL(clean).hostname;
    const portal = sanitize([{ name: label, url: clean, profile: pr }])[0];
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

module.exports = { BIT_PROFILE, BIT_TABS, PRESETS, PortalStore, normalizeUrl, unreadFromTitle, chromeUserAgent, isGoogleSignIn, isGoogleApp, browserTarget, popupSize, sanitize, MAX_PORTALS, partitionFor, profileOf };
