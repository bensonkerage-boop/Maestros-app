// A learner's own phone has no school data: it signs in to the server, sees the quizzes published to its class,
// and its attempts are saved back (marked on the server) where teachers can see them.
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
const quiz = { id: 'q1', title: 'Fractions', grade: 'Grade 7', stream: '', subject: 'Math', published: true, questions: [
  { id: 'a', text: 'A', options: ['1', '2', '3', '4'], answer: 1 }, { id: 'b', text: 'B', options: ['1', '2', '3', '4'], answer: 3 }] };
const draft = { ...quiz, id: 'q2', published: false };
const other = { ...quiz, id: 'q3', grade: 'Grade 8' };
const data = () => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
  students: [{ admissionNumber: '100', grade: 'Grade 7', stream: 'A', guardianPhones: ['0712 345 678'] }, { admissionNumber: '200', grade: 'Grade 8', stream: 'A' }],
  onlineQuizzes: [quiz, draft, other], quizAttempts: [] } } });
let staff, ver;
test('set up a school with a published quiz', async () => {
  const r = await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' }); staff = r.j.token;
  const p = await call('PUT', '/api/data', { data: data(), baseVersion: 0 }, staff); expect(p.s).toBe(200); ver = p.j.version;
});
test('learner signs in with admission number + welcome, or guardian phone + admission number; wrong details are refused', async () => {
  const a = await call('POST', '/api/portal/login', { username: '100', password: 'welcome' });
  expect(a.s).toBe(200); expect(a.j.student.admissionNumber).toBe('100');
  expect(a.j.quizzes.map(q => q.id)).toEqual(['q1']);               // own class only, published only
  expect((await call('POST', '/api/portal/login', { username: '0712345678', password: '100' })).s).toBe(200);
  expect((await call('POST', '/api/portal/login', { username: '100', password: 'nope' })).s).toBe(401);
  expect((await call('POST', '/api/portal/login', { username: '999', password: 'welcome' })).s).toBe(401);
});
test('learner token cannot open staff routes, and a staff token cannot act as a learner', async () => {
  const t = (await call('POST', '/api/portal/login', { username: '100', password: 'welcome' })).j.token;
  expect((await call('GET', '/api/data', null, t)).s).toBe(401);
  expect((await call('PUT', '/api/data', { data: data(), baseVersion: ver }, t)).s).toBe(401);
  expect((await call('GET', '/api/portal/quizzes', null, staff)).s).toBe(401);
});
test('attempts are saved, marked by the server, final once submitted, and limited to the learner\'s own class', async () => {
  const t = (await call('POST', '/api/portal/login', { username: '100', password: 'welcome' })).j.token;
  const start = await call('PUT', '/api/portal/attempt', { attempt: { id: 'x1', quizId: 'q1', adm: '999', startedAt: 5, answers: { a: 1 }, order: { qids: ['a', 'b'], opts: {} } } }, t);
  expect(start.s).toBe(200); expect(start.j.attempt.adm).toBe('100'); expect(start.j.attempt.submittedAt).toBeNull();
  const done = await call('PUT', '/api/portal/attempt', { attempt: { id: 'x1', quizId: 'q1', answers: { a: 1, b: 0 }, submittedAt: 1, score: 2, total: 2 } }, t);
  expect(done.j.attempt).toMatchObject({ score: 1, total: 2 });      // claimed 2/2, marked 1/2
  const again = await call('PUT', '/api/portal/attempt', { attempt: { id: 'x1', quizId: 'q1', answers: { a: 1, b: 3 }, submittedAt: 1 } }, t);
  expect(again.j.attempt.score).toBe(1);
  expect((await call('PUT', '/api/portal/attempt', { attempt: { quizId: 'q2' } }, t)).s).toBe(404);   // unpublished
  expect((await call('PUT', '/api/portal/attempt', { attempt: { quizId: 'q3' } }, t)).s).toBe(404);   // another class
});
test('teacher sees the attempt, and a teacher save made before it was pulled keeps it', async () => {
  const cloud = await call('GET', '/api/data', null, staff);
  expect(cloud.j.data.schoolData.S.quizAttempts).toHaveLength(1);
  expect(cloud.j.updatedBy).toBe('portal:100');
  const mine = data(); mine.schoolData.S.onlineQuizzes[0].title = 'Fractions (edited)';
  const put = await call('PUT', '/api/data', { data: mine, baseVersion: ver }, staff);   // stale base: only the learner saved since
  expect(put.s).toBe(200); expect(put.j.merged).toBe(true);
  const after = (await call('GET', '/api/data', null, staff)).j.data.schoolData.S;
  expect(after.onlineQuizzes[0].title).toBe('Fractions (edited)');
  expect(after.quizAttempts).toHaveLength(1);
  const stale = await call('PUT', '/api/data', { data: mine, baseVersion: ver }, staff);   // a second staff save on the same old version is a real conflict
  expect(stale.s).toBe(409);
});
describe('app wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
  test('learner login asks the server first on a device that is not cloud-signed-in, then falls back to the device data', () => {
    expect(src).toMatch(/!prStaffCloudIn\(\) && usernameRaw && passwordRaw[\s\S]*prLogin\(usernameRaw, passwordRaw\)[\s\S]*loginLearnerLocal\(usernameRaw\)/);
  });
  test('attempts are sent on start, on finish and when time runs out; a cloud learner session is never written to the phone', () => {
    expect((src.match(/prPush\(a\)/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/window\.MASMS_NO_PERSIST = true/);
    expect(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-store.js'), 'utf8')).toMatch(/window\.MASMS_NO_PERSIST/);
  });
  test('publishing warns when this device is not signed in to the cloud', () => {
    expect(src).toMatch(/function qzPublishNote[\s\S]*not signed in to the cloud/);
  });
});
