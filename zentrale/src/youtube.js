// YouTube über die offizielle Schnittstelle (YouTube Data API v3): Anmeldung einmal im normalen Browser
// (OAuth mit PKCE, Rückleitung an 127.0.0.1), danach lädt die Zentrale Videos selbst hoch – ohne Web-Tab.
// Zugangsdaten (Client-Geheimnis, Refresh-Token) liegen nur verschlüsselt (Schlüsselbund) auf der Platte.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3/videos',
};
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LINGER_MS = 15 * 1000;
const CHUNK = 8 * 1024 * 1024; // Vielfaches von 256 KB, wie Google es für fortsetzbare Uploads verlangt
const MAX_RETRIES = 4;
const BLOCKED_CHANNELS = /muris/i; // Regel: MURIS-Konten nie anfassen
const LIMITS = { title: 100, description: 5000, tags: 500 };

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Die von Google heruntergeladene Datei („client_secret_….json“, Typ Desktop-App).
function parseClientFile(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return { ok: false, error: 'Das ist keine gültige JSON-Datei.' }; }
  const c = j && j.installed;
  if (!c) return { ok: false, error: j && j.web ? 'Das ist ein Client vom Typ „Webanwendung“. Bitte einen vom Typ „Desktop-App“ anlegen.' : 'In der Datei steht kein OAuth-Client von Google.' };
  if (typeof c.client_id !== 'string' || !/\.apps\.googleusercontent\.com$/.test(c.client_id) || typeof c.client_secret !== 'string' || !c.client_secret) {
    return { ok: false, error: 'In der Datei fehlen Client-ID oder Client-Geheimnis.' };
  }
  return { ok: true, client: { id: c.client_id, secret: c.client_secret } };
}

// Hashtags („#ki #news“) → YouTube-Tags (ohne #), zusammen höchstens 500 Zeichen.
function tagsFrom(hashtags) {
  const out = [];
  let len = 0;
  for (const t of String(hashtags || '').split(/\s+/).map((x) => x.replace(/^#+/, '')).filter(Boolean)) {
    if (len + t.length + 1 > LIMITS.tags) break;
    out.push(t);
    len += t.length + 1;
  }
  return out;
}

// Was YouTube über das Video erfahren soll. Liegt die Wunschzeit in der Zukunft, veröffentlicht YouTube selbst.
function videoResource(post, now = Date.now()) {
  const later = Number(post.dueAt) > now + 60 * 1000;
  const description = [String(post.description || ''), String(post.hashtags || '')].filter(Boolean).join('\n\n').slice(0, LIMITS.description);
  return {
    snippet: { title: String(post.title || '').slice(0, LIMITS.title), description, tags: tagsFrom(post.hashtags), categoryId: '22' },
    status: { privacyStatus: later ? 'private' : 'public', ...(later ? { publishAt: new Date(post.dueAt).toISOString() } : {}),
      selfDeclaredMadeForKids: false },
  };
}

class YouTube {
  // encrypt/decrypt: Text ↔ base64 (in der App safeStorage). openExternal: Adresse im normalen Browser öffnen.
  constructor({ file, encrypt, decrypt, openExternal, endpoints = {}, fetchImpl = fetch }) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.openExternal = openExternal;
    this.ep = { ...ENDPOINTS, ...endpoints };
    this.fetch = fetchImpl;
    this.access = null; // { token, until } – nur im Speicher
    this.login = null;
    this.uploading = null;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  secret(key) {
    const v = this.read()[key];
    if (!v) return null;
    try { return JSON.parse(this.decrypt(v)); } catch { return null; }
  }

  status() {
    const d = this.read();
    return { hasClient: !!d.client, connected: !!(d.token && d.channel), channel: d.channel || null, connectedAt: d.connectedAt || null,
      lastUpload: d.lastUpload || null, uploading: this.uploading };
  }

  setClient(text) {
    const r = parseClientFile(text);
    if (!r.ok) return r;
    const d = this.read();
    this.write({ ...d, client: this.encrypt(JSON.stringify(r.client)), token: null, channel: null, connectedAt: null });
    this.access = null;
    return { ok: true };
  }

  async tokenRequest(params) {
    const res = await this.fetch(this.ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.error === 'invalid_grant' ? 'Google hat die Anmeldung zurückgezogen – bitte YouTube neu verbinden.' : `Google lehnte ab: ${j.error_description || j.error || res.status}`);
      err.code = j.error;
      throw err;
    }
    return j;
  }

  // Anmeldung im normalen Browser. Löst auf, sobald Google zur Zentrale zurückleitet.
  async connect() {
    const client = this.secret('client');
    if (!client) return { ok: false, error: 'Zuerst die Datei mit den Google-Anmeldedaten wählen.' };
    if (this.login) return { ok: false, error: 'Die Anmeldung läuft schon – schau in deinen Browser.' };
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    let server;
    this.login = new Promise((resolve) => {
      let done = null;
      // Nach dem Ergebnis bleibt der Server noch kurz offen: Chrome fragt die Rückleitung manchmal doppelt an
      // (Vorabladen), die zweite Anfrage bekäme sonst „Verbindung abgelehnt“.
      const finish = (r) => {
        if (done) return;
        done = r;
        clearTimeout(timer);
        setTimeout(() => server.close(), LINGER_MS).unref();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'Die Anmeldung hat zu lange gedauert. Bitte noch einmal.' }), LOGIN_TIMEOUT_MS);
      const page = (res, ok) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Zentrale</title><body style="font:16px -apple-system,sans-serif;padding:48px">${ok
          ? '<h1>Fertig ✓</h1><p>YouTube ist mit der Zentrale verbunden. Du kannst dieses Fenster schließen.</p>'
          : '<h1>Nicht geklappt</h1><p>Die Anmeldung wurde abgebrochen. Versuch es in der Zentrale noch einmal.</p>'}</body>`);
      };
      server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        // Nur Googles Rückleitung mit unserem state zählt – alles andere (Favicon, Vorabladen, Fremde) wird ignoriert.
        if (u.pathname !== '/' || u.searchParams.get('state') !== state) { res.writeHead(404).end(); return; }
        if (done) { page(res, done.ok); return; }
        const code = u.searchParams.get('code');
        page(res, !!code);
        if (!code) { finish({ ok: false, error: u.searchParams.get('error') === 'access_denied' ? 'Du hast die Anmeldung bei Google abgebrochen.' : 'Die Anmeldung ging nicht.' }); return; }
        finish({ ok: true, code, redirect: `http://127.0.0.1:${server.address().port}` });
      });
      server.on('error', () => finish({ ok: false, error: 'Die Zentrale konnte die Rückleitung von Google nicht empfangen.' }));
      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const url = `${this.ep.auth}?${new URLSearchParams({ client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
          code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state,
          access_type: 'offline', prompt: 'consent' })}`;
        Promise.resolve(this.openExternal(url)).catch(() => finish({ ok: false, error: 'Der Browser ließ sich nicht öffnen.' }));
      });
    });
    let r;
    try { r = await this.login; } finally { this.login = null; }
    if (!r.ok) return r;
    try {
      const t = await this.tokenRequest({ code: r.code, client_id: client.id, client_secret: client.secret, redirect_uri: r.redirect,
        grant_type: 'authorization_code', code_verifier: verifier });
      if (!t.refresh_token) return { ok: false, error: 'Google hat keinen dauerhaften Zugang geschickt. Bitte noch einmal verbinden.' };
      this.access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000 };
      const channel = await this.myChannel();
      if (!channel) return { ok: false, error: 'Zu diesem Google-Konto gibt es keinen YouTube-Kanal.' };
      if (BLOCKED_CHANNELS.test(channel.title)) {
        await this.revoke(t.refresh_token);
        this.access = null;
        return { ok: false, error: `„${channel.title}“ ist ein MURIS-Kanal – den verbindet die Zentrale nicht.` };
      }
      this.write({ ...this.read(), token: this.encrypt(JSON.stringify({ refresh: t.refresh_token })), channel, connectedAt: Date.now() });
      return { ok: true, channel };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async accessToken() {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const client = this.secret('client');
    const tok = this.secret('token');
    if (!client || !tok) throw new Error('YouTube ist nicht verbunden.');
    try {
      const t = await this.tokenRequest({ client_id: client.id, client_secret: client.secret, refresh_token: tok.refresh, grant_type: 'refresh_token' });
      this.access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000 };
      return this.access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') this.write({ ...this.read(), token: null, channel: null, connectedAt: null });
      throw e;
    }
  }

  async api(pathAndQuery, init = {}) {
    const res = await this.fetch(`${this.ep.api}${pathAndQuery}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await this.accessToken()}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiError(j, res.status));
    return j;
  }

  async myChannel() {
    const j = await this.api('/channels?part=snippet&mine=true');
    const c = j.items && j.items[0];
    return c ? { id: c.id, title: (c.snippet && c.snippet.title) || c.id } : null;
  }

  async revoke(token) {
    try { await this.fetch(`${this.ep.revoke}?${new URLSearchParams({ token })}`, { method: 'POST' }); } catch {}
  }

  async disconnect() {
    const tok = this.secret('token');
    if (tok) await this.revoke(tok.refresh);
    this.access = null;
    this.write({ ...this.read(), token: null, channel: null, connectedAt: null });
    return { ok: true };
  }

  // Fortsetzbarer Upload in Stücken; onProgress(0…1). Bricht die Verbindung ab, geht es an der richtigen Stelle weiter.
  async upload(post, { onProgress = () => {}, now = Date.now() } = {}) {
    if (this.uploading) return { ok: false, error: 'Es läuft schon ein Upload.' };
    const st = this.status();
    if (!st.connected) return { ok: false, error: 'YouTube ist nicht verbunden (Verbindungen → YouTube).' };
    if (BLOCKED_CHANNELS.test(st.channel.title)) return { ok: false, error: 'Auf diesen Kanal lädt die Zentrale nichts hoch.' };
    let size;
    try { size = fs.statSync(post.video).size; } catch { return { ok: false, error: `Das Video liegt nicht mehr hier: ${post.video}` }; }
    if (!size) return { ok: false, error: 'Die Videodatei ist leer.' };
    this.uploading = { title: post.title, progress: 0 };
    const resource = videoResource(post, now);
    let fd = null;
    try {
      const start = await this.fetch(`${this.ep.upload}?uploadType=resumable&part=snippet,status`, { method: 'POST', headers: {
        Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*' }, body: JSON.stringify(resource) });
      if (!start.ok) return { ok: false, error: apiError(await start.json().catch(() => ({})), start.status) };
      const session = start.headers.get('location');
      if (!session) return { ok: false, error: 'YouTube hat keine Upload-Adresse geschickt.' };
      fd = fs.openSync(post.video, 'r');
      let offset = 0;
      let retries = 0;
      while (true) {
        const len = Math.min(CHUNK, size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        let res;
        try {
          res = await this.fetch(session, { method: 'PUT', headers: { Authorization: `Bearer ${await this.accessToken()}`,
            'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` }, body: buf });
        } catch (e) {
          res = null;
        }
        if (res && (res.status === 200 || res.status === 201)) {
          const video = await res.json();
          this.uploading = { title: post.title, progress: 1 };
          onProgress(1);
          const result = { id: video.id, url: `https://youtu.be/${video.id}`, privacy: video.status && video.status.privacyStatus,
            publishAt: resource.status.publishAt || null, at: Date.now() };
          this.write({ ...this.read(), lastUpload: { ...result, title: post.title } });
          return { ok: true, ...result };
        }
        if (res && res.status === 308) {
          const range = res.headers.get('range');
          offset = range ? Number(range.split('-')[1]) + 1 : 0;
          retries = 0;
        } else if (!res || res.status >= 500) {
          if (++retries > MAX_RETRIES) return { ok: false, error: 'Die Verbindung zu YouTube bricht immer wieder ab. Später noch einmal versuchen.' };
          await sleep(1000 * 2 ** retries);
          // Nachfragen, wie viel schon angekommen ist.
          const probe = await this.fetch(session, { method: 'PUT', headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } }).catch(() => null);
          if (probe && probe.status === 308) { const r = probe.headers.get('range'); offset = r ? Number(r.split('-')[1]) + 1 : 0; }
          else if (probe && (probe.status === 200 || probe.status === 201)) { offset = size; continue; }
        } else {
          return { ok: false, error: apiError(await res.json().catch(() => ({})), res.status) };
        }
        this.uploading = { title: post.title, progress: offset / size };
        onProgress(offset / size);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch {}
      this.uploading = null;
    }
  }
}

// Googles Fehler in verständliche Sätze.
function apiError(j, status) {
  const e = j && j.error;
  const reason = e && Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return 'Das tägliche Upload-Limit von YouTube ist erreicht. Morgen geht es wieder.';
  if (reason === 'youtubeSignupRequired') return 'Dieses Google-Konto hat noch keinen YouTube-Kanal.';
  if (status === 401) return 'Die Anmeldung bei YouTube ist abgelaufen – bitte neu verbinden.';
  if (status === 403 && /has not been used|disabled/i.test((e && e.message) || '')) return 'Die „YouTube Data API v3“ ist im Google-Cloud-Projekt noch nicht eingeschaltet.';
  return `YouTube meldet einen Fehler (${status}): ${(e && e.message) || 'unbekannt'}`;
}

module.exports = { YouTube, parseClientFile, videoResource, tagsFrom, SCOPES, apiError };
