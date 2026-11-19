// Quiz types: short answer (typed, marked on the server against the accepted answers) and structured (typed, marked by the teacher).
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const base = { grade: 'Grade 7', stream: '', subject: 'Science', published: true };
const shortQ = { ...base, id: 's1', type: 'short', title: 'Short', questions: [
  { id: 'a', text: 'Process plants use to make food', image: 'data:image/jpeg;base64,AAAA', accepted: ['Photosynthesis'] },
  { id: 'b', text: 'Capital of Kenya', accepted: ['Nairobi'] }] };
const structQ = { ...base, id: 's2', type: 'structured', title: 'Structured', questions: [
  { id: 'a', text: 'Describe the diagram', marks: 4, modelAnswer: 'SECRET GUIDE' }, { id: 'b', text: 'Explain', marks: 6 }] };
const data = () => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
  students: [{ admissionNumber: '100', grade: 'Grade 7', stream: 'A', guardianPhones: ['0712 345 678'] }],
  onlineQuizzes: [shortQ, structQ], quizAttempts: [] } } });
let staff, ver, tok;
test('set up', async () => {
  staff = (await call('POST', '/api/auth/register', { username: 'owner2', password: 'password123' })).j.token;
  const p = await call('PUT', '/api/data', { data: data(), baseVersion: 0 }, staff); expect(p.s).toBe(200); ver = p.j.version;
  const l = await call('POST', '/api/portal/login', { username: '100', password: 'welcome' }); tok = l.j.token;
  const json = JSON.stringify(l.j.quizzes);
  expect(json).not.toContain('Photosynthesis'); expect(json).not.toContain('SECRET GUIDE');   // answer keys stay on the server
  expect(l.j.quizzes.find(q => q.id === 's1').questions[0].image).toBe('data:image/jpeg;base64,AAAA');   // diagrams are sent
});
test('short answers are marked on the server, ignoring case, spaces and end punctuation', async () => {
  await call('PUT', '/api/portal/attempt', { attempt: { id: 'x1', quizId: 's1', answers: { a: '  PHOTOSYNTHESIS. ' } } }, tok);
  const done = await call('PUT', '/api/portal/attempt', { attempt: { id: 'x1', quizId: 's1', answers: { a: '  PHOTOSYNTHESIS. ', b: 'Mombasa' }, submittedAt: 1, score: 2, total: 2 } }, tok);
  expect(done.j.attempt).toMatchObject({ score: 1, total: 2, right: { a: true, b: false } });
});
test('structured answers wait for the teacher; marks survive a merge with learners\' saves', async () => {
  await call('PUT', '/api/portal/attempt', { attempt: { id: 'x2', quizId: 's2', answers: { a: 'a long answer', b: 7 } } }, tok);   // non-string ignored
  const done = await call('PUT', '/api/portal/attempt', { attempt: { id: 'x2', quizId: 's2', answers: { a: 'a long answer', b: 'more' }, submittedAt: 1, score: 10, total: 10 } }, tok);
  expect(done.j.attempt).toMatchObject({ score: 0, total: 10, marked: false });
  const mine = data();
  mine.schoolData.S.quizAttempts = [{ id: 'x2', quizId: 's2', adm: '100', submittedAt: 5, answers: { a: 'a long answer', b: 'more' }, marks: { a: 3, b: 5 }, marked: true, score: 8, total: 10 }];
  const put = await call('PUT', '/api/data', { data: mine, baseVersion: ver }, staff);
  expect(put.s).toBe(200);
  const after = (await call('GET', '/api/data', null, staff)).j.data.schoolData.S;
  const att = after.quizAttempts.find(a => a.quizId === 's2');
  expect(att).toMatchObject({ marked: true, score: 8, total: 10 });
});
