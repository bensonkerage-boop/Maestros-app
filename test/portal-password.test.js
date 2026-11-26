// Learner / parent sign in with the DEFAULT password (learner: "welcome", parent: admission number), are told to choose their own
// (mustChange), and from then on only the new password works. The app shows the same "Choose your own password" card teachers see.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const fs = require('fs'), path = require('path');
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const login = (u, p) => call('POST', '/api/portal/login', { username: u, password: p });
test('set up a school', async () => {
  const r = await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' });
  const data = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [{ admissionNumber: '100', firstName: 'Amina', surname: 'Wanjiru', grade: 'Grade 7', guardianPhones: ['0712 345 678'] }], onlineQuizzes: [], quizAttempts: [] } } };
  expect((await call('PUT', '/api/data', { data, baseVersion: 0 }, r.j.token)).s).toBe(200);
});
test('learner: default password asks for a new one; weak passwords are refused; the new one replaces the default', async () => {
  const a = await login('100', 'welcome');
  expect(a.s).toBe(200); expect(a.j).toMatchObject({ mustChange: true, who: 'learner' });
  expect(JSON.stringify(a.j)).not.toMatch(/"pw"|parentPw/);                        // hashes never reach the phone
  for (const weak of ['short1', 'onlyletters', 'Welcome', 'amina']) expect((await call('POST', '/api/portal/password', { newPassword: weak }, a.j.token)).s).toBe(400);
  expect((await call('POST', '/api/portal/password', { newPassword: 'Maths2026' }, a.j.token)).s).toBe(200);
  expect((await login('100', 'welcome')).s).toBe(401);                             // default no longer works
  const b = await login('100', 'Maths2026');
  expect(b.s).toBe(200); expect(b.j.mustChange).toBe(false);
});
test('parent: guardian phone + admission number asks for a new password, separate from the learner\'s', async () => {
  const a = await login('0712345678', '100');
  expect(a.s).toBe(200); expect(a.j).toMatchObject({ mustChange: true, who: 'parent' });
  expect((await call('POST', '/api/portal/password', { newPassword: '0712345678' }, a.j.token)).s).toBe(400);
  expect((await call('POST', '/api/portal/password', { newPassword: 'Family2026' }, a.j.token)).s).toBe(200);
  expect((await login('0712345678', '100')).s).toBe(401);
  expect((await login('0712345678', 'Family2026')).j.mustChange).toBe(false);
  expect((await login('100', 'Maths2026')).s).toBe(200);                           // learner's own password untouched
});
test('the app shows the teacher\'s card to learners/parents, the sign-in card is the original one, and the Android app skips the landing page', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
  expect(app).toMatch(/portalForcePassword\(r\.data\.student, r\.data\.who/);
  expect(app).toContain('openForcedPasswordChange(user, loginName, { portal:true, onSave })');
  expect(app).toContain('Maestro Advanced School<br>Management System');
  expect(app).not.toMatch(/login-cert-role|Portal Sign In|LOGIN_ROLES/);
});
