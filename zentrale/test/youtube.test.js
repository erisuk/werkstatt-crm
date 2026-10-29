const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { YouTube, parseClientFile, videoResource, tagsFrom } = require('../src/youtube');

const CLIENT = JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'geheim', redirect_uris: ['http://localhost'] } });

// Nachgebauter Google-Server: Token, Kanal, fortsetzbarer Upload (wahlweise mit einem Abbruch).
function fakeGoogle({ channel = 'Bit AI News', failOnce = false } = {}) {
  const seen = { tokenCalls: [], uploadMeta: null, bytes: 0, revoked: [] };
  let failed = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body.toString());
        seen.tokenCalls.push(Object.fromEntries(p));
        if (p.get('grant_type') === 'authorization_code') {
          if (p.get('code') !== 'CODE' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: 'AT1', refresh_token: 'RT', expires_in: 3600 });
        }
        if (p.get('refresh_token') !== 'RT') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'AT2', expires_in: 3600 });
      }
      if (u.pathname === '/revoke') { seen.revoked.push(u.searchParams.get('token')); return json(200, {}); }
      if (u.pathname === '/api/channels') {
        if (!/^Bearer AT/.test(req.headers.authorization || '')) return json(401, { error: { message: 'no' } });
        return json(200, { items: [{ id: 'UC1', snippet: { title: channel } }] });
      }
      if (u.pathname === '/upload' && req.method === 'POST') {
        seen.uploadMeta = JSON.parse(body.toString());
        seen.size = Number(req.headers['x-upload-content-length']);
        res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session/1` });
        return res.end();
      }
      if (u.pathname === '/session/1' && req.method === 'PUT') {
        const range = req.headers['content-range'] || '';
        if (range.startsWith('bytes */')) { res.writeHead(308, seen.bytes ? { Range: `bytes=0-${seen.bytes - 1}` } : {}); return res.end(); }
        if (failOnce && !failed) { failed = true; return json(503, { error: { message: 'kurz weg' } }); }
        seen.bytes += body.length;
        if (seen.bytes < seen.size) { res.writeHead(308, { Range: `bytes=0-${seen.bytes - 1}` }); return res.end(); }
        return json(201, { id: 'VID123', status: { privacyStatus: seen.uploadMeta.status.privacyStatus } });
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, seen, endpoints: { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/api`, upload: `${base}/upload` } });
  }));
}

// „Browser“: folgt der Anmelde-Adresse und leitet wie Google mit code + state zurück.
function fakeBrowser(code = 'CODE') {
  return async (url) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('state', u.searchParams.get('state'));
    if (code) back.searchParams.set('code', code); else back.searchParams.set('error', 'access_denied');
    setTimeout(() => http.get(back, (r) => r.resume()), 20);
  };
}

function makeYt(g, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-yt-'));
  return new YouTube({ file: path.join(dir, 'youtube.json'), encrypt: (t) => Buffer.from(`enc:${t}`).toString('base64'),
    decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, ''), openExternal: opts.browser || fakeBrowser(), endpoints: g.endpoints });
}

test('YouTube: Anmeldedatei – nur Desktop-Clients von Google', () => {
  assert.strictEqual(parseClientFile(CLIENT).ok, true);
  assert.match(parseClientFile('{"web":{"client_id":"x"}}').error, /Desktop-App/);
  assert.match(parseClientFile('kein json').error, /JSON/);
  assert.match(parseClientFile('{"installed":{"client_id":"x@y","client_secret":"s"}}').error, /fehlen/);
});

test('YouTube: Titel, Tags, Wunschzeit – in der Zukunft privat mit publishAt, sonst öffentlich', () => {
  const now = Date.UTC(2026, 9, 29, 10);
  const later = videoResource({ title: 'T', description: 'D', hashtags: '#ki #news', dueAt: now + 3600e3 }, now);
  assert.deepStrictEqual(later.status, { privacyStatus: 'private', publishAt: new Date(now + 3600e3).toISOString(), selfDeclaredMadeForKids: false });
  assert.deepStrictEqual(later.snippet.tags, ['ki', 'news']);
  assert.strictEqual(later.snippet.description, 'D\n\n#ki #news');
  assert.strictEqual(videoResource({ title: 'T', dueAt: now - 1000 }, now).status.privacyStatus, 'public');
  assert.ok(tagsFrom(Array.from({ length: 200 }, (_, i) => `#tag${i}`).join(' ')).join(',').length <= 500);
});

test('YouTube: verbinden im Browser (PKCE), Zugang nur verschlüsselt, trennen gibt ihn zurück', async () => {
  const g = await fakeGoogle();
  const yt = makeYt(g);
  try {
    assert.match((await yt.connect()).error, /Datei/);
    assert.strictEqual(yt.setClient(CLIENT).ok, true);
    const r = await yt.connect();
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.channel.title, 'Bit AI News');
    const raw = fs.readFileSync(yt.file, 'utf8');
    assert.ok(!raw.includes('geheim') && !raw.includes('"RT"'), 'Geheimnisse stehen nie im Klartext in der Datei');
    assert.strictEqual(yt.status().connected, true);
    assert.ok(g.seen.tokenCalls[0].code_verifier.length >= 43);
    await yt.disconnect();
    assert.deepStrictEqual(g.seen.revoked, ['RT']);
    assert.strictEqual(yt.status().connected, false);
  } finally { g.server.close(); }
});

test('YouTube: abgebrochene Anmeldung und MURIS-Kanal werden nicht verbunden', async () => {
  const g = await fakeGoogle({ channel: 'shop.muris' });
  try {
    const denied = makeYt(g, { browser: fakeBrowser(null) });
    denied.setClient(CLIENT);
    assert.match((await denied.connect()).error, /abgebrochen/);
    const muris = makeYt(g);
    muris.setClient(CLIENT);
    const r = await muris.connect();
    assert.match(r.error, /MURIS/);
    assert.strictEqual(muris.status().connected, false);
    assert.deepStrictEqual(g.seen.revoked, ['RT']);
  } finally { g.server.close(); }
});

test('YouTube: Upload mit Fortschritt, übersteht einen Verbindungsabbruch', async () => {
  const g = await fakeGoogle({ failOnce: true });
  const yt = makeYt(g);
  const video = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-vid-')), 'clip.mp4');
  fs.writeFileSync(video, Buffer.alloc(300 * 1024, 7));
  try {
    yt.setClient(CLIENT);
    assert.strictEqual((await yt.connect()).ok, true);
    yt.access = null; // erzwingt Erneuern über den Refresh-Token
    const progress = [];
    const r = await yt.upload({ video, title: 'Bit erklärt KI', description: 'Hallo', hashtags: '#ki', dueAt: Date.now() - 1000 }, { onProgress: (p) => progress.push(p) });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.url, 'https://youtu.be/VID123');
    assert.strictEqual(r.privacy, 'public');
    assert.strictEqual(g.seen.bytes, 300 * 1024);
    assert.strictEqual(g.seen.uploadMeta.snippet.title, 'Bit erklärt KI');
    assert.strictEqual(progress[progress.length - 1], 1);
    assert.ok(g.seen.tokenCalls.some((c) => c.grant_type === 'refresh_token'));
    assert.strictEqual(yt.status().lastUpload.id, 'VID123');
    assert.match((await yt.upload({ video: '/gibt/es/nicht.mp4', title: 'x', dueAt: 0 })).error, /nicht mehr hier/);
  } finally { g.server.close(); }
});

test('YouTube: fremde Anfragen an die Rückleitung stören nicht, doppelte Rückleitung bekommt „Fertig“', async () => {
  const g = await fakeGoogle();
  const get = (url) => new Promise((resolve) => http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', (e) => resolve({ error: e.code })));
  let replay = null;
  const browser = async (url) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri'));
    await get(`${back.origin}/`); // Vorabladen ohne state
    await get(`${back.origin}/favicon.ico`);
    back.searchParams.set('state', u.searchParams.get('state'));
    back.searchParams.set('code', 'CODE');
    replay = back.toString();
    setTimeout(() => get(replay), 20);
  };
  const yt = makeYt(g, { browser });
  try {
    yt.setClient(CLIENT);
    const r = await yt.connect();
    assert.strictEqual(r.ok, true, r.error);
    const again = await get(replay);
    assert.strictEqual(again.status, 200);
    assert.match(again.body, /Fertig/);
  } finally { g.server.close(); }
});

test('YouTube: „privat“ und „nicht gelistet“ bleiben so, ohne Veröffentlichungstermin', () => {
  const now = Date.UTC(2026, 9, 29, 10);
  assert.deepStrictEqual(videoResource({ title: 'T', dueAt: now + 3600e3, privacy: 'private' }, now).status, { privacyStatus: 'private', selfDeclaredMadeForKids: false });
  assert.strictEqual(videoResource({ title: 'T', dueAt: now - 1, privacy: 'unlisted' }, now).status.privacyStatus, 'unlisted');
  const { cleanPost } = require('../src/planner');
  const base = { video: path.join(os.homedir(), 'Movies', 'x.mp4'), title: 'T', dueAt: now, targets: [{ platform: 'youtube', tabId: 'youtube-api', tabName: 'YouTube direkt' }] };
  assert.strictEqual(cleanPost({ ...base, privacy: 'private' }).post.privacy, 'private');
  assert.strictEqual(cleanPost({ ...base, privacy: 'öffentlich!' }).post.privacy, 'auto');
});
