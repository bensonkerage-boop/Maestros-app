// Sign-in must not depend on the school's big data snapshot: a small directory is kept beside it.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.STAFF_LOGIN_RATE_LIMIT = '1000'; process.env.PORTAL_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
const { pwHash } = require('../src/recover');
const { buildDirectory } = require('../src/directory');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const mine = { s: 'abc123', h: pwHash('abc123', 'Rainy2days') };
const school = (extra = {}) => ({ schools: ['Gamma Senior School'], schoolData: { 'Gamma Senior School': {
  students: [{ admissionNumber: '4501', firstName: 'Ann', guardianPhones: ['0711 222 333'], photo: 'x'.repeat(5000) }],
  systemUsers: [{ name: 'Mary Achieng', role: 'Teacher', status: 'Active', phone: '0733 111 222', pw: mine }], teachersList: [], ...extra } },
  platform: { sdSchools: [{ name: 'Gamma Senior School', level: 'Senior', status: 'Active' }] } });
let owner, adminTok, code;
test('setup: a school exists on the server but its big data never uploaded', async () => {
  owner = (await call('POST', '/api/auth/register', { username: 'owner2', password: 'password123' })).j.token;
  const c = await call('POST', '/api/schools', { name: 'Gamma Senior School', adminUsername: 'gammaadmin', adminPassword: 'password123' }, owner);
  expect(c.s).toBe(201); code = c.j.school ? c.j.school.code : c.j.code;
  adminTok = (await call('POST', '/api/auth/login', { username: 'gammaadmin', password: 'password123' })).j.token;
  expect((await call('GET', '/api/data', null, adminTok)).j.data).toBeNull();   // no snapshot
});
test('before any directory exists the details are refused, as before', async () => {
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'Rainy2days' })).s).toBe(401);
  expect((await call('POST', '/api/portal/login', { username: '4501', password: 'welcome' })).s).toBe(401);
});
test('the device sends only the small directory; staff then sign in with no saved data on the server', async () => {
  expect((await call('PUT', '/api/directory', { data: school() }, adminTok)).s).toBe(200);
  expect((await call('GET', '/api/data', null, adminTok)).j.data).toBeNull();   // still no snapshot
  const r = await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'Rainy2days' });
  expect(r.s).toBe(200); expect(r.j.user.tenant).toBe(code); expect(r.j.dataOnServer).toBe(false);
  expect((await call('POST', '/api/staff/login', { username: 'maryachieng@gammasenior', password: 'Rainy2days' })).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'wrong' })).s).toBe(401);
});
test('a learner signs in from the directory (admission number + welcome, or guardian phone + admission number)', async () => {
  const a = await call('POST', '/api/portal/login', { username: '4501', password: 'welcome' });
  expect(a.s).toBe(200); expect(a.j.token).toBeTruthy(); expect(a.j.student.admissionNumber).toBe('4501'); expect(a.j.quizzes).toEqual([]);
  expect(a.j.student.photo).toBeUndefined();
  expect((await call('POST', '/api/portal/login', { username: '0711222333', password: '4501' })).s).toBe(200);
  expect((await call('POST', '/api/portal/login', { username: '4501', password: 'nope' })).s).toBe(401);
});
test('a full save refreshes the directory by itself, so a later change to a password is honoured', async () => {
  const data = school(); data.schoolData['Gamma Senior School'].systemUsers[0].pw = { s: 'zzz', h: pwHash('zzz', 'NewPass99') };
  expect((await call('PUT', '/api/data', { data, baseVersion: 0 }, adminTok)).s).toBe(200);
  const r = await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'NewPass99' });
  expect(r.s).toBe(200); expect(r.j.dataOnServer).toBe(true);
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'Rainy2days' })).s).toBe(401);   // old password no longer works
});
test('a suspended school cannot be signed in to through its directory either', async () => {
  expect((await call('PATCH', '/api/schools/' + code, { active: false }, owner)).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0733 111 222', password: 'NewPass99' })).s).toBe(401);
  expect((await call('POST', '/api/portal/login', { username: '4501', password: 'welcome' })).s).toBe(401);
});
test('the directory is kept per school: another school never sees it', async () => {
  const c = await call('POST', '/api/schools', { name: 'Delta Academy', adminUsername: 'deltaadmin', adminPassword: 'password123' }, owner);
  const t = (await call('POST', '/api/auth/login', { username: 'deltaadmin', password: 'password123' })).j.token;
  expect((await call('PUT', '/api/directory', { data: { schools: ['Delta Academy'], schoolData: { 'Delta Academy': { students: [{ admissionNumber: '7' }] } } } }, t)).s).toBe(200);
  expect((await call('POST', '/api/portal/login', { username: '7', password: 'welcome' })).j.schoolName).toBe('Delta Academy');
  expect(c.s).toBe(201);
});
test('buildDirectory drops photos and long values but keeps what sign-in reads', () => {
  const d = buildDirectory(school()), st = d.schoolData['Gamma Senior School'].students[0];
  expect(st.photo).toBeUndefined(); expect(st.admissionNumber).toBe('4501'); expect(st.guardianPhones).toEqual(['0711 222 333']);
  expect(d.schoolData['Gamma Senior School'].systemUsers[0].pw).toEqual(mine);
  expect(JSON.stringify(d).length).toBeLessThan(JSON.stringify(school()).length);
  expect(buildDirectory(null)).toBeNull(); expect(buildDirectory({ schoolData: [] })).toBeNull();
});
test('the directory endpoint needs a sign-in and a real body', async () => {
  expect((await call('PUT', '/api/directory', { data: school() })).s).toBe(401);
  expect((await call('PUT', '/api/directory', { data: 'nope' }, (await call('POST', '/api/auth/login', { username: 'deltaadmin', password: 'password123' })).j.token)).s).toBe(400);
});
