// Instant updates: /api/data/wait answers the moment another device saves (and gives the unchanged version after the wait).
process.env.AUTH_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';
process.env.WAIT_MAX_MS = '1500';
process.env.WAIT_POLL_MS = '5000';   // database re-check is slow on purpose: only the in-process save signal can wake the waiting request in time
const app = require('../src/app');
let srv, base, tok;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const backup = n => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [], n } } });

test('wait needs a token', async () => { expect((await call('GET', '/api/data/wait?since=0')).s).toBe(401); });

test('wait returns at once when already behind, and as soon as another device saves', async () => {
  tok = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  const v1 = (await call('PUT', '/api/data', { data: backup(1), baseVersion: 0 }, tok)).j.version;
  let t = Date.now();
  expect((await call('GET', '/api/data/wait?since=0', null, tok)).j.version).toBe(v1);
  expect(Date.now() - t).toBeLessThan(500);
  // a save 300ms into the wait wakes it long before the 1.5s limit
  t = Date.now();
  const waiting = call('GET', '/api/data/wait?since=' + v1, null, tok);
  setTimeout(() => call('PUT', '/api/data', { data: backup(2), baseVersion: v1 }, tok), 300);   // woken by the save itself
  const r = await waiting;
  expect(r.j.version).toBe(v1 + 1);
  expect(Date.now() - t).toBeLessThan(1200);
});

test('nothing new: answers after the wait with the unchanged version', async () => {
  const cur = (await call('GET', '/api/data/version', null, tok)).j.version;
  const t = Date.now();
  expect((await call('GET', '/api/data/wait?since=' + cur, null, tok)).j.version).toBe(cur);
  expect(Date.now() - t).toBeGreaterThanOrEqual(1400);
});
