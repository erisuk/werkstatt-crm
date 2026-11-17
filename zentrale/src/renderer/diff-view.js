// „Änderungen ansehen“ wie in der Claude-App: nicht committete Dateien in der Info-Leiste, Klick zeigt den Diff.
// Nutzt die Helfer aus app.js (h, fill, ui, api, keepFocus …).
const DIFF_MS = 20 * 1000;
const DIFF_LINES = 4000;
const DIFF_ICON = { neu: '+', 'gelöscht': '−', umbenannt: '→', 'geändert': '•' };

function loadChatDiff(cwd, force) {
  if (!force && ui.chatDiff && ui.chatDiff.cwd === cwd && Date.now() - ui.chatDiffAt < DIFF_MS) return;
  if (ui.chatDiffLoading === cwd) return;
  ui.chatDiffLoading = cwd;
  api.chatDiff(cwd).then((res) => {
    ui.chatDiff = { cwd, ...(res || { git: false }) };
    ui.chatDiffAt = Date.now();
  }).catch(() => {}).finally(() => { ui.chatDiffLoading = null; renderChatInfo(); });
}

function diffCount(f) {
  if (f.plus === null && f.minus === null) return f.status;
  return [f.plus ? `+${f.plus}` : null, f.minus ? `−${f.minus}` : null].filter(Boolean).join(' ') || f.status;
}

// Zeilen für die Info-Leiste (unter „Änderungen“).
function diffRows(c) {
  loadChatDiff(c.cwd, false);
  const d = ui.chatDiff && ui.chatDiff.cwd === c.cwd ? ui.chatDiff : null;
  if (!d || !d.git || !d.files || !d.files.length) return [];
  const plus = d.files.reduce((n, f) => n + (f.plus || 0), 0);
  const minus = d.files.reduce((n, f) => n + (f.minus || 0), 0);
  return [
    h('div', { class: 'diff-head', text: `Nicht committet · ${d.files.length + (d.more || 0)} Datei${d.files.length === 1 ? '' : 'en'} · +${plus} −${minus}` }),
    ...d.files.slice(0, 8).map((f) => (f.ordner
      ? infoRow('▸', `${f.path.replace(/\/$/, '').split('/').pop()}/`, { title: `${f.path}\nNeuer Ordner (noch nicht im Projekt)`, right: 'Ordner', rightClass: 'diff-num' })
      : infoRow(DIFF_ICON[f.status] || '•', f.path.split('/').pop(),
        { title: `${f.path}\n${f.status} – klicken für die Änderungen`, right: diffCount(f), rightClass: 'diff-num', onClick: () => openDiff(c.cwd, f.path) }))),
    d.files.length > 8 ? h('p', { class: 'info-note', text: `… und ${d.files.length - 8 + (d.more || 0)} weitere` }) : null,
  ].filter(Boolean);
}

async function openDiff(cwd, file) {
  const res = await api.chatDiff(cwd, file);
  if (!res || !res.ok) { alert((res && res.error) || 'Die Änderungen ließen sich nicht laden.'); return; }
  const { path: p, diff, cut, binary } = res.data;
  const lines = String(diff).split('\n').slice(0, DIFF_LINES);
  const cls = (l) => (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(l) ? 'd-meta'
    : l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : '');
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (opener) opener.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const opener = document.activeElement;
  const closeBtn = h('button', { class: 'btn ghost', onClick: close }, 'Schließen');
  const overlay = h('div', { class: 'diff-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Änderungen in ${p}`,
    onClick: (e) => { if (e.target === overlay) close(); } },
  h('div', { class: 'diff-panel' },
    h('div', { class: 'diff-top' }, h('span', { class: 'diff-title', text: p }), closeBtn),
    binary ? h('p', { class: 'info-empty', text: 'Binärdatei – kein Text-Vergleich möglich.' })
      : h('pre', { class: 'diff-code', tabindex: '0' }, lines.map((l) => h('span', { class: `d-line ${cls(l)}`, text: `${l}\n` }))),
    cut || String(diff).split('\n').length > DIFF_LINES ? h('p', { class: 'info-note', text: 'Gekürzt – sehr große Änderung.' }) : null));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  closeBtn.focus();
}
