// "Add Exam" must actually store the exam in examTerms (it used to only store max marks, so the exam vanished).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const i = src.indexOf('function submitCreateExam(');
const body = src.slice(i, src.indexOf('function examYearOptions', i));
test('submitCreateExam writes the exam group into examTerms', () => {
  expect(body).toMatch(/examTerms\.unshift\(termBlock\)/);
  expect(body).toMatch(/termBlock\.groups\.unshift\(\{ exam: name, rows, subjects:/);
});
test('submitCreateExam tells the user when something is missing and blocks duplicates', () => {
  expect(body).toMatch(/alert\("Please enter or choose the Exam Name\."\)/);
  expect(body).toMatch(/already exists in/);
});

// Online quizzes: Save / Save & Publish must always give visible feedback, and the test window (open/close time) is enforced.
const qsrc = src.slice(src.indexOf('function qzWindowStart('), src.indexOf('function qzStudentsOf('));
test('quiz window helpers: opens at start time, closes at end time', () => {
  const vm = require('vm');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(qsrc + ';this.f={qzWindowStart,qzDueEnd,qzIsClosed,qzNotOpenYet,qzTimeLabel};', ctx);
  const q = { dueISO:'2030-05-01', startTime:'18:30', endTime:'20:00' };
  expect(ctx.f.qzWindowStart(q)).toBe(new Date('2030-05-01T18:30:00').getTime());
  expect(ctx.f.qzDueEnd(q)).toBe(new Date('2030-05-01T20:00:00').getTime());
  expect(ctx.f.qzNotOpenYet(q)).toBe(true);
  expect(ctx.f.qzIsClosed({ dueISO:'2001-01-01', endTime:'20:00' })).toBe(true);
  expect(ctx.f.qzIsClosed({ dueISO:'' })).toBe(false);
  expect(ctx.f.qzTimeLabel('18:30')).toBe('6:30 PM');
  expect(ctx.f.qzTimeLabel('20:00')).toBe('8:00 PM');
});
test('qzSave reports validation errors visibly instead of failing silently', () => {
  const b = src.slice(src.indexOf('function qzSave('), src.indexOf('// ---------- Import questions'));
  expect(b).toMatch(/alert\(msg\)/);
  expect(b).toMatch(/catch\(err\)/);
});
