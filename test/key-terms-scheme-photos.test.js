// Strict key-term marking, uploading a marking scheme for questions already in the editor, and learners' photos of written working.
process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const fs = require('fs'), path = require('path'), vm = require('vm');
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const block = t => t.slice(t.indexOf('// <qz-scheme>'), t.indexOf('// </qz-scheme>'));
const { qzMarkTyped: mark, qzMarkOpts: opts } = new Function(block(serverSrc) + '; return { qzMarkTyped, qzMarkOpts };')();

describe('strict key-term marking', () => {
  const q = { points: [{ text: 'Plants make food by photosynthesis', alt: [], marks: 2 }] };
  test('the app and the server carry the identical marker', () => {
    expect(block(clientSrc).trim()).toBe(block(serverSrc).trim());
    expect(block(clientSrc)).toContain('QZ_GLOSSARY');
  });
  test('by default a spelling slip in a key word is still forgiven (nothing changes for existing quizzes)', () => {
    expect(mark(q, 'plants make food by photosythesis', 2).marks).toBe(2);
    expect(opts({}).strict).toBe(false); expect(opts({ strictTerms: true }).strict).toBe(true);
  });
  test('with strict spelling on, a glossary word must be exact, ordinary words still forgive slips and endings, and the slip is reported', () => {
    const o = { strict: true };
    expect(mark(q, 'Plants make food by photosynthesis.', 2, false, o).marks).toBe(2);
    expect(mark(q, 'plant make foods by photosynthesis', 2, false, o).marks).toBe(2);
    const bad = mark(q, 'plants make food by photosythesis', 2, false, o);
    expect(bad.marks).toBeLessThan(2); expect(bad.points[0].misspelt).toEqual([{ term: 'photosynthesis', wrote: 'photosythesis' }]);
    expect(mark(q, 'plants make food by photosynthesis', 2, false, o).points[0].misspelt).toBeUndefined();
  });
  test('a key word alone is worth nothing when misspelt, and only its plural is forgiven', () => {
    const one = { points: [{ text: 'mitochondria', alt: [], marks: 1 }] };
    expect(mark(one, 'mitochondira', 1, false, { strict: true }).marks).toBe(0);
    expect(mark({ points: [{ text: 'kidney', alt: [], marks: 1 }] }, 'kidneys', 1, false, { strict: true }).marks).toBe(1);
  });
  test('terms listed on a point are exact even when strict spelling is off', () => {
    const p = { points: [{ text: 'Name the organelle for respiration', alt: ['powerhouse of the cell'], terms: ['powerhouse'], marks: 1 }] };
    expect(mark(p, 'the powerhouse of the cell', 1).marks).toBe(1);
    expect(mark(p, 'the powerhose of the cell', 1).marks).toBeLessThan(1);
  });
  test('key terms carry through the implied-working chain without crediting a misspelt term as shown', () => {
    const w = { points: [{ text: 'Use hypotenuse', alt: [], terms: ['hypotenuse'], marks: 1, shown: true }, { text: 'x = 5', alt: [], marks: 1 }] };
    expect(mark(w, 'x = 5', 2, true).marks).toBe(1);   // a "must be shown" point is never implied
  });
});

// ---- parsing, scheme upload and matching (the editor's functions, run in isolation) ----
const cut = (a, b) => clientSrc.slice(clientSrc.indexOf(a), clientSrc.indexOf(b, clientSrc.indexOf(a)));
const ctx = {}; vm.createContext(ctx);
vm.runInContext([cut('function qzUid(', 'function qzGrades'), cut('function qzBlankQuestion(', 'function qzBlankQuiz'),
  cut('function qzPtSum(', 'function qzPtSync'), cut('function qzParseTypedLines(', '// -- DOCX')].join('\n') +
  ';this.f={qzParseBulkTyped,qzParseTypedLines,qzParseScheme,qzApplyScheme,qzSchemeNote};', ctx);
const { qzParseTypedLines: parse, qzParseScheme: parseScheme, qzApplyScheme: apply, qzSchemeNote: note } = ctx.f;
const L = (s, bold) => s.split('\n').map(t => ({ text: t, ...(bold && bold[t] ? { bold: bold[t] } : {}) }));

describe('key terms in an uploaded scheme', () => {
  test('[key: ...] after a point, or the bold words of a Word line, become exact key terms', () => {
    const qs = parse(L(`1. Explain how plants make food. (3 marks)
Marking scheme:
- Process is called photosynthesis [key: photosynthesis] (1)
- Light is absorbed by chlorophyll (2)`, { '- Light is absorbed by chlorophyll (2)': ['chlorophyll'] }), 'structured');
    expect(qs[0].points[0]).toEqual({ text: 'Process is called photosynthesis', alt: [], marks: 1, terms: ['photosynthesis'] });
    expect(qs[0].points[1].terms).toEqual(['chlorophyll']);
  });
  test('a fully bold line, a number, or a long phrase is not turned into a key term', () => {
    const t = '- Water is lost through stomata (1)';
    expect(parse(L('1. Q (1 mark)\nMarking scheme:\n' + t, { [t]: ['Water is lost through stomata'] }), 'structured')[0].points[0].terms).toBeUndefined();
  });
});

describe('uploading a marking scheme for questions already in the editor', () => {
  const existing = () => [{ id: 'a', text: 'Explain soil erosion', marks: 1, accepted: [], points: [], modelAnswer: '' }, { id: 'b', text: 'State two uses of copper', marks: 1, accepted: [], points: [], modelAnswer: '' }];
  const file = `Marking scheme
1. Answer: Deforestation and overgrazing.
- Deforestation removes ground cover | clearing of trees (2)
- Overgrazing leaves soil bare (2)
2. Wire (1)
Pots [key: copper] (1)`;
  test('a file that holds only the scheme is read by question number', () => {
    const key = parseScheme(L(file), 'structured');
    expect(Object.keys(key)).toEqual(['1', '2']);
    expect(key[1].model).toBe('Deforestation and overgrazing.');
    expect(key[1].points.map(p => p.marks)).toEqual([2, 2]);
    expect(key[1].points[0].alt).toEqual(['clearing of trees']);
    expect(key[2].points[1].terms).toEqual(['copper']);
  });
  test('scheme n is attached to question n, the marks follow the points, and the questions themselves are untouched', () => {
    const qs = existing(), res = apply(qs, parseScheme(L(file), 'structured'), 'structured');
    expect(res).toMatchObject({ applied: 2, replaced: 0, missing: [], extra: [] });
    expect(qs[0].text).toBe('Explain soil erosion'); expect(qs[0].marks).toBe(4); expect(qs[1].marks).toBe(2);
    expect(qs[0].modelAnswer).toBe('Deforestation and overgrazing.');
    expect(note(res, 2, 'scheme.docx').type).toBe('ok');
  });
  test('missing and surplus numbers are reported, and an existing scheme is counted as replaced', () => {
    const qs = existing();
    const res = apply(qs, parseScheme(L('1. Overgrazing leaves soil bare (2)\n3. Extra (1)'), 'structured'), 'structured');
    expect(res).toMatchObject({ applied: 1, replaced: 0, missing: [2], extra: [3] });
    const withOld = existing(); withOld[1].points = [{ text: 'old', alt: [], marks: 1 }];
    const again = apply(withOld, parseScheme(L('1. A (1)\n2. B (1)'), 'structured'), 'structured');
    expect(again.replaced).toBe(1);   // only question 2 already had points
    expect(note(res, 2, 'x.docx').type).toBe('error'); expect(note(res, 2, 'x.docx').text).toMatch(/question 2/);
  });
  test('short answers: accepted wording by number, | separating alternatives', () => {
    const qs = [{ id: 'a', text: 'Q1', accepted: [''] }, { id: 'b', text: 'Q2', accepted: [] }];
    const res = apply(qs, parseScheme(L('Answers\n1. photosynthesis | photo synthesis\n2. Nairobi'), 'short'), 'short');
    expect(res.applied).toBe(2); expect(qs[0].accepted).toEqual(['photosynthesis', 'photo synthesis']); expect(qs[1].accepted).toEqual(['Nairobi']);
  });
  test('a file with no numbered scheme gives nothing to apply', () => { expect(Object.keys(parseScheme(L('Just some notes\nwith no numbers'), 'structured'))).toHaveLength(0); });
});

// ---- learner photos of written working ----
const app = require('../src/app');
let srv;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD';
const scheme = [{ text: 'Subtract 3', alt: ['2x=10'], marks: 2 }, { text: 'x = 5', alt: [], marks: 2 }];
const mkQ = (id, extra) => ({ id, type: 'structured', title: id, grade: 'Grade 7', stream: '', subject: 'Mathematics', published: true,
  questions: [{ id: 'a', text: 'Solve 2x+3=13', marks: 4, points: scheme }, { id: 'b', text: 'Explain', marks: 4, points: scheme }], ...extra });
const data = () => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
  students: [{ admissionNumber: '100', grade: 'Grade 7', stream: 'A', guardianPhones: ['0712 345 678'] }],
  onlineQuizzes: [mkQ('ph', { allowPhotos: true }), mkQ('np', {}), mkQ('ph2', { allowPhotos: true }), mkQ('ph3', { allowPhotos: true })], quizAttempts: [] } } });
let staff, ver, tok;
const put = (quizId, attempt, t = tok) => call('PUT', '/api/portal/attempt', { attempt: { id: 'at-' + quizId, quizId, ...attempt } }, t);

describe('photos of written working', () => {
  test('set up', async () => {
    staff = (await call('POST', '/api/auth/register', { username: 'photoowner', password: 'password123' })).j.token;
    const p = await call('PUT', '/api/data', { data: data(), baseVersion: 0 }, staff); expect(p.s).toBe(200); ver = p.j.version;
    tok = (await call('POST', '/api/portal/login', { username: '100', password: 'welcome' })).j.token;
    expect(tok).toBeTruthy();
  });
  test('the learner is told the quiz allows photos, and never receives the marking scheme', async () => {
    const l = await call('POST', '/api/portal/login', { username: '100', password: 'welcome' });
    expect(l.j.quizzes.find(q => q.id === 'ph').allowPhotos).toBe(true);
    expect(JSON.stringify(l.j.quizzes)).not.toContain('Subtract 3');
  });
  test('a photo is stored with the answer; a photo alone counts as an answer; the attempt then waits for the teacher', async () => {
    const r = await put('ph', { answers: { a: 'x = 5' }, photos: { b: [JPG] }, submittedAt: 1 });
    expect(r.s).toBe(200);
    const at = r.j.attempt;
    expect(at.photos).toEqual({ b: [JPG] });
    expect(at.answers).toEqual({ a: 'x = 5', b: '' }); expect(at.saved).toEqual({ a: true, b: true });
    expect(at).toMatchObject({ marked: false, score: 0, total: 8 }); expect(at.autoMarked).toBeUndefined();   // handwriting cannot be read by the marker
  });
  test('the same answers without a photo are marked at once', async () => {
    const r = await put('np', { answers: { a: 'Subtract 3 so 2x=10 then x = 5', b: 'x = 5' }, photos: { a: [JPG] }, submittedAt: 1 });
    expect(r.j.attempt.photos).toBeUndefined();   // this quiz did not switch photos on, so none are kept
    expect(r.j.attempt).toMatchObject({ marked: true, autoMarked: true });
  });
  test('only real small photos for real questions are kept, at most two per question', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(150001);
    const r = await put('ph2', { answers: {}, photos: { a: [JPG, JPG, JPG], zzz: [JPG], b: ['data:text/html;base64,PHNjcmlwdD4=', 'javascript:alert(1)', big, 'not an image'] } }, tok);
    expect(r.j.attempt.photos).toEqual({ a: [JPG, JPG] });
    expect(r.j.attempt.photoNote).toMatch(/not saved/);
  });
  test('the school\'s photo space is limited; photos that do not fit are dropped with a note, not stored', async () => {
    const held = (await call('GET', '/api/data', null, staff)).j.data.schoolData.S.quizAttempts.reduce((t, a) => t + Object.values(a.photos || {}).flat().length, 0);
    process.env.QUIZ_PHOTO_BUDGET = String(JPG.length * (held + 3) + 10);   // room for three more photos
    try {
      const r = await put('ph3', { answers: {}, photos: { a: [JPG, JPG], b: [JPG, JPG] } });
      const kept = Object.values(r.j.attempt.photos).flat().length;
      expect(kept).toBe(3); expect(r.j.attempt.photoNote).toBeTruthy();
    } finally { delete process.env.QUIZ_PHOTO_BUDGET; }
  });
  test('a submitted attempt is final, photos included', async () => {
    const first = await put('ph', { answers: { a: 'x = 5' }, photos: { a: [JPG] }, submittedAt: 1 });
    const again = await put('ph', { answers: { a: 'changed' }, photos: {}, submittedAt: 2 });
    expect(again.j.attempt.photos).toEqual(first.j.attempt.photos); expect(again.j.attempt.answers.a).toBe('x = 5');
  });
  test('the teacher sees the photos with the attempt and the learner payload carries them back for review', async () => {
    const got = await call('GET', '/api/portal/quizzes', null, tok);
    expect(got.j.attempts.find(a => a.quizId === 'ph').photos).toBeTruthy();
    const d = (await call('GET', '/api/data', null, staff)).j.data.schoolData.S;
    expect(d.quizAttempts.find(a => a.quizId === 'ph').photos).toBeTruthy();
  });
});

describe('the app wires the new features in', () => {
  test('editor: key-term box, strict switch, photo switch and the scheme upload panel exist', () => {
    for (const s of ['qzSetPtTerms', "qzSet('strictTerms'", "qzSet('allowPhotos'", 'qzImportSchemeFile(this)', 'Upload a marking scheme for the questions above'])
      expect(clientSrc).toContain(s);
  });
  test('saving a quiz keeps each point\'s key terms', () => { expect(cut('function qzSave(', '// ---------- Import questions')).toMatch(/terms/); });
  test('every marker call passes the quiz\'s spelling option', () => {
    const calls = [...clientSrc.matchAll(/qzMarkTyped\(([^;]*?)\);/g)].map(m => m[1]).filter(a => /qzImpliedOn/.test(a));
    expect(calls.length).toBeGreaterThanOrEqual(2); calls.forEach(c => expect(c).toMatch(/qzMarkOpts/));
    expect(serverSrc).toMatch(/qzMarkTyped\(q, answers\[q\.id\], qzMarksOf\(quiz, q\), qzImpliedOn\(quiz\), qzMarkOpts\(quiz\)\)/);
  });
  test('a learner can save a photo-only answer and the attempt is not sent to auto-marking', () => {
    expect(cut('function qzSaveAnswer(', 'function qzNext(')).toMatch(/qzHasPending\(\)/);
    expect(cut('function qzFinish(', 'function qzTick(')).toMatch(/!qzHasPhotos\(a\)/);
  });
});
