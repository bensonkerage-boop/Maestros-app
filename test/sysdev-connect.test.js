process.env.NODE_ENV = 'test';
process.env.SYSDEV_USERNAME = 'Oimeke';
process.env.SYSDEV_PASSWORD_HASH = require('bcryptjs').hashSync('Aiden@2023', 4);
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};

test('wrong or missing details never connect', async () => {
  expect((await call('POST', '/api/sysdev/connect', {})).s).toBe(400);
  expect((await call('POST', '/api/sysdev/connect', { username: 'Oimeke', password: 'nope' })).s).toBe(401);
  expect((await call('POST', '/api/sysdev/connect', { username: 'someone', password: 'Aiden@2023' })).s).toBe(401);
});
test('the configured System Developer details give a platform token with no cloud account typed', async () => {
  const r = await call('POST', '/api/sysdev/connect', { username: 'Oimeke', password: 'Aiden@2023' });
  expect(r.s).toBe(200);
  expect(r.j.user).toMatchObject({ username: 'oimeke', platform: true });
  const me = await call('GET', '/api/auth/me', null, r.j.token);
  expect(me.s).toBe(200); expect(me.j.platform).toBe(true);
  expect((await call('POST', '/api/sysdev/connect', { username: 'oimeke', password: 'Aiden@2023' })).s).toBe(200);   // repeat links reuse the account
});
