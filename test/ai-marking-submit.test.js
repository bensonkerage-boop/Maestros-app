// A learner submits a written paper: Claude marks it by meaning on the server; if Claude fails the word-matching marker is used.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test'; process.env.ANTHROPIC_API_KEY = 'test-key';
const app = require('../src/app');
const realFetch = global.fetch;
let srv, claude;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { global.fetch = realFetch; srv.closeAllConnections?.(); srv.close(() => r()); }));
beforeEach(() => { claude = jest.fn(); global.fetch = (u, o) => String(u).startsWith('https://api.anthropic.com') ? claude(u, o) : realFetch(u, o); });
const call = async (m, p, b, t) => { const r = await realFetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const mk = (id, extra) => ({ id, title: 'Biology', grade: 'Grade 9', stream: '', subject: 'Biology', type: 'structured', published: true, ...extra, questions: [
  { id: 'a', text: 'Why do plants need light?', marks: 4, points: [{ text: 'Light is the energy source for photosynthesis', marks: 2 }, { text: 'Glucose is made', marks: 2 }] }] });
let staff;
test('set up', async () => {
  staff = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  const d = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [{ admissionNumber: '100', grade: 'Grade 9', stream: 'A' }], onlineQuizzes: [mk('on'), mk('off', { aiMarking: false }), mk('down')], quizAttempts: [] } } };
  expect((await call('PUT', '/api/data', { data: d, baseVersion: 0 }, staff)).s).toBe(200);
});
const submit = async (quizId, text) => {
  const t = (await call('POST', '/api/portal/login', { username: '100', password: 'welcome' })).j.token;
  return (await call('PUT', '/api/portal/attempt', { attempt: { id: 'x' + quizId, quizId, startedAt: 1, answers: { a: text }, submittedAt: 1, order: { qids: ['a'], opts: {} } } }, t)).j.attempt;
};
const ok = o => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(o) }] }) });
test('different wording is marked right by Claude and the reasons are kept for the teacher', async () => {
  claude.mockResolvedValue(ok({ results: [{ id: 'a', points: [{ i: 0, got: 2, reason: 'Sunshine = light energy' }, { i: 1, got: 2, reason: 'Sugar = glucose' }], feedback: 'Well explained.' }] }));
  const a = await submit('on', 'They use sunshine to make sugar for food');
  expect(a).toMatchObject({ score: 4, marked: true, autoMarked: true, aiMarked: true, markedBy: 'Claude AI (marking scheme)' });
  expect(a.aiNotes).toBeUndefined();   // the learner never receives notes that quote the marking scheme
  expect(claude).toHaveBeenCalledTimes(1);
});
test('a quiz with AI marking switched off never calls Claude', async () => {
  const a = await submit('off', 'Light is the energy source for photosynthesis and glucose is made');
  expect(claude).not.toHaveBeenCalled(); expect(a).toMatchObject({ marked: true, autoMarked: true, markedBy: 'Marking scheme' }); expect(a.aiMarked).toBeUndefined();
});
test('if Claude is down the word-matching marker still marks the paper', async () => {
  claude.mockRejectedValue(new Error('network'));
  const a = await submit('down', 'Light is the energy source for photosynthesis and glucose is made');
  expect(a).toMatchObject({ score: 4, marked: true, markedBy: 'Marking scheme' }); expect(a.aiMarked).toBeUndefined();
});
