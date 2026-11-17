// Ist ein Web-Tab angemeldet? Erkennbar am Login-Cookie der Seite – gelesen wird nur, ob es da ist, nie sein Inhalt.
// „sicher“: Fehlt das Cookie, ist man bei dieser Seite wirklich abgemeldet. Sonst heißt fehlend nur „unbekannt“.
const RULES = [
  { host: /(^|\.)instagram\.com$/, names: ['sessionid'], sicher: true },
  { host: /(^|\.)tiktok\.com$/, names: ['sessionid', 'sid_tt'], sicher: true },
  { host: /(^|\.)facebook\.com$/, names: ['c_user'], sicher: true },
  { host: /(^|\.)linkedin\.com$/, names: ['li_at'], sicher: true },
  { host: /(^|\.)(x|twitter)\.com$/, names: ['auth_token'], sicher: true },
  { host: /(^|\.)amazon\.[a-z.]+$/, names: ['at-main', 'x-main', 'at-acbde', 'x-acbde'], sicher: false },
];

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

// Die Cookie-Domain einer Seite: die letzten zwei Teile (business.facebook.com → facebook.com, amazon.de → amazon.de).
function cookieDomain(url) {
  const host = hostOf(url);
  return host ? host.split('.').slice(-2).join('.') : '';
}

function ruleFor(url) {
  const host = hostOf(url);
  return host ? RULES.find((r) => r.host.test(host)) || null : null;
}

// cookies: [{ name }] der Seite. Ergebnis: 'angemeldet' | 'abgemeldet' | 'unbekannt'.
function loginState(url, cookies) {
  const rule = ruleFor(url);
  if (!rule) return 'unbekannt';
  const has = (cookies || []).some((c) => c && rule.names.includes(c.name));
  if (has) return 'angemeldet';
  return rule.sicher ? 'abgemeldet' : 'unbekannt';
}

module.exports = { loginState, cookieDomain, ruleFor };
