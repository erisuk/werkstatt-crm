// Tests für „Video analysieren“: Video-Seiten erkennen, Cookie-Datei nur für die eine Seite, Auftrag.
const test = require('node:test');
const assert = require('node:assert');
const { videoSite, cookieFileText, analyzePrompt } = require('../src/video-analyze');

test('Video-Seiten werden erkannt, Startseiten und fremde Adressen nicht', () => {
  assert.strictEqual(videoSite('https://www.youtube.com/watch?v=abc123').name, 'YouTube');
  assert.strictEqual(videoSite('https://www.youtube.com/shorts/abc123').name, 'YouTube');
  assert.strictEqual(videoSite('https://youtu.be/abc12345').name, 'YouTube');
  assert.deepStrictEqual(videoSite('https://www.instagram.com/reel/Cx1_ab/'), { name: 'Instagram', domain: 'instagram.com', login: true });
  assert.strictEqual(videoSite('https://www.tiktok.com/@bit/video/123456').name, 'TikTok');
  assert.strictEqual(videoSite('https://www.reddit.com/r/videos/comments/abc/titel/').name, 'Reddit');
  assert.strictEqual(videoSite('https://x.com/user/status/123').name, 'X');
  for (const bad of ['https://www.youtube.com/', 'https://www.instagram.com/bit.ai.news/', 'http://www.youtube.com/watch?v=x',
    'https://youtube.com.evil.de/watch?v=x', 'https://a:b@www.youtube.com/watch?v=x', 'javascript:alert(1)', null]) {
    assert.strictEqual(videoSite(bad), null, String(bad));
  }
});

test('Cookie-Datei enthält nur Cookies der einen Seite', () => {
  const { count, text } = cookieFileText([
    { domain: '.instagram.com', name: 'sessionid', value: 'S', path: '/', secure: true, expirationDate: 2000000000 },
    { domain: 'www.instagram.com', hostOnly: true, name: 'csrftoken', value: 'C', path: '/', secure: true },
    { domain: '.google.com', name: 'SID', value: 'G', path: '/', secure: true },
    { domain: 'eviliinstagram.com', name: 'x', value: 'E', path: '/' },
  ], 'instagram.com');
  assert.strictEqual(count, 2);
  assert.match(text, /^# Netscape HTTP Cookie File\n/);
  assert.match(text, /\.instagram\.com\tTRUE\t\/\tTRUE\t2000000000\tsessionid\tS/);
  assert.match(text, /www\.instagram\.com\tFALSE\t\/\tTRUE\t\d+\tcsrftoken\tC/);
  assert.ok(!/SID|evil/.test(text));
});

test('Auftrag: Skill watch, Adresse als Daten, Speicherort erst nach Rückfrage', () => {
  const p = analyzePrompt('https://www.youtube.com/watch?v=abc"&x=1', { name: 'YouTube' });
  assert.match(p, /Skill „watch“/);
  assert.match(p, /"https:\/\/www\.youtube\.com\/watch\?v=abc\\"&x=1"/);
  assert.match(p, /speichere erst nach meiner Antwort/);
  assert.ok(!/VIDEOCHECK_COOKIES/.test(p));
  assert.match(analyzePrompt('https://www.instagram.com/reel/x/', { name: 'Instagram' }, '/Users/x/v.mp4'), /schon heruntergeladen: "\/Users\/x\/v\.mp4"/);
});
