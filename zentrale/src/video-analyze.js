// „Video analysieren“ aus einem Web-Tab: erkennt Video-Seiten, baut den Auftrag für Claude (Skill „watch“)
// und – nur für Seiten, die eine Anmeldung brauchen – eine kurzlebige Cookie-Datei für genau diese Seite.
const SITES = [
  { name: 'YouTube', domain: 'youtube.com', host: /(^|\.)youtube\.com$/, path: /^\/(watch|shorts\/|live\/)/ },
  { name: 'YouTube', domain: 'youtu.be', host: /^youtu\.be$/, path: /^\/[\w-]{6,}/ },
  { name: 'Instagram', domain: 'instagram.com', host: /(^|\.)instagram\.com$/, path: /^\/(reels?|p|tv)\/[\w-]+/, login: true },
  { name: 'TikTok', domain: 'tiktok.com', host: /(^|\.)tiktok\.com$/, path: /^\/@[^/]+\/video\/\d+/ },
  { name: 'Reddit', domain: 'reddit.com', host: /(^|\.)reddit\.com$/, path: /^\/r\/[^/]+\/comments\// },
  { name: 'X', domain: 'x.com', host: /(^|\.)(x|twitter)\.com$/, path: /^\/[^/]+\/status\/\d+/ },
  { name: 'Vimeo', domain: 'vimeo.com', host: /(^|\.)vimeo\.com$/, path: /^\/\d+/ },
  { name: 'Loom', domain: 'loom.com', host: /(^|\.)loom\.com$/, path: /^\/share\// },
  { name: 'Facebook', domain: 'facebook.com', host: /(^|\.)facebook\.com$/, path: /^\/(reel\/|watch|[^/]+\/videos\/)/, login: true },
];

function videoSite(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const site = SITES.find((s) => s.host.test(u.hostname) && s.path.test(u.pathname));
  return site ? { name: site.name, domain: site.domain, login: !!site.login } : null;
}

// Netscape-Cookie-Datei (Format von yt-dlp) nur mit Cookies der einen Seite.
function cookieFileText(cookies, domain) {
  const own = (cookies || []).filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return d === domain || d.endsWith(`.${domain}`);
  });
  const lines = own.map((c) => {
    const d = String(c.domain);
    return [d.startsWith('.') ? d : (c.hostOnly ? d : `.${d}`), c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || (Date.now() / 1000 + 3600)), c.name, c.value].join('\t');
  });
  return { count: own.length, text: `# Netscape HTTP Cookie File\n${lines.join('\n')}\n` };
}

function analyzePrompt(url, site, cookieFile) {
  const q = JSON.stringify(url);
  return [
    `Schau dir bitte dieses ${site.name}-Video mit dem Skill „watch“ an und analysiere es: ${q}`,
    cookieFile ? `Das Video braucht eine Anmeldung. Ruf videocheck dafür mit der Umgebungsvariable VIDEOCHECK_COOKIES=${JSON.stringify(cookieFile)} auf (die Datei enthält nur die ${site.name}-Anmeldung und wird gleich wieder gelöscht – lies sie nicht aus und gib sie nirgends weiter).` : null,
    '',
    'Danach:',
    '1. Fass kurz zusammen, was im Video passiert, wie es wirkt (Hook, Schnitte, Ton, Text) und was man daraus lernen kann.',
    '2. Frag mich, wo die Analyse gespeichert werden soll – im Gehirn (Obsidian), in einem Projektordner oder gar nicht – und speichere erst nach meiner Antwort.',
    '3. Schlag mir 2–3 konkrete nächste Schritte vor (z. B. eigenes Video in dem Stil, Idee für Bit, Konkurrenz beobachten) und lass mich entscheiden.',
  ].filter((x) => x !== null).join('\n');
}

module.exports = { videoSite, cookieFileText, analyzePrompt };
