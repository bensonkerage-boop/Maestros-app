// Sales agents sign in from any phone: the server checks them against the roster and gives an agent-only token.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.STAFF_LOGIN_RATE_LIMIT = '1000'; process.env.PORTAL_RATE_LIMIT = '1000'; process.env.AGENT_LOGIN_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
const { pwHash } = require('../src/recover');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const login = (u, p) => call('POST', '/api/agent/login', { username: u, password: p });
let owner, tok;
const roster = (over = {}) => [
  { id: 7, name: 'Peter Mwangi', phone: '0712345678', status: 'Active', ...over },
  { id: 8, name: 'Jane Atieno', phone: '0722000111', status: 'Inactive' },
  { id: 9, name: 'Dev Eloper', phone: '0733000222', status: 'Active', isDeveloper: true },
];
const put = (agents) => call('PUT', '/api/directory', { data: { schools: [], schoolData: {}, platform: { sdSchools: [{ id: 1, name: 'School One', status: 'Active', agentId: 7 }, { id: 2, name: 'School Two', status: 'Active', agentId: 8 }], saAgents: agents } } }, owner);

test('setup: the System Developer\'s roster reaches the server', async () => {
  owner = (await call('POST', '/api/auth/register', { username: 'agowner', password: 'password123' })).j.token;
  expect((await put(roster())).s).toBe(200);
});
test('an agent signs in by name or phone with the welcome password, from a device with no account', async () => {
  const a = await login('petermwangi@maestro', 'welcome');
  expect(a.s).toBe(200); expect(a.j.token).toBeTruthy(); tok = a.j.token;
  expect(a.j.agent).toMatchObject({ id: 7, name: 'Peter Mwangi' });
  expect(a.j.schools.map(x => x.name)).toEqual(['School One']);                 // only their own schools
  expect(a.j.agent.pw).toBeUndefined();                                          // no password yet: welcome
  expect((await login('0712 345 678', 'WELCOME')).s).toBe(200);
});
test('wrong details, inactive agents and the developer entry cannot sign in', async () => {
  expect((await login('petermwangi@maestro', 'nope')).s).toBe(401);
  expect((await login('janeatieno@maestro', 'welcome')).s).toBe(401);           // Inactive
  expect((await login('0733000222', 'welcome')).s).toBe(401);                   // isDeveloper
  expect((await login('', '')).s).toBe(400);
});
test('an agent token opens only the agent routes', async () => {
  expect((await call('GET', '/api/agent/session', null, tok)).s).toBe(200);
  for (const [m, p] of [['GET', '/api/data'], ['GET', '/api/schools'], ['GET', '/api/auth/me'], ['GET', '/api/agent/changes'], ['GET', '/api/users']]) expect((await call(m, p, null, tok)).s).toBe(m === 'GET' && (p === '/api/schools' || p === '/api/agent/changes') ? 401 : 401);
  expect((await call('GET', '/api/agent/session', null, owner)).s).toBe(401);   // and a platform/staff token is not an agent
});
test('the agent chooses their own password; the welcome password stops working', async () => {
  expect((await call('POST', '/api/agent/password', { newPassword: 'weak' }, tok)).s).toBe(400);
  expect((await call('POST', '/api/agent/password', { newPassword: 'welcome' }, tok)).s).toBe(400);
  expect((await call('POST', '/api/agent/password', { newPassword: 'Sales2026pw' }, tok)).s).toBe(200);
  expect((await login('petermwangi@maestro', 'welcome')).s).toBe(401);
  const ok = await login('petermwangi@maestro', 'Sales2026pw');
  expect(ok.s).toBe(200); expect(ok.j.agent.pw).toMatchObject({ s: expect.any(String), h: expect.any(String) });
  const ch = await call('GET', '/api/agent/changes', null, owner);               // the System Developer's device picks it up
  expect(ch.j.passwords).toEqual([expect.objectContaining({ agentId: 7 })]);
});
test('the password survives once the System Developer\'s copy carries it, and a reset clears it', async () => {
  const pw = (await login('petermwangi@maestro', 'Sales2026pw')).j.agent.pw;
  await put(roster({ pw, mustChange: false }));                                  // owner device synced
  expect((await login('petermwangi@maestro', 'Sales2026pw')).s).toBe(200);
  await put(roster());                                                           // owner resets: back to welcome...
  expect((await login('petermwangi@maestro', 'Sales2026pw')).s).toBe(200);       // ...but the chosen password is still on the server until told
  expect((await call('DELETE', '/api/agent/override/7', null, owner)).s).toBe(200);
  expect((await login('petermwangi@maestro', 'Sales2026pw')).s).toBe(401);
  expect((await login('petermwangi@maestro', 'welcome')).s).toBe(200);
});
test('an agent registers and edits schools: kept as requests for the System Developer\'s device', async () => {
  tok = (await login('petermwangi@maestro', 'welcome')).j.token;
  const rec = { name: 'New Agent School', region: 'Nairobi', county: 'Nairobi', subCounty: 'Westlands', level: 'Senior', enrollment: 300, dor: '2026-01-01', expiry: '2027-01-01', principalName: 'P', mobile: '0700111222', agentId: 99, status: 'Inactive' };
  expect((await call('POST', '/api/agent/schools', { record: rec }, tok)).s).toBe(400);                    // no clientId / schoolId
  expect((await call('POST', '/api/agent/schools', { record: rec, clientId: 5000001 }, tok)).s).toBe(202);
  let ses = (await call('GET', '/api/agent/session', null, tok)).j;
  expect(ses.schools.find(x => x.name === 'New Agent School')).toMatchObject({ pending: true, agentId: 7 });   // agentId is forced to the agent
  let ch = (await call('GET', '/api/agent/changes', null, owner)).j;
  expect(ch.schools).toHaveLength(1); expect(ch.schools[0]).toMatchObject({ op: 'new', agentId: 7 }); expect(ch.schools[0].record.status).toBeUndefined();
  expect((await call('POST', '/api/agent/changes/ack', { applied: [{ key: ch.schools[0].key, agentId: 7, appliedId: 55 }] }, owner)).s).toBe(200);
  expect((await call('GET', '/api/agent/changes', null, owner)).j.schools).toHaveLength(0);
  expect((await call('POST', '/api/agent/schools', { record: { ...rec, enrollment: 350 }, clientId: 5000001 }, tok)).s).toBe(202);   // edit after it was registered
  ch = (await call('GET', '/api/agent/changes', null, owner)).j;
  expect(ch.schools[0]).toMatchObject({ op: 'edit', schoolId: 55, agentId: 7 });
  expect((await call('POST', '/api/agent/schools', { record: rec, schoolId: 2 }, tok)).s).toBe(400);      // School Two belongs to another agent
  expect((await call('POST', '/api/agent/schools', { record: rec, schoolId: 1 }, tok)).s).toBe(202);      // School One is theirs
});
test('an agent made Inactive is cut off at once', async () => {
  expect((await call('GET', '/api/agent/session', null, tok)).s).toBe(200);
  await put(roster({ status: 'Inactive' }));
  expect((await call('GET', '/api/agent/session', null, tok)).s).toBe(401);
  expect((await login('petermwangi@maestro', 'welcome')).s).toBe(401);
});
