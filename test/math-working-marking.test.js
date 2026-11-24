// Mathematics marking: working is compared in an equivalence-friendly way, and steps a learner skips or only implies are credited
// when a later step (or the final answer) is correct. "Must be shown" points are independent and never implied.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const fs = require('fs'), path = require('path');
const block = t => t.slice(t.indexOf('// <qz-scheme>'), t.indexOf('// </qz-scheme>'));
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const { qzMarkTyped: mark, qzImpliedOn: on } = new Function(block(serverSrc) + '; return { qzMarkTyped, qzImpliedOn };')();
const pts = (...a) => ({ points: a.map(([text, marks, alt, shown]) => ({ text, marks, alt: alt || [], shown: !!shown })) });
const solve = pts(['Subtract 3 from both sides: 2x = 10', 1, ['2x=10']], ['Divide both sides by 2', 1], ['Final answer x = 5', 2, ['x=5']]);

test('client and server carry the identical marker', () => expect(block(clientSrc).trim()).toBe(block(serverSrc).trim()));
test('implied credit is on for working subjects unless the teacher says otherwise', () => {
  expect(on({ subject: 'Mathematics' })).toBe(true); expect(on({ subject: 'Physics' })).toBe(true); expect(on({ subject: 'History' })).toBe(false);
  expect(on({ subject: 'Mathematics', impliedSteps: false })).toBe(false); expect(on({ subject: 'History', impliedSteps: true })).toBe(true);
});
test('a clever learner who writes only the answer gets the steps credited; without the setting they do not', () => {
  const a = mark(solve, 'x = 5', 4, true);
  expect(a.marks).toBe(4); expect(a.points.map(p => !!p.implied)).toEqual([true, true, false]);
  expect(mark(solve, 'x = 5', 4, false).marks).toBe(2);
});
test('a skipped middle step is credited when the later step is shown; a missing LATER step is not', () => {
  const a = mark(solve, '2x = 10, so x = 5', 4, true);
  expect(a.points.map(p => p.got)).toEqual([1, 1, 2]);
  const b = mark(solve, '2x = 10', 4, true);                    // stops early: nothing later is shown, so nothing is implied
  expect(b.points.map(p => p.got)).toEqual([1, 0, 0]); expect(b.points.some(p => p.implied)).toBe(false);
});
test('a wrong final answer does not earn the earlier steps for free', () => {
  expect(mark(solve, 'x = 7', 4, true).marks).toBe(0);
});
test('"Must be shown" points are never implied and do not imply others', () => {
  const q = pts(['State the formula: area = 1/2 x base x height', 1, [], true], ['Substitute: 1/2 x 6 x 4', 1], ['Area = 12', 2]);
  const a = mark(q, 'Area = 12', 4, true);
  expect(a.points.map(p => p.got)).toEqual([0, 1, 2]);          // the formula was not written, so it is not credited
  const b = mark(pts(['Area = 12', 1], ['Write the units: cm2', 1, [], true]), 'Area = 12', 2, true);
  expect(b.marks).toBe(1);
});
test('equivalent working is recognised: swapped sides, fractions and decimals, powers, implied multiplication, run-together steps', () => {
  const m = (point, resp) => mark(pts([point, 1]), resp, 1, false).marks;
  expect(m('x = 5', '5 = x')).toBe(1);
  expect(m('x = 0.5', 'x = 1/2')).toBe(1);
  expect(m('x = 1/2', 'x = 0.50')).toBe(1);
  expect(m('area = x^2 + 3', 'area = x² + 3')).toBe(1);
  expect(m('2x + 3 = 13', '2*x + 3 = 13')).toBe(1);
  expect(m('x = 5', 'x = 10/2 = 5')).toBe(1);
  expect(m('x = 5', 'x = 2x/2 = 5')).toBe(1);
  expect(m('x = 5', 'x = 6')).toBe(0);
  expect(m('1500', '1,500')).toBe(1);
});
test('existing behaviour: wrong numbers score 0 and marks never exceed the maximum', () => {
  expect(mark(pts(['The answer is 13', 2, ['13']]), 'it is 113', 2, true).marks).toBe(0);
  expect(mark(pts(['a', 9, ['a']]), 'a', 2, true).marks).toBeLessThanOrEqual(2);
});

// ---- end to end: the server marks a Mathematics structured quiz at once and credits implied working ----
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
test('server: only the answer is typed, the steps are implied for Mathematics, and not when the teacher switches it off', async () => {
  const mk = (id, extra) => ({ id, type: 'structured', title: id, grade: 'Grade 9', stream: '', subject: 'Mathematics', published: true, ...extra,
    questions: [{ id: 'q1', text: 'Solve 2x + 3 = 13', marks: 4, points: solve.points }] });
  const data = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [{ admissionNumber: '300', grade: 'Grade 9', stream: 'A' }],
    onlineQuizzes: [mk('m-on', {}), mk('m-off', { impliedSteps: false })], quizAttempts: [] } } };
  const staff = (await call('POST', '/api/auth/register', { username: 'mathsowner', password: 'password123' })).j.token;
  expect((await call('PUT', '/api/data', { data, baseVersion: 0 }, staff)).s).toBe(200);
  const tok = (await call('POST', '/api/portal/login', { username: '300', password: 'welcome' })).j.token;
  const a = await call('PUT', '/api/portal/attempt', { attempt: { id: 'a1', quizId: 'm-on', answers: { q1: 'x = 5' }, submittedAt: 1 } }, tok);
  expect(a.j.attempt).toMatchObject({ marked: true, autoMarked: true, score: 4 });
  const b = await call('PUT', '/api/portal/attempt', { attempt: { id: 'a2', quizId: 'm-off', answers: { q1: 'x = 5' }, submittedAt: 1 } }, tok);
  expect(b.j.attempt).toMatchObject({ marked: true, score: 2 });
});
