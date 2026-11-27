process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const T = { '2027': { 'Term 1': { start: '2027-01-05', end: '2027-04-02' }, 'Term 2': { start: '2027-04-26', end: '2027-08-06' } } };
test('only the platform owner sets the term calendar; any signed-in school user reads it', async () => {
  const owner = (await call('POST', '/api/auth/register', { username: 'owner1', password: 'password123' })).j.token;
  const staff = (await call('POST', '/api/auth/register', { username: 'teacher1', password: 'password123' }, owner));
  expect(staff.s).toBe(201);
  const stTok = (await call('POST', '/api/auth/login', { username: 'teacher1', password: 'password123' })).j.token;
  expect((await call('GET', '/api/platform/terms')).s).toBe(401);
  expect((await call('PUT', '/api/platform/terms', { termDates: T }, stTok)).s).toBe(403);
  expect((await call('PUT', '/api/platform/terms', { termDates: { '2027': { 'Term 1': { start: '2027-05-01', end: '2027-04-01' } } } }, owner)).s).toBe(400);
  expect((await call('PUT', '/api/platform/terms', { termDates: T }, owner)).s).toBe(200);
  const got = await call('GET', '/api/platform/terms', null, stTok);
  expect(got.s).toBe(200); expect(got.j.termDates).toEqual(T);
});
