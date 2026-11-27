// Schools on the server: only registered + active schools may sign in; a school that is not in the registry can be deleted, a registered one cannot.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.STAFF_LOGIN_RATE_LIMIT = '1000'; process.env.PORTAL_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const mk = (owner, name, u) => call('POST', '/api/schools', { name, adminUsername: u, adminPassword: 'password123' }, owner);
const login = u => call('POST', '/api/auth/login', { username: u, password: 'password123' });
let owner, row, gt;
const list = async () => { const r = await call('GET', '/api/schools', null, owner); row = n => r.j.schools.find(x => x.name === n); return r; };

test('setup: three schools exist on the server', async () => {
  owner = (await call('POST', '/api/auth/register', { username: 'regowner', password: 'password123' })).j.token;
  expect((await mk(owner, 'Reg Academy', 'regadmin')).s).toBe(201);
  expect((await mk(owner, 'Off Academy', 'offadmin')).s).toBe(201);
  expect((await mk(owner, 'Ghost School', 'ghostadmin')).s).toBe(201);
});
test('until the registered list reaches the server nothing is judged against it and nothing can be deleted', async () => {
  await list();
  expect(row('Ghost School').registered).toBeNull(); expect(row('Ghost School').deletable).toBe(false);
  expect((await call('DELETE', '/api/schools/ghost-school', null, owner)).s).toBe(409);
  gt = (await login('ghostadmin')).j.token;
  expect((await login('ghostadmin')).s).toBe(200);
});
test('with the registry on the server: status column, Inactive cannot sign in, Active can', async () => {
  const reg = { schools: [], schoolData: {}, platform: { sdSchools: [{ name: 'Reg Academy', status: 'Active' }, { name: 'Off Academy', status: 'Inactive' }] } };
  expect((await call('PUT', '/api/directory', { data: reg }, owner)).s).toBe(200);
  await list();
  expect(row('Reg Academy')).toMatchObject({ registered: true, status: 'Active', deletable: false });
  expect(row('Off Academy')).toMatchObject({ registered: true, status: 'Inactive', deletable: false });
  expect(row('Ghost School')).toMatchObject({ registered: false, status: 'Inactive', deletable: true });
  expect((await login('regadmin')).s).toBe(200);
  const off = await login('offadmin');
  expect(off.s).toBe(403); expect(off.j.error).toMatch(/Inactive/);
  const ghost = await login('ghostadmin');                                                  // not in the registry: cannot sign in at all
  expect(ghost.s).toBe(403); expect(ghost.j.error).toMatch(/not registered/);
  expect((await call('GET', '/api/data', null, gt)).s).toBe(403);                           // nor can a token it already had
  expect((await call('POST', '/api/staff/login', { username: 'x@ghost', password: 'nope' })).s).toBe(401);
});
test('a token issued before the school went Inactive stops working too', async () => {
  const t = (await login('regadmin')).j.token;
  expect((await call('GET', '/api/data', null, t)).s).toBe(200);
  const reg = { schools: [], schoolData: {}, platform: { sdSchools: [{ name: 'Reg Academy', status: 'Inactive' }, { name: 'Off Academy', status: 'Inactive' }] } };
  await call('PUT', '/api/directory', { data: reg }, owner);
  expect((await call('GET', '/api/data', null, t)).s).toBe(403);
  const back = { schools: [], schoolData: {}, platform: { sdSchools: [{ name: 'Reg Academy', status: 'Active' }, { name: 'Off Academy', status: 'Inactive' }] } };
  await call('PUT', '/api/directory', { data: back }, owner);
  expect((await login('regadmin')).s).toBe(200);
});
test('a suspended school still cannot sign in and shows as Suspended', async () => {
  expect((await call('PATCH', '/api/schools/reg-academy', { active: false }, owner)).s).toBe(200);
  expect((await login('regadmin')).s).toBe(403);
  await list(); expect(row('Reg Academy').status).toBe('Suspended');
  expect((await call('PATCH', '/api/schools/reg-academy', { active: true }, owner)).s).toBe(200);
});
test('delete: only for a school that is not registered, only by the platform owner', async () => {
  expect((await call('DELETE', '/api/schools/ghost-school', null, gt)).s).toBe(403);       // a school admin cannot
  expect((await call('DELETE', '/api/schools/reg-academy', null, owner)).s).toBe(409);      // registered
  expect((await call('DELETE', '/api/schools/off-academy', null, owner)).s).toBe(409);      // registered (even though Inactive)
  expect((await call('DELETE', '/api/schools/default', null, owner)).s).toBe(400);          // the owner's own space
  expect((await call('DELETE', '/api/schools/nope', null, owner)).s).toBe(404);
  const d = await call('DELETE', '/api/schools/ghost-school', null, owner);
  expect(d.s).toBe(200); expect(d.j.deleted).toMatchObject({ code: 'ghost-school', users: 1 });
  await list(); expect(row('Ghost School')).toBeUndefined(); expect(row('Reg Academy')).toBeTruthy();
  expect((await login('ghostadmin')).s).toBe(401);                                           // its users are gone
  expect((await call('GET', '/api/data', null, gt)).s).toBe(401);                            // and so are its tokens
});
test('an owner backup with no registered-schools list never locks other schools out', async () => {
  await call('PUT', '/api/directory', { data: { schools: [], schoolData: {}, platform: { sdSchools: [] } } }, owner);
  const r = await login('regadmin');
  expect(r.s).toBe(200);                                                                    // registry treated as "not set up", nothing judged against it
  await list(); expect(row('Reg Academy').registered).toBeNull(); expect(row('Reg Academy').deletable).toBe(false);
});
