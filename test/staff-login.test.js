// Registered schools are linked to the cloud automatically (their own private space), and their staff sign in on any device with no
// cloud sign-in: the server finds the school that holds the typed details and returns a token for THAT school only.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.STAFF_LOGIN_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
const { pwHash } = require('../src/recover');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const salt = 'abc123', mine = { s: salt, h: pwHash(salt, 'Rainy2days') };
const seedFor = (name, phone, extra = {}) => ({
  schoolProfile: { name }, sdRecord: { id: 1, name, level: 'Senior', mobile: phone, status: 'Active' },
  schoolData: { students: [{ admissionNumber: '1', firstName: 'Zed' }],
    teachersList: [{ firstName: 'Jane', surname: 'Kamau', phone, responsibility: 'Principal' }, { firstName: 'Peter', surname: 'Otieno', phone: '0722 000 333' }],
    systemUsers: [{ name: 'Jane Kamau', role: 'Super Admin', status: 'Active', phone, mustChange: true },
      { name: 'Mary Achieng', role: 'Teacher', status: 'Active', phone: '0733 111 222', pw: mine }, { name: 'Gone Person', role: 'Teacher', status: 'Inactive', phone: '0744 555 666', mustChange: true }], ...extra } });
let owner;
test('the System Developer links two registered schools; linking again changes nothing', async () => {
  owner = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  const a = await call('POST', '/api/schools/link', { name: 'Alpha Senior School', seed: seedFor('Alpha Senior School', '0712 345 678') }, owner);
  const b = await call('POST', '/api/schools/link', { name: 'Beta Academy', seed: seedFor('Beta Academy', '0799 888 777', { teachersList: [{ firstName: 'Beta', surname: 'Head', phone: '0799 888 777' }], systemUsers: [{ name: 'Beta Head', role: 'Super Admin', status: 'Active', phone: '0799 888 777', mustChange: true }] }) }, owner);
  expect(a.s).toBe(201); expect(b.s).toBe(201); expect(a.j.code).not.toBe(b.j.code);
  const again = await call('POST', '/api/schools/link', { name: 'Alpha Senior School', seed: {} }, owner);
  expect(again.j).toEqual({ code: a.j.code, created: false });
  expect((await call('GET', '/api/schools', null, owner)).j.schools.map(x => x.name)).toEqual(expect.arrayContaining(['Alpha Senior School', 'Beta Academy']));
});
test('only the platform owner can link a school', async () => {
  expect((await call('POST', '/api/schools/link', { name: 'Sneaky School' })).s).toBe(401);
});
test('the principal signs in by phone number with the welcome password and gets a token for their own school only', async () => {
  const r = await call('POST', '/api/staff/login', { username: '0712 345 678', password: 'welcome' });
  expect(r.s).toBe(200); expect(r.j.user.tenantName).toBe('Alpha Senior School');
  const d = (await call('GET', '/api/data', null, r.j.token)).j.data;
  expect(d.schools).toEqual(['Alpha Senior School']); expect(Object.keys(d.schoolData)).toEqual(['Alpha Senior School']);   // never another school's data
  expect((await call('GET', '/api/schools', null, r.j.token)).s).toBe(403);                                               // and no platform powers
});
test('a staff member with their own password, and the generated user name form (name@school)', async () => {
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'Rainy2days' })).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'welcome' })).s).toBe(401);     // welcome stops working once they choose a password
  expect((await call('POST', '/api/staff/login', { username: 'maryachieng@alphasenior', password: 'Rainy2days' })).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: 'maryachieng@betasenior', password: 'Rainy2days' })).s).toBe(401);   // wrong school suffix
});
test('a teacher on the Teachers list with no login yet can sign in with the welcome password', async () => {
  expect((await call('POST', '/api/staff/login', { username: '0722 000 333', password: 'welcome' })).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: 'peterotieno@alphasenior', password: 'welcome' })).s).toBe(200);
});
test('wrong details, inactive accounts and empty fields are refused', async () => {
  for (const [u, p, s] of [['0712 345 678', 'wrong', 401], ['0700 000 000', 'welcome', 401], ['0744 555 666', 'welcome', 401], ['', 'welcome', 400], ['0712 345 678', '', 400]])
    expect((await call('POST', '/api/staff/login', { username: u, password: p })).s).toBe(s);
});
test('a suspended school cannot be signed in to, and a device already connected is cut off within seconds', async () => {
  const r = await call('POST', '/api/staff/login', { username: '0799 888 777', password: 'welcome' });
  expect(r.s).toBe(200);
  expect((await call('GET', '/api/data', null, r.j.token)).s).toBe(200);
  const code = r.j.user.tenant;
  expect((await call('PATCH', '/api/schools/' + code, { active: false }, owner)).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0799 888 777', password: 'welcome' })).s).toBe(401);
  expect((await call('GET', '/api/data', null, r.j.token)).s).toBe(403);
});
test('the working copy of a platform owner that holds several schools is never a school\'s cloud space', async () => {
  const many = { schools: ['A', 'B'], currentSchool: 'A', schoolData: { A: seedFor('A', '0701 010 101').schoolData, B: seedFor('B', '0702 020 202').schoolData } };
  expect((await call('PUT', '/api/data', { data: many, baseVersion: 0 }, owner)).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0701 010 101', password: 'welcome' })).s).toBe(401);
});
test('a registered school that never got linked is linked by its first sign-in, from any browser, with nothing to connect', async () => {
  const sd = seedFor('Gamma Junior School', '0755 123 456'), rec = { ...sd.sdRecord, id: 7, level: 'Junior' };
  const many = { schools: ['DEMO SCHOOL', 'Gamma Junior School'], currentSchool: 'DEMO SCHOOL', platform: { sdSchools: [rec, { ...rec, id: 8, name: 'Dormant School', status: 'Inactive' }] },
    schoolProfiles: {}, schoolData: { 'DEMO SCHOOL': seedFor('DEMO SCHOOL', '0701 999 999').schoolData, 'Gamma Junior School': sd.schoolData, 'Dormant School': seedFor('Dormant School', '0766 000 111').schoolData } };
  expect((await call('PUT', '/api/data', { data: many, baseVersion: 1 }, owner)).s).toBe(200);
  const before = (await call('GET', '/api/schools', null, owner)).j.schools.length;
  const r = await call('POST', '/api/staff/login', { username: '0755 123 456', password: 'welcome' });
  expect(r.s).toBe(200); expect(r.j.user.tenantName).toBe('Gamma Junior School');
  const d = (await call('GET', '/api/data', null, r.j.token)).j.data;
  expect(Object.keys(d.schoolData)).toEqual(['Gamma Junior School']);                                          // that school only
  expect((await call('GET', '/api/schools', null, owner)).j.schools.length).toBe(before + 1);
  const again = await call('POST', '/api/staff/login', { username: '0755 123 456', password: 'welcome' });      // second time: the same school, no duplicate
  expect(again.s).toBe(200); expect((await call('GET', '/api/schools', null, owner)).j.schools.length).toBe(before + 1);
  expect((await call('POST', '/api/schools/link', { name: 'Gamma Junior School' })).s).toBe(401);
  expect((await call('POST', '/api/schools/link', { name: 'Gamma Junior School', seed: {} }, owner)).j.created).toBe(false);
  // not in the registry (the built-in demo school) or marked inactive: never linked by a sign-in
  const demo = await call('POST', '/api/staff/login', { username: '0701 999 999', password: 'welcome' });
  expect(demo.s).toBe(403); expect(demo.j.code).toBe('school_not_linked'); expect(demo.j.error).toMatch(/not registered/);
  const dormant = await call('POST', '/api/staff/login', { username: '0766 000 111', password: 'welcome' });
  expect(dormant.s).toBe(403); expect(dormant.j.error).toMatch(/switched off/);
  expect((await call('POST', '/api/staff/login', { username: '0701 999 999', password: 'wrong' })).s).toBe(401);   // wrong details learn nothing
  expect((await call('POST', '/api/staff/login', { username: '0755 123 456', password: 'wrong' })).s).toBe(401);
});
test('a staff token is renewed like any device token', async () => {
  const jwt = require('jsonwebtoken');
  const t = (await call('POST', '/api/staff/login', { username: '0712 345 678', password: 'welcome' })).j.token, c = jwt.decode(t);
  expect(Math.round((c.exp - c.iat) / 86400)).toBe(180); expect(c.staff).toBe(true);
  const old = jwt.sign({ sub: c.sub, username: c.username, role: c.role, tenant: c.tenant, platform: false, staff: true, iat: c.iat - 3 * 86400 }, process.env.JWT_SECRET || 'dev-only-secret', { expiresIn: '180d' });
  const r = await call('GET', '/api/auth/me', null, old);
  expect(r.s).toBe(200); expect(jwt.decode(r.j.token).staff).toBe(true);
});
