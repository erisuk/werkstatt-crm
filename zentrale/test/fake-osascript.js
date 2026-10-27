#!/usr/bin/env node
// Nachbildung von /usr/bin/osascript für Tests: erkennt das Skript am Inhalt und liefert feste Antworten.
const args = process.argv.slice(2);
const params = args.slice(args.indexOf('-') + 1);
if (process.env.FAKE_OSA_LOG) require('fs').appendFileSync(process.env.FAKE_OSA_LOG, JSON.stringify(params) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o));
let script = '';
process.stdin.on('data', (d) => { script += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_OSA_DENY) {
    process.stderr.write('execution error: Not authorized to send Apple events to Calendar. (-1743)\n');
    process.exit(1);
  }
  if (script.includes('EKEventStore')) {
    if (script.includes('requestFullAccess')) return out({ granted: !!process.env.FAKE_EK_ACCESS, status: process.env.FAKE_EK_ACCESS ? 3 : 4 });
    if (!process.env.FAKE_EK_ACCESS) return out({ noAccess: true, status: 4 });
    return out({ fast: true, events: [
      { title: 'Spät', start: '2026-10-26T15:00:00.000Z', end: '2026-10-26T16:00:00.000Z', allDay: false, calendar: 'Privat', recurring: false },
      { title: 'Früh', start: '2026-10-26T07:00:00.000Z', end: '2026-10-26T08:00:00.000Z', allDay: false, calendar: 'Arbeit', recurring: true }] });
  }
  if (process.env.FAKE_OSA_CLOSED && params[0] === '0' && /Calendar|Reminders/.test(script)) return out({ notRunning: true });
  if (script.includes("Application('Calendar')")) {
    return out({
      events: [{ title: 'Zahnarzt', start: '2026-10-26T08:00:00.000Z', end: '2026-10-26T09:00:00.000Z', allDay: false, calendar: 'Privat' }],
      series: [{ title: 'Teamrunde', start: new Date(2026, 0, 5, 10, 0).toISOString(), end: new Date(2026, 0, 5, 11, 0).toISOString(),
        allDay: false, calendar: 'Arbeit', rule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', excluded: [] }],
    });
  }
  if (script.includes('R.Reminder(')) return out({ ok: true });
  if (script.includes("Application('Reminders')")) {
    if (params[1] === 'Gibtsnicht') return out({ error: 'Die Liste „Gibtsnicht“ gibt es in Erinnerungen nicht.' });
    return out([{ title: 'Milch kaufen', list: 'Einkauf', due: null }]);
  }
  if (script.includes("Application('Microsoft Outlook')")) {
    process.stderr.write("execution error: Error: Can't get object. (-1728)\n");
    process.exit(1);
  }
  if (script.includes("Application('Mail')")) return out({ running: false });
  process.stdout.write(`skript:${params.join('|')}`);
});
