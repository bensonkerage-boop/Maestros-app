// School lifecycle on the server: only schools registered in the System Developer dashboard exist and can be signed in to;
// Inactive keeps the data but blocks sign-in; deleting a school in the dashboard removes it from the server.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.STAFF_LOGIN_RATE_LIMIT = '1000'; process.env.PORTAL_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
process.env.ORPHAN_GRACE_HOURS = '0';   // removal of a school that is missing from the registry is immediate in this test
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const login = u => call('POST', '/api/auth/login', { username: u, password: 'password123' });
const setRegistry = (list) => call('PUT', '/api/directory', { data: { schools: [], schoolData: {}, platform: { sdSchools: list } } }, owner);
const mk = (name, u) => call('POST', '/api/schools', { name, adminUsername: u, adminPassword: 'password123' }, owner);
let owner, rows;
const list = async () => { const r = await call('GET', '/api/schools', null, owner); rows = n => r.j.schools.find(x => x.name === n); return r; };

test('setup: the System Developer registers two schools', async () => {
  owner = (await call('POST', '/api/auth/register', { username: 'lifeowner', password: 'password123' })).j.token;
  expect((await setRegistry([{ name: 'Life A', status: 'Active' }, { name: 'Life B', status: 'Active' }])).s).toBe(200);
  expect((await mk('Life A', 'lifea')).s).toBe(201);
  expect((await mk('Life B', 'lifeb')).s).toBe(201);
  expect((await login('lifea')).s).toBe(200);
});
test('a school that is not registered cannot be added to the server', async () => {
  expect((await mk('Never Registered', 'nevadmin')).s).toBe(409);
  const noRec = await call('POST', '/api/schools/link', { name: 'Never Registered', seed: {} }, owner);
  expect(noRec.s).toBe(400);
  await list(); expect(rows('Never Registered')).toBeUndefined();
});
test('Inactive keeps the data on the server but nobody can sign in; Active again lets them in', async () => {
  const t = (await login('lifea')).j.token;
  await setRegistry([{ name: 'Life A', status: 'Inactive' }, { name: 'Life B', status: 'Active' }]);
  const r = await login('lifea'); expect(r.s).toBe(403); expect(r.j.error).toMatch(/Inactive/);
  expect((await call('GET', '/api/data', null, t)).s).toBe(403);                                  // a token it already had stops too
  expect((await call('POST', '/api/staff/login', { username: 'x@lifea', password: 'nope' })).s).toBe(401);
  await list(); expect(rows('Life A')).toMatchObject({ status: 'Inactive', users: 1 });           // still on the server, with its user
  await setRegistry([{ name: 'Life A', status: 'Active' }, { name: 'Life B', status: 'Active' }]);
  expect((await login('lifea')).s).toBe(200);
});
test('a school that is renamed in the dashboard keeps its server space (matched by cloudCode)', async () => {
  await setRegistry([{ name: 'Life A', status: 'Active' }, { name: 'Life B New Name', status: 'Active', cloudCode: 'life-b' }]);
  await list(); expect(rows('Life B')).toMatchObject({ registered: true, status: 'Active' });
  expect((await login('lifeb')).s).toBe(200);
});
test('a school that is missing from the registry is removed from the server', async () => {
  const l = await call('POST', '/api/schools/link', { name: 'Orphan Co', seed: { sdRecord: { name: 'Orphan Co' } } }, owner);
  expect(l.s).toBe(201);
  await list(); expect(rows('Orphan Co')).toBeUndefined();                                         // not in the registry: gone
  expect(rows('Life A')).toBeTruthy(); expect(rows('Life B')).toBeTruthy();                        // registered ones untouched
});
test('deleting a school in the dashboard removes it from the server (users, tokens, data)', async () => {
  const t = (await login('lifea')).j.token;
  expect((await call('DELETE', '/api/schools/life-a', null, owner)).s).toBe(409);                  // still registered: the plain button refuses
  expect((await call('DELETE', '/api/schools/life-a?removed=1', null, t)).s).toBe(403);            // only the platform owner
  const d = await call('DELETE', '/api/schools/life-a?removed=1', null, owner);
  expect(d.s).toBe(200); expect(d.j.deleted).toMatchObject({ code: 'life-a', users: 1 });
  expect((await login('lifea')).s).toBe(401);
  expect((await call('GET', '/api/data', null, t)).s).toBe(401);
  await list(); expect(rows('Life A')).toBeUndefined();
  expect((await call('DELETE', '/api/schools/default?removed=1', null, owner)).s).toBe(400);       // the owner's own space is never deleted
});
test('deleting the last registered school works even though the registry is now empty', async () => {
  await setRegistry([]);
  expect((await call('DELETE', '/api/schools/life-b?removed=1', null, owner)).s).toBe(200);
  expect((await login('lifeb')).s).toBe(401);
});
