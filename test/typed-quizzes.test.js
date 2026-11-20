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

// ---- structured quizzes: marking scheme, auto-marking with proportional marks ----
const fs = require('fs'), path = require('path');
const block = t => t.slice(t.indexOf('// <qz-scheme>'), t.indexOf('// </qz-scheme>'));
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const markFn = new Function(block(serverSrc) + '; return { qzMarkTyped, qzPoints };')();
const schemeQ = { id: 'm1', text: 'Solve 2x + 3 = 13', marks: 4, modelAnswer: 'x = 5',
  points: [{ text: 'Subtract 3 from both sides: 2x = 10', alt: ['2x=10'], marks: 1 }, { text: 'Divide both sides by 2', alt: ['x=5', 'x = 5'], marks: 2 },
           { text: 'Answer given with working', alt: [], marks: 1 }] };
describe('marking-scheme marker', () => {
  test('the app and the server use identical marker code', () => { expect(block(clientSrc).trim()).toBe(block(serverSrc).trim()); expect(block(clientSrc).length).toBeGreaterThan(500); });
  test('full, partial, wrong and empty answers earn proportional marks', () => {
    const full = markFn.qzMarkTyped(schemeQ, 'Subtract 3 from both sides: 2x = 10. Divide both sides by 2, so x = 5', 4);
    expect(full.marks).toBeGreaterThanOrEqual(3); expect(full.points.map(p => p.got).slice(0, 2)).toEqual([1, 2]);
    const part = markFn.qzMarkTyped(schemeQ, '2x = 10', 4); expect(part.marks).toBeGreaterThan(0); expect(part.marks).toBeLessThan(full.marks);
    expect(markFn.qzMarkTyped(schemeQ, 'I do not know', 4).marks).toBe(0);
    expect(markFn.qzMarkTyped(schemeQ, '', 4).marks).toBe(0);
  });
  test('a wrong number gets nothing, spelling slips and word endings are tolerated, marks never exceed the maximum', () => {
    expect(markFn.qzMarkTyped({ points: [{ text: 'The answer is 13', alt: ['13'], marks: 2 }] }, 'it is 113', 2).marks).toBe(0);
    expect(markFn.qzMarkTyped({ points: [{ text: 'Plants absorb carbon dioxide', alt: [], marks: 2 }] }, 'a plant absorbs carbon dioxid', 2).marks).toBe(2);
    expect(markFn.qzMarkTyped({ points: [{ text: 'a', alt: ['a'], marks: 9 }] }, 'a', 2).marks).toBeLessThanOrEqual(2);   // points are scaled to the question's marks
  });
  test('with no points the worked answer is the scheme; with neither the teacher marks', () => {
    expect(markFn.qzMarkTyped({ modelAnswer: 'Light energy makes glucose' }, 'light energy makes glucose', 3).marks).toBe(3);
    expect(markFn.qzMarkTyped({ text: 'x' }, 'anything', 3)).toBeNull();
  });
});
describe('structured quiz with a marking scheme', () => {
  const ds = () => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
    students: [{ admissionNumber: '100', grade: 'Grade 7', stream: 'A', guardianPhones: ['0712 345 678'] }],
    onlineQuizzes: [{ ...base, id: 'sc1', type: 'structured', title: 'Scheme', questions: [schemeQ, { id: 'm2', text: 'Name the gas', marks: 2, modelAnswer: 'Oxygen is released',
      points: [{ text: 'Oxygen', alt: [], marks: 2 }] }] }, { ...base, id: 'sc2', type: 'structured', title: 'Partly', questions: [schemeQ, { id: 'z', text: 'Explain', marks: 2 }] }], quizAttempts: [] } } });
  let tk, st;
  test('set up', async () => {
    st = staff;   // the account created by the tests above
    const cur = await call('GET', '/api/data', null, st);
    expect((await call('PUT', '/api/data', { data: ds(), baseVersion: cur.j.version }, st)).s).toBe(200);
    const l = await call('POST', '/api/portal/login', { username: '100', password: 'welcome' }); tk = l.j.token;
    const json = JSON.stringify(l.j.quizzes);
    ['Subtract 3 from both sides', 'x=5', 'Oxygen is released', '"points"', '"modelAnswer"'].forEach(t => expect(json).not.toContain(t));   // the scheme stays on the server
    expect(l.j.quizzes.find(q => q.id === 'sc1').autoMark).toBe(true); expect(l.j.quizzes.find(q => q.id === 'sc2').autoMark).toBe(false);
  });
  test('a submitted answer is compared with the scheme and marked proportionally at once', async () => {
    const answers = { m1: 'Subtract 3 from both sides: 2x = 10. Divide both sides by 2, so x = 5', m2: 'oxygen' };
    const r = await call('PUT', '/api/portal/attempt', { attempt: { id: 'q1', quizId: 'sc1', answers, submittedAt: 1, score: 99, total: 99 } }, tk);
    expect(r.j.attempt).toMatchObject({ marked: true, autoMarked: true, total: 6 });
    expect(r.j.attempt.marks.m2).toBe(2); expect(r.j.attempt.marks.m1).toBeGreaterThanOrEqual(3);
    expect(r.j.attempt.score).toBe(r.j.attempt.marks.m1 + r.j.attempt.marks.m2);
  });
  test('when some question has no scheme the attempt waits for the teacher', async () => {
    const r = await call('PUT', '/api/portal/attempt', { attempt: { id: 'q2', quizId: 'sc2', answers: { m1: '2x = 10', z: 'because' }, submittedAt: 1 } }, tk);
    expect(r.j.attempt).toMatchObject({ marked: false, score: 0, total: 6 }); expect(r.j.attempt.marks).toBeUndefined();
  });
});
