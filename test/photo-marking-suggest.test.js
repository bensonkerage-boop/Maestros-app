// Photos of handwritten working: Claude reads them and SUGGESTS marks. The teacher confirms every mark; learners never see the suggestions.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test'; process.env.ANTHROPIC_API_KEY = 'test-key';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ai = require('../src/ai-mark');
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD';
const okReply = o => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(o) }] }) });

describe('AI module with photos', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const item = { id: 'a', text: 'Solve 2x+3=13', marks: 4, modelAnswer: '', response: '', images: [JPG],
    points: [{ text: 'Subtract 3', alt: [], marks: 2, shown: false }, { text: 'x = 5', alt: [], marks: 2, shown: false }] };
  test('photos are sent to Claude as image blocks, and what Claude read comes back with the suggestion', async () => {
    global.fetch = jest.fn(async () => okReply({ results: [{ id: 'a', read: '2x = 10, x = 5', points: [{ i: 0, got: 2, reason: 'Shows 2x=10' }, { i: 1, got: 2, reason: 'x = 5' }], feedback: 'Neat working.' }] }));
    const r = await ai.aiMark({ subject: 'Mathematics' }, [item]);
    expect(r.a).toMatchObject({ marks: 4, read: '2x = 10, x = 5' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body), blocks = body.messages[0].content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.filter(b => b.type === 'image')).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPG.split(',')[1] } }]);
    expect(blocks[0].text).toContain('see the photos of working');
    expect(body.system).toMatch(/handwritten working/); expect(body.system).toMatch(/\[unclear\]/);
  });
  test('typed answers still go as plain text and carry no read field', async () => {
    global.fetch = jest.fn(async () => okReply({ results: [{ id: 'a', read: 'ignored', points: [{ i: 0, got: 1 }], feedback: '' }] }));
    const r = await ai.aiMark({}, [{ ...item, images: [], response: 'x=5' }]);
    expect(typeof JSON.parse(global.fetch.mock.calls[0][1].body).messages[0].content).toBe('string'); expect(r.a.read).toBeUndefined();
  });
  test('only real small photos are kept: at most two per question and no other data URLs', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(150001);
    expect(ai.cleanImages([JPG, JPG, JPG, big, 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4='])).toEqual([JPG, JPG]);
    expect(ai.cleanImages(['data:text/html;base64,PHNjcmlwdD4=', big, 5, null])).toEqual([]);
    expect(ai.cleanImages([JPG, JPG], JPG.length + 1)).toEqual([JPG]);
  });
});

describe('server: a submitted photo attempt gets suggestions, not marks', () => {
  const app = require('../src/app'), realFetch = global.fetch;
  let srv, claude, staff, tok;
  beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
  afterAll(() => new Promise(r => { global.fetch = realFetch; srv.closeAllConnections?.(); srv.close(() => r()); }));
  beforeEach(() => { claude = jest.fn(); global.fetch = (u, o) => String(u).startsWith('https://api.anthropic.com') ? claude(u, o) : realFetch(u, o); });
  const call = async (m, p, b, t) => { const r = await realFetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const scheme = [{ text: 'Subtract 3', alt: ['2x=10'], marks: 2 }, { text: 'x = 5', alt: [], marks: 2 }];
  const mkQ = (id, extra) => ({ id, type: 'structured', title: id, grade: 'Grade 7', stream: '', subject: 'Mathematics', published: true, allowPhotos: true,
    questions: [{ id: 'a', text: 'Solve 2x+3=13', marks: 4, points: scheme }, { id: 'b', text: 'Explain', marks: 4, points: scheme }], ...extra });
  const put = (quizId, attempt) => call('PUT', '/api/portal/attempt', { attempt: { id: 'at-' + quizId, quizId, ...attempt } }, tok);
  test('set up', async () => {
    staff = (await call('POST', '/api/auth/register', { username: 'suggestowner', password: 'password123' })).j.token;
    const d = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [{ admissionNumber: '100', grade: 'Grade 7', stream: 'A', guardianPhones: ['0712 345 678'] }],
      onlineQuizzes: [mkQ('s1'), mkQ('s2'), mkQ('s3', { aiMarking: false })], quizAttempts: [] } } };
    expect((await call('PUT', '/api/data', { data: d, baseVersion: 0 }, staff)).s).toBe(200);
    tok = (await call('POST', '/api/portal/login', { username: '100', password: 'welcome' })).j.token; expect(tok).toBeTruthy();
  });
  test('Claude reads the photo; the suggestion is saved for the teacher, the attempt stays unmarked, and the learner never sees it', async () => {
    claude.mockResolvedValue(okReply({ results: [{ id: 'b', read: '2x=10 so x=5', points: [{ i: 0, got: 2, reason: 'ok' }, { i: 1, got: 2, reason: 'ok' }], feedback: 'Good.' }] }));
    const r = await put('s1', { answers: { a: 'x = 5' }, photos: { b: [JPG] }, submittedAt: 1 });
    expect(r.j.attempt).toMatchObject({ marked: false, score: 0 }); expect(r.j.attempt.autoMarked).toBeUndefined();
    expect(r.j.attempt.aiSuggest).toBeUndefined(); expect(r.j.attempt.aiSuggestedOn).toBeUndefined();
    const sent = JSON.parse(claude.mock.calls[0][1].body).messages[0].content;
    expect(sent.filter(b => b.type === 'image')).toHaveLength(1);
    const kept = (await call('GET', '/api/data', null, staff)).j.data.schoolData.S.quizAttempts.find(a => a.quizId === 's1');
    expect(kept.marked).toBe(false); expect(kept.aiSuggest.b).toMatchObject({ marks: 4, read: '2x=10 so x=5' }); expect(kept.aiSuggest.a).toBeUndefined();
    const again = await call('POST', '/api/portal/login', { username: '100', password: 'welcome' });
    expect(JSON.stringify(again.j.attempts)).not.toMatch(/aiSuggest|2x=10 so x=5/);
  });
  test('if Claude is down the attempt still waits for the teacher with no suggestions', async () => {
    claude.mockRejectedValue(new Error('network'));
    const r = await put('s2', { answers: {}, photos: { a: [JPG] }, submittedAt: 1 });
    expect(r.s).toBe(200); expect(r.j.attempt).toMatchObject({ marked: false });
    expect((await call('GET', '/api/data', null, staff)).j.data.schoolData.S.quizAttempts.find(a => a.quizId === 's2').aiSuggest).toBeUndefined();
  });
  test('a quiz with AI marking switched off never calls Claude for photos', async () => {
    await put('s3', { answers: {}, photos: { a: [JPG] }, submittedAt: 1 });
    expect(claude).not.toHaveBeenCalled();
  });
});

describe('teacher screen: suggestions are shown and only filled in on request', () => {
  const grab = (re, what) => { const m = clientSrc.match(re); if (!m) throw new Error('missing ' + what); return m[0]; };
  const start = clientSrc.indexOf('// ---------- Photographed working'), end = clientSrc.indexOf('function qzClearPhotos(){');
  const code = [grab(/function qzEsc\(v\)\{.*\n/, 'qzEsc'), grab(/function qzPhotosOf\(a, qid\)\{.*\n/, 'qzPhotosOf'), grab(/function qzHasPhotos\(a\)\{.*\n/, 'qzHasPhotos'), clientSrc.slice(start, end)].join('\n');
  const q = { id: 'q1', subject: 'Maths', grade: 'Grade 7', questions: [{ id: 'a', text: 'A', marks: 4 }, { id: 'b', text: 'B', marks: 2 }] };
  const mkEnv = (attempts, api) => {
    const env = { quizResultsId: 'q1', quizMsg: null, onlineQuizzes: [q], quizMarking: { adm: '100', draft: null }, renders: 0, saved: 0, api, signedIn: true };
    const ctx = vm.createContext({ ...env, onlineQuizzes: [q], console, Number, Math, String, Object, Array, JSON,
      qzType: () => 'structured', qzImpliedOn: () => false, qzQMarks: (qq, x) => x.marks, qzPoints: x => [{ text: 'Step', alt: [], marks: x.marks, shown: false }],
      qzSubmitted: () => attempts, qzAttempt: () => attempts[0], commsSignedIn: () => ctx.signedIn, commsApi: (...a) => ctx.api(...a),
      render: () => { ctx.renders++; }, qzCloudNow: () => { ctx.saved++; } });
    vm.runInContext(code + '\n;this.qzSuggestBlock=qzSuggestBlock;this.qzSuggestNote=qzSuggestNote;this.qzUseSuggestion=qzUseSuggestion;this.qzUseAllSuggestions=qzUseAllSuggestions;this.qzSuggestPhotos=qzSuggestPhotos;this.qzPhotoBatches=qzPhotoBatches;', ctx);
    return ctx;
  };
  const sg = { marks: 3, max: 4, points: [{ text: 'Step <b>', got: 3, max: 4, reason: 'half shown' }], feedback: 'Fine', read: '2x=10 <script>' };
  test('the suggestion block shows what Claude read (escaped) and a button, and offers nothing without a suggestion', () => {
    const ctx = mkEnv([{ adm: '100', aiSuggest: { a: sg } }]);
    const html = ctx.qzSuggestBlock({ aiSuggest: { a: sg } }, q.questions[0], 4);
    expect(html).toContain('not saved until you confirm'); expect(html).toContain('2x=10 &lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain("qzUseSuggestion('a')");
    expect(ctx.qzSuggestBlock({}, q.questions[0], 4)).toBe(''); expect(ctx.qzSuggestNote({})).toBe(''); expect(ctx.qzSuggestNote({ aiSuggest: { a: sg } })).toContain('qzUseAllSuggestions');
  });
  test('using a suggestion only fills the marks box (clamped to the question), never marks the attempt', () => {
    const a = { adm: '100', marked: false, aiSuggest: { a: sg, b: { marks: 9, max: 2, points: [] } } }, ctx = mkEnv([a]);
    expect(ctx.qzUseSuggestion('a')).toBe(true); expect(ctx.quizMarking.draft).toEqual({ a: 3 });
    ctx.qzUseAllSuggestions(); expect(ctx.quizMarking.draft).toEqual({ a: 3, b: 2 });
    expect(a.marked).toBe(false); expect(a.marks).toBeUndefined(); expect(a.score).toBeUndefined(); expect(ctx.qzUseSuggestion('zzz')).toBe(false);
  });
  test('Suggest marks for photos stores suggestions only, skips teacher-marked and already-read attempts, and batches the photos', async () => {
    const fresh = { adm: '1', submittedAt: 1, answers: {}, photos: { a: [JPG] } }, hand = { adm: '2', submittedAt: 1, marked: true, answers: {}, photos: { a: [JPG] } }, done = { adm: '3', submittedAt: 1, answers: {}, photos: { a: [JPG] }, aiSuggest: { a: sg } };
    const api = jest.fn(async () => ({ results: { a: { marks: 4, max: 4, points: [], feedback: '', read: 'x=5' } } }));
    const ctx = mkEnv([fresh, hand, done], api); await ctx.qzSuggestPhotos();
    expect(api).toHaveBeenCalledTimes(1); expect(api.mock.calls[0][1]).toBe('/ai/mark'); expect(api.mock.calls[0][2].items[0].images).toEqual([JPG]);
    expect(fresh.aiSuggest.a).toMatchObject({ marks: 4, read: 'x=5' }); expect(fresh.marked).toBeUndefined(); expect(fresh.marks).toBeUndefined(); expect(fresh.score).toBeUndefined();
    expect(hand.aiSuggest).toBeUndefined(); expect(ctx.quizMsg.type).toBe('ok'); expect(ctx.saved).toBe(1);
    const big = 'x'.repeat(1000000); expect(ctx.qzPhotoBatches([{ images: [big] }, { images: [big] }, { images: [big] }]).map(b => b.length)).toEqual([2, 1]);   // 2.8 MB per request at most
  });
  test('without a school-server sign-in it says so and calls nothing; a failure leaves the attempt untouched', async () => {
    const api = jest.fn(), a = { adm: '1', submittedAt: 1, answers: {}, photos: { a: [JPG] } }, ctx = mkEnv([a], api); ctx.signedIn = false;
    await ctx.qzSuggestPhotos(); expect(api).not.toHaveBeenCalled(); expect(ctx.quizMsg.type).toBe('error');
    ctx.signedIn = true; ctx.api = jest.fn(async () => { throw new Error('Claude AI marking is not set up on the server'); }); await ctx.qzSuggestPhotos();
    expect(a.aiSuggest).toBeUndefined(); expect(ctx.quizMsg.type).toBe('error');
  });
  test('the review screen and results screen are wired to the new functions, and the key still never reaches the browser', () => {
    expect(clientSrc).toContain('${sugHtml}${markHtml}'); expect(clientSrc).toContain('onclick="qzSuggestPhotos()"'); expect(clientSrc).toContain('${qzSuggestNote(a)}');
    expect(clientSrc).not.toMatch(/ANTHROPIC_API_KEY|x-api-key/);
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8')).toMatch(/const \{ aiNotes, aiSuggest, aiSuggestedOn, \.\.\.rest \} = a/);
  });
});
