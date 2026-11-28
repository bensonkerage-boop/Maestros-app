// Client side of the sales agent sign-in (scripts/agent-session.js) and its wiring in the app.
const fs = require('fs'), path = require('path'), vm = require('vm');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
function box(responses) {
  const calls = [];
  const ctx = { calls, window: {}, saAgents: [], sdSchools: [], sdAccountInfo: {}, sdInvoiceNextNo: 1001, sdReceiptNextNo: 100001, sdNextId: 11, alert() {}, location: { reload() {} }, setTimeout, JSON,
    fetch: async (url, o) => { calls.push({ url, method: o.method, body: o.body && JSON.parse(o.body), auth: (o.headers || {}).Authorization }); const r = responses.shift() || { status: 200, body: {} }; return { status: r.status, ok: r.status < 400, json: async () => r.body }; } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(rd('scripts', 'agent-session.js'), ctx);
  return ctx;
}
test('login loads only the agent and their schools into memory and switches saving to the phone off', async () => {
  const c = box([{ status: 200, body: { token: 'T', agent: { id: 7, name: 'Peter Mwangi', phone: '0712345678', status: 'Active' }, schools: [{ id: 1, name: 'A', agentId: 7 }, { id: 5000001, name: 'P', agentId: 7, pending: true }], sdInvoiceNextNo: 2000, sdNextId: 1000010 } }]);
  const r = await c.MASMS_AGENT.login('petermwangi@maestro', 'welcome');
  expect(r.ok).toBe(true);
  expect(c.saAgents).toEqual([expect.objectContaining({ id: 7 })]); expect(c.sdSchools.map(s => s.name)).toEqual(['A', 'P']);
  expect(c.sdInvoiceNextNo).toBe(2000); expect(c.sdNextId).toBe(1000010);
  expect(c.window.MASMS_NO_PERSIST).toBe(true); expect(c.calls[0].url).toBe('/api/agent/login');
});
test('wrong details change nothing', async () => {
  const c = box([{ status: 401, body: { error: 'Incorrect username or password.' } }]);
  expect(await c.MASMS_AGENT.login('x', 'y')).toMatchObject({ ok: false, status: 401 });
  expect(c.saAgents).toEqual([]); expect(c.window.MASMS_NO_PERSIST).toBeUndefined();
});
test('a school change is sent as an edit of a registry school or as a new request; password goes with the token', async () => {
  const c = box([{ status: 200, body: { token: 'T', agent: { id: 7 }, schools: [{ id: 1, name: 'A', agentId: 7 }] } }]);
  await c.MASMS_AGENT.login('a', 'b');
  await c.MASMS_AGENT.pushSchool({ id: 1, name: 'A' }, false);
  await c.MASMS_AGENT.pushSchool({ id: 1000011, name: 'New' }, true);
  await c.MASMS_AGENT.savePassword('Sales2026pw');
  const [, e, n, p] = c.calls;
  expect(e).toMatchObject({ url: '/api/agent/schools', auth: 'Bearer T', body: { schoolId: 1 } });
  expect(n.body).toMatchObject({ clientId: 1000011 }); expect(n.body.schoolId).toBeUndefined();
  expect(p).toMatchObject({ url: '/api/agent/password', body: { newPassword: 'Sales2026pw' } });
});
test('wiring: sign-in gate, password, school save, reset and build', () => {
  expect(rd('scripts', 'online-login.js')).toMatch(/MASMS_AGENT\.login/);
  const src = rd('source', 'MAESTRO_MASMS_FINAL.html');
  expect(src).toMatch(/MASMS_AGENT\.savePassword\(pw\)/); expect(src).toMatch(/MASMS_AGENT\.pushSchool\(/); expect(src).toMatch(/'\/agent\/override\/'/);
  expect(rd('scripts', 'build.js')).toMatch(/agent-session\.js/);
  expect(rd('scripts', 'cloud-sync.js')).toMatch(/saAgents:slimList/); expect(rd('scripts', 'cloud-sync.js')).toMatch(/\/agent\/changes/);
});
