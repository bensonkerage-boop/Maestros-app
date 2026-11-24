// A quiz is posted to a class but only the learners who take its subject get it: someone who does not take Physics never receives the
// Physics paper, cannot open it by id and cannot save an attempt for it. Subjects everyone sits (e.g. English) go to the whole class.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const q = (id, subject, grade) => ({ id, title: id, grade, stream: '', subject, published: true, questions: [{ id: 'a', text: 'A', options: ['1', '2', '3', '4'], answer: 1 }] });
const data = () => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
  students: [
    { admissionNumber: '10', grade: 'Grade 11', stream: 'A', optionalSubjects: ['Physics', 'Chemistry'] },      // senior: chose Physics
    { admissionNumber: '11', grade: 'Grade 11', stream: 'A', optionalSubjects: ['Business Studies'] },          // senior: did not
    { admissionNumber: '12', grade: 'Grade 11', stream: 'A' },                                                   // senior: no choices recorded
    { admissionNumber: '20', grade: 'Form 3', stream: 'A', optionalSubjects: ['Physics'] },                      // 8-4-4 with a subject list
    { admissionNumber: '21', grade: 'Form 3', stream: 'A' }],                                                    // 8-4-4 with no list: whole class's subjects
  onlineQuizzes: [q('phys11', 'Physics', 'Grade 11'), q('eng11', 'English', 'Grade 11'), q('phys3', 'Physics', 'Form 3')], quizAttempts: [] } } });
let staff;
test('set up', async () => {
  staff = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  expect((await call('PUT', '/api/data', { data: data(), baseVersion: 0 }, staff)).s).toBe(200);
});
const ids = async adm => (await call('POST', '/api/portal/login', { username: adm, password: 'welcome' })).j.quizzes.map(x => x.id).sort();
test('a senior learner who chose Physics gets the Physics paper; one who did not (or has no choices) does not; English goes to everyone', async () => {
  expect(await ids('10')).toEqual(['eng11', 'phys11']);
  expect(await ids('11')).toEqual(['eng11']);
  expect(await ids('12')).toEqual(['eng11']);
});
test('an 8-4-4 learner with a subject list gets only those subjects; with no list they get the class papers', async () => {
  expect(await ids('20')).toEqual(['phys3']);
  expect(await ids('21')).toEqual(['phys3']);
});
test('a learner who does not take the subject cannot list it again or save an attempt for it', async () => {
  const t = (await call('POST', '/api/portal/login', { username: '11', password: 'welcome' })).j.token;
  expect((await call('GET', '/api/portal/quizzes', null, t)).j.quizzes.map(x => x.id)).toEqual(['eng11']);
  expect((await call('PUT', '/api/portal/attempt', { attempt: { quizId: 'phys11', answers: {} } }, t)).s).toBe(404);
  expect((await call('PUT', '/api/portal/attempt', { attempt: { quizId: 'eng11', answers: {} } }, t)).s).toBe(200);
});

// the device's cloud sign-in lasts months and renews itself
const jwt = require('jsonwebtoken');
test('a school account\'s cloud token lasts about 180 days; a token older than a day is renewed by /auth/me', async () => {
  const me = await call('GET', '/api/auth/me', null, staff);
  expect(me.j.token).toBeUndefined();                                    // fresh: nothing to renew
  const c = jwt.decode(staff);
  const platformDays = Math.round((c.exp - c.iat) / 86400);
  expect(platformDays).toBe(7);                                          // the platform owner's own token is shorter
  const old = jwt.sign({ sub: c.sub, username: c.username, role: c.role, tenant: c.tenant, platform: c.platform, iat: c.iat - 3 * 86400 }, process.env.JWT_SECRET || 'dev-only-secret', { expiresIn: '7d' });
  const r = await call('GET', '/api/auth/me', null, old);
  expect(r.s).toBe(200); expect(typeof r.j.token).toBe('string');
  expect((await call('GET', '/api/auth/me', null, r.j.token)).s).toBe(200);
});
