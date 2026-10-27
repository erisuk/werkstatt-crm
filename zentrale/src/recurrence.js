// Berechnet die Termine einer Serie (iCalendar-Regel wie "FREQ=WEEKLY;BYDAY=MO,WE") in einem Zeitraum.
// Der Mac-Kalender liefert per Skript nur den ersten Termin einer Serie; die übrigen rechnen wir hier aus.

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_STEPS = 20000;

function parseRule(text) {
  const rule = {};
  for (const part of String(text || '').replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v) rule[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  return rule;
}

// UNTIL kann ein Datum (20261231) oder ein Zeitpunkt (20261231T235959Z) sein.
function parseUntil(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return new Date(+y, +mo - 1, +d, 23, 59, 59);
  return z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function withTime(day, master) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), master.getHours(), master.getMinutes(), master.getSeconds());
}

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

// n-ter Wochentag im Monat (n = -1 für den letzten).
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(y, m, 1).getDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(y, m) ? day : null;
  }
  const last = daysInMonth(y, m);
  const lastDay = new Date(y, m, last).getDay();
  const day = last - ((lastDay - weekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
}

// Liefert alle Startzeitpunkte der Serie in zeitlicher Reihenfolge, Abbruch über visit() === false.
function eachStart(master, rule, visit) {
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const freq = rule.FREQ;
  const byDay = rule.BYDAY ? rule.BYDAY.split(',').map((d) => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.trim());
    return m ? { n: m[1] ? parseInt(m[1], 10) : 0, day: DAYS[m[2]] } : null;
  }).filter(Boolean) : [];
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map((x) => parseInt(x, 10)).filter((x) => x) : [];
  const byMonth = rule.BYMONTH ? rule.BYMONTH.split(',').map((x) => parseInt(x, 10) - 1).filter((x) => x >= 0 && x < 12).sort((a, b) => a - b) : [];
  // BYSETPOS wählt aus den Tagen einer Periode aus, z. B. -1 = der letzte (letzter Werktag im Monat).
  const bySetPos = rule.BYSETPOS ? rule.BYSETPOS.split(',').map((x) => parseInt(x, 10)).filter((x) => x) : [];

  // Tage eines Monats nach BYDAY (mit Zahl: n-ter Wochentag, ohne Zahl: jeder) oder BYMONTHDAY.
  const daysInPeriod = (y, m, master) => {
    let days = [];
    if (byDay.length) {
      days = byDay.flatMap((b) => (b.n ? [nthWeekday(y, m, b.day, b.n)]
        : [1, 2, 3, 4, 5].map((n) => nthWeekday(y, m, b.day, n))));
    } else if (byMonthDay.length) days = byMonthDay.map((d) => (d > 0 ? d : daysInMonth(y, m) + d + 1));
    else days = [master.getDate()];
    let list = [...new Set(days.filter((d) => d && d >= 1 && d <= daysInMonth(y, m)))].sort((a, b) => a - b);
    if (bySetPos.length) list = bySetPos.map((p) => list[p > 0 ? p - 1 : list.length + p]).filter((d) => d != null).sort((a, b) => a - b);
    return list.map((d) => withTime(new Date(y, m, d), master));
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    let starts = [];
    if (freq === 'DAILY') {
      const d = new Date(master.getFullYear(), master.getMonth(), master.getDate() + step * interval);
      starts = [withTime(d, master)];
    } else if (freq === 'WEEKLY') {
      const weekStart = new Date(master.getFullYear(), master.getMonth(), master.getDate() - master.getDay() + step * interval * 7);
      const days = byDay.length ? byDay.map((b) => b.day) : [master.getDay()];
      starts = [...new Set(days)].sort((a, b) => a - b)
        .map((wd) => withTime(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd), master));
    } else if (freq === 'MONTHLY') {
      const base = new Date(master.getFullYear(), master.getMonth() + step * interval, 1);
      starts = daysInPeriod(base.getFullYear(), base.getMonth(), master);
    } else if (freq === 'YEARLY') {
      // Mit BYMONTH/BYDAY z. B. „2. Sonntag im Mai“ (Muttertag) oder „letzter Sonntag im Oktober“.
      const y = master.getFullYear() + step * interval;
      const months = byMonth.length ? byMonth : [master.getMonth()];
      starts = months.flatMap((m) => (byDay.length || byMonthDay.length ? daysInPeriod(y, m, master)
        : master.getDate() <= daysInMonth(y, m) ? [withTime(new Date(y, m, master.getDate()), master)] : []))
        .sort((a, b) => a - b);
    } else {
      return;
    }
    for (const s of starts) {
      if (s < master) continue;
      if (visit(s) === false) return;
    }
  }
}

// master: { start, end } als Date oder ISO-Text. Gibt Termine zurück, die [rangeStart, rangeEnd) berühren.
function occurrences(master, ruleText, rangeStart, rangeEnd, excluded = []) {
  const start = new Date(master.start);
  const end = new Date(master.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const rule = parseRule(ruleText);
  const duration = Math.max(0, end - start);
  const dayShift = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()) - new Date(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
  const endOf = (s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + dayShift, end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds());
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  const until = parseUntil(rule.UNTIL);
  const skip = new Set(excluded.map((x) => Math.round(new Date(x).getTime() / 60000)));
  const out = [];
  let n = 0;
  eachStart(start, rule, (s) => {
    n += 1;
    if (n > count || (until && s > until) || s >= rangeEnd) return false;
    const e = endOf(s);
    const touches = e > rangeStart || (duration === 0 && s >= rangeStart);
    if (touches && !skip.has(Math.round(s.getTime() / 60000))) out.push({ start: s, end: e });
    return true;
  });
  return out;
}

module.exports = { occurrences, parseRule, parseUntil, nthWeekday };
