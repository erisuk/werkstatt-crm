// Musik sofort erkennen: Spotify und Apple Music melden jeden Titelwechsel, Play und Pause systemweit
// (NSDistributedNotificationCenter). Ein kleiner osascript-Prozess hört mit und meldet jede Änderung als Zeile –
// so muss die Zentrale nicht alle paar Sekunden nachfragen.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const NAMES = ['com.spotify.client.PlaybackStateChanged', 'com.apple.Music.playerInfo', 'com.apple.iTunes.playerInfo'];
const DEBOUNCE_MS = 120;
const RESTART_MS = [2000, 10000, 60000];

function script(names) {
  return `ObjC.import('Foundation');
ObjC.registerSubclass({ name: 'ZentraleMusikBeobachter', methods: { 'changed:': { types: ['void', ['id']],
  implementation: function (n) { console.log('wechsel ' + ObjC.unwrap(n.name)); } } } });
const obs = $.ZentraleMusikBeobachter.alloc.init;
const center = $.NSDistributedNotificationCenter.defaultCenter;
${JSON.stringify(names)}.forEach(function (name) { center.addObserverSelectorNameObject(obs, 'changed:', $(name), $()); }); // $() = nil (null wäre NSNull)
console.log('bereit');
$.NSRunLoop.currentRunLoop.run;`;
}

class MusicWatch extends EventEmitter {
  constructor({ names = NAMES, osascript = '/usr/bin/osascript' } = {}) {
    super();
    this.names = names;
    this.osascript = osascript;
    this.proc = null;
    this.stopped = true;
    this.failures = 0;
    this.timer = null;
  }

  start() {
    if (this.proc || process.platform !== 'darwin') return;
    this.stopped = false;
    const p = spawn(this.osascript, ['-l', 'JavaScript', '-e', script(this.names)], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    let buf = '';
    p.stderr.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (l === 'bereit') { this.failures = 0; this.emit('ready'); }
        else if (l.startsWith('wechsel ')) this.bump();
      }
    });
    p.on('exit', () => {
      if (this.proc === p) this.proc = null;
      if (this.stopped) return;
      // Abgestürzt: mit wachsender Pause neu starten.
      const wait = RESTART_MS[Math.min(this.failures, RESTART_MS.length - 1)];
      this.failures += 1;
      setTimeout(() => { if (!this.stopped) this.start(); }, wait);
    });
    p.on('error', () => {});
  }

  // Mehrere Meldungen kurz hintereinander (Titel + Status) zu einer zusammenfassen.
  bump() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit('change'), DEBOUNCE_MS);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }
}

module.exports = { MusicWatch, NAMES };
