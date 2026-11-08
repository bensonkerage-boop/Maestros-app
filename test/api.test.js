process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv, base;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const backup = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [] } } };
let admin;

describe('auth', () => {
  test('health is public, data needs a token', async () => {
    expect((await call('GET', '/api/health')).s).toBe(200);
    expect((await call('GET', '/api/data')).s).toBe(401);
    expect((await call('GET', '/api/data', null, 'garbage')).s).toBe(401);
  });
  test('setup is needed until the first account exists', async () => {
    expect((await call('GET', '/api/auth/status')).j.needsSetup).toBe(true);
  });
  test('rejects weak credentials', async () => {
    expect((await call('POST', '/api/auth/register', { username: 'a', password: 'short' })).s).toBe(400);
    expect((await call('POST', '/api/auth/register', {})).s).toBe(400);
  });
  test('first account becomes admin', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'Admin', password: 'password123' });
    expect(r.s).toBe(201); expect(r.j.user).toEqual({ username: 'admin', role: 'admin' });
    admin = r.j.token;
    expect((await call('GET', '/api/auth/status')).j.needsSetup).toBe(false);
  });
  test('registration is closed to anonymous users after setup', async () => {
    expect((await call('POST', '/api/auth/register', { username: 'intruder', password: 'password123' })).s).toBe(401);
  });
  test('admin can add staff; staff cannot add users', async () => {
    const st = await call('POST', '/api/auth/register', { username: 'teacher1', password: 'password123' }, admin);
    expect(st.s).toBe(201); expect(st.j.user.role).toBe('staff');
    expect((await call('POST', '/api/auth/register', { username: 'teacher2', password: 'password123' }, st.j.token)).s).toBe(403);
    expect((await call('POST', '/api/auth/register', { username: 'TEACHER1', password: 'password123' }, admin)).s).toBe(409);
  });
  test('login is case-insensitive on username and rejects wrong passwords', async () => {
    expect((await call('POST', '/api/auth/login', { username: 'ADMIN', password: 'password123' })).j.token).toBeTruthy();
    expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).s).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'ghost', password: 'password123' })).s).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: { $ne: '' }, password: 'x' })).s).toBe(401);
  });
  test('/me returns the signed-in user', async () => {
    expect((await call('GET', '/api/auth/me', null, admin)).j).toEqual({ username: 'admin', role: 'admin' });
  });
});

describe('data', () => {
  test('starts empty', async () => {
    expect((await call('GET', '/api/data', null, admin)).j).toEqual({ version: 0, data: null });
  });
  test('validates the body', async () => {
    expect((await call('PUT', '/api/data', { data: { nope: 1 }, baseVersion: 0 }, admin)).s).toBe(400);
    expect((await call('PUT', '/api/data', { data: [], baseVersion: 0 }, admin)).s).toBe(400);
  });
  test('saves, versions and round-trips', async () => {
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 0 }, admin)).j.version).toBe(1);
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 1 }, admin)).j.version).toBe(2);
    const g = await call('GET', '/api/data', null, admin);
    expect(g.j.version).toBe(2); expect(g.j.data).toEqual(backup); expect(g.j.updatedBy).toBe('admin');
  });
  test('stale saves are refused with 409', async () => {
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 0 }, admin)).s).toBe(409);
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 1 }, admin)).s).toBe(409);
  });
  test('oversized and malformed bodies get clean errors', async () => {
    const big = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin }, body: JSON.stringify({ data: { ...backup, pad: 'x'.repeat(5 * 1024 * 1024) }, baseVersion: 2 }) });
    expect(big.status).toBe(413);
    const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
  });
  test('unknown API routes return JSON 404', async () => {
    const r = await call('GET', '/api/nothing'); expect(r.s).toBe(404); expect(r.j.error).toBeDefined();
  });
});
