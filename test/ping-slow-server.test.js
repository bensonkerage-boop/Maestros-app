/** @jest-environment jsdom */
// A server that is slow to wake (cold start) must not read as "No internet connection": one failed/timed-out answer is retried once.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'online-login.js'), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function load(fetchImpl) {
  jest.useFakeTimers(); localStorage.clear();
  window.MASMS_CLOUD = { signedIn: () => false }; window.MASMS_API_BASE = 'https://x.test';
  window.fetch = jest.fn(fetchImpl);
  window.eval(src);
  return window.MASMS_ONLINE_LOGIN.ping;
}
afterEach(() => { jest.useRealTimers(); });
const okJson = j => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(j) });

test('first request fails (cold server), the retry succeeds: online', async () => {
  let n = 0; const ping = load(() => (++n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : okJson({ needsSetup: false })));
  const p = ping(); await jest.advanceTimersByTimeAsync(1000); await flush();
  expect(await p).toBe('ok'); expect(n).toBe(2);
});
test('a 503 from a waking server is retried too', async () => {
  let n = 0; const ping = load(() => (++n === 1 ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }) : okJson({ needsSetup: false })));
  const p = ping(); await jest.advanceTimersByTimeAsync(1000); await flush();
  expect(await p).toBe('ok');
});
test('really offline: still reported offline after the single retry', async () => {
  let n = 0; const ping = load(() => { n++; return Promise.reject(new TypeError('Failed to fetch')); });
  const p = ping(); await jest.advanceTimersByTimeAsync(1000); await flush();
  expect(await p).toBe('offline'); expect(n).toBe(2);
});
test('an HTML page answering 200 is not the server and is not retried', async () => {
  let n = 0; const ping = load(() => { n++; return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('<')) }); });
  expect(await ping()).toBe('offline'); expect(n).toBe(1);
});
