// Sperrseite: kennt nur „Entsperren“. Alle anderen Abfragen verweigert die Zentrale, solange sie gesperrt ist.
const msg = document.getElementById('msg');
async function unlock(method) {
  msg.textContent = '';
  const r = await window.zentrale.appUnlock(method);
  if (r && !r.ok && !r.cancelled) msg.textContent = r.error || 'Entsperren hat nicht geklappt.';
}
document.getElementById('touch').addEventListener('click', () => unlock('touchid'));
document.getElementById('pw').addEventListener('click', () => unlock('password'));
