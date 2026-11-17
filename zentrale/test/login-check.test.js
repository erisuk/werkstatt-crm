// Login-Stand der Web-Tabs: nur ob das Login-Cookie da ist – und „abgemeldet“ nur, wo das sicher stimmt.
const test = require('node:test');
const assert = require('node:assert');
const { loginState, cookieDomain } = require('../src/login-check');
const k = require('../src/konten');

test('Login-Stand: Cookie da = angemeldet, fehlt bei sicheren Seiten = abgemeldet, sonst unbekannt', () => {
  assert.strictEqual(loginState('https://www.instagram.com/', [{ name: 'csrftoken' }, { name: 'sessionid' }]), 'angemeldet');
  assert.strictEqual(loginState('https://www.instagram.com/', [{ name: 'csrftoken' }]), 'abgemeldet');
  assert.strictEqual(loginState('https://business.facebook.com/', [{ name: 'c_user' }]), 'angemeldet');
  assert.strictEqual(loginState('https://www.amazon.de/', [{ name: 'session-id' }]), 'unbekannt', 'Amazon: fehlend heißt nicht sicher abgemeldet');
  assert.strictEqual(loginState('https://www.amazon.de/', [{ name: 'at-acbde' }]), 'angemeldet');
  assert.strictEqual(loginState('https://higgsfield.ai/', [{ name: 'egal' }]), 'unbekannt', 'unbekannte Seite');
  assert.strictEqual(loginState('kein link', []), 'unbekannt');
  assert.strictEqual(cookieDomain('https://business.facebook.com/x'), 'facebook.com');
  assert.strictEqual(cookieDomain('https://www.amazon.de/'), 'amazon.de');
});

test('Konten: Web-Tab zeigt den echten Stand aus dem Login-Cookie', () => {
  const list = k.collect({ tabs: [
    { id: 'a', name: 'Bit · Instagram', url: 'https://www.instagram.com/', profile: 'bit', title: '', login: 'angemeldet' },
    { id: 'b', name: 'facebook.com', url: 'https://www.facebook.com/', profile: 'standard', title: '', login: 'abgemeldet' },
    { id: 'c', name: 'Shopify', url: 'https://admin.shopify.com/', profile: 'standard', title: '', login: 'unbekannt' },
  ] });
  assert.deepStrictEqual(list.map((x) => x.stand), ['angemeldet', 'anmelden', 'unbekannt']);
});
