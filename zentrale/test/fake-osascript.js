#!/usr/bin/env node
// Nachbildung von /usr/bin/osascript für Tests: erkennt das Skript am Inhalt und liefert feste Antworten.
const args = process.argv.slice(2);
const params = args.slice(args.indexOf('-') + 1);
if (process.env.FAKE_OSA_LOG) require('fs').appendFileSync(process.env.FAKE_OSA_LOG, JSON.stringify(params) + '\n');
let script = '';
process.stdin.on('data', (d) => { script += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_OSA_DENY) {
    process.stderr.write('execution error: Not authorized to send Apple events to Calendar. (-1743)\n');
    process.exit(1);
  }
  if (script.includes("Application('Calendar')")) {
    process.stdout.write(JSON.stringify([{ title: 'Zahnarzt', start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T10:00:00.000Z', allDay: false, calendar: 'Privat' }]));
  } else if (script.includes('R.Reminder(')) {
    process.stdout.write(JSON.stringify({ ok: true }));
  } else if (script.includes("Application('Reminders')")) {
    process.stdout.write(JSON.stringify([{ title: 'Milch kaufen', list: 'Einkauf', due: null }]));
  } else if (script.includes("Application('Microsoft Outlook')")) {
    process.stderr.write("execution error: Error: Can't get object. (-1728)\n");
    process.exit(1);
  } else if (script.includes("Application('Mail')")) {
    process.stdout.write(JSON.stringify({ running: false }));
  } else {
    process.stdout.write(`skript:${params.join('|')}`);
  }
});
