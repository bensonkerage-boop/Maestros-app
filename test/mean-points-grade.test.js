// Grades for mean points come from the MEAN POINTS (rounded half-up), not from mean marks.
// Runs the REAL functions out of the app source in a vm sandbox.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
const cbe = [['EE1',8],['EE2',7],['ME1',6],['ME2',5],['AE1',4],['AE2',3],['BE1',2],['BE2',1]];
const kcse = [['A',12],['A-',11],['B+',10],['B',9],['B-',8],['C+',7],['C',6],['C-',5],['D+',4],['D',3],['D-',2],['E',1]];
const mk = list => ({ bands: [...list.map(([grade, points], i) => ({ low: 100 - i * 10, high: 100, grade, points })), { low: -1, high: -1, grade: 'X', points: 0 }] });
const ctx = { gradingSystems: [{ name: 'CBE', ...mk(cbe) }, { name: 'KCSE', ...mk(kcse) }], isEight44Grade: g => /form/i.test(g) };
vm.createContext(ctx);
vm.runInContext(fnSrc('gradingSystemCurriculum') + fnSrc('gradingSystemForGrade') + fnSrc('gradeFromMeanPoints'), ctx);
const g = (p, label) => ctx.gradeFromMeanPoints(p, label);

test('CBC: 5.5 and above is ME1 (6), below 5.5 is ME2 (5)', () => {
  expect(g(5.5, 'Grade 8')).toBe('ME1');
  expect(g(5.6, 'Grade 8')).toBe('ME1');
  expect(g(6.49, 'Grade 8')).toBe('ME1');
  expect(g(6.5, 'Grade 8')).toBe('EE2');
  expect(g(5.49, 'Grade 8')).toBe('ME2');
  expect(g(4.5, 'Grade 8')).toBe('ME2');
  expect(g(4.49, 'Grade 8')).toBe('AE1');
});
test('float noise does not flip a displayed 5.5', () => {
  expect(g(5.499999999, 'Grade 8')).toBe('ME1');
  expect(g(0.1 + 0.2 + 5.2, 'Grade 8')).toBe('ME1');   // 5.5000000000000004 style sums
});
test('ends of the scale and 8-4-4', () => {
  expect(g(8, 'Grade 8')).toBe('EE1');
  expect(g(1, 'Grade 8')).toBe('BE2');
  expect(g(0.2, 'Grade 8')).toBe('BE2');
  expect(g(11.5, 'Form 4')).toBe('A');
  expect(g(11.49, 'Form 4')).toBe('A-');
  expect(g(5.5, 'Form 4')).toBe('C');
});
test('no figure gives a dash, not a grade', () => {
  expect(g(NaN, 'Grade 8')).toBe('-');
});
test('no mean grade is derived from mean marks any more (merit list + analysis)', () => {
  expect(src).not.toMatch(/meanGrade[^\n]*scoreToGrade\(Math\.round\((?:mean|meanMarks|r\.mean)/);
  expect(src).not.toMatch(/performanceLevelForGrade\([^\n]*scoreToGrade\(Math\.round\(/);
});
test('Exam Analysis pages grade a Form on the KCSE scale (not the first configured system)', () => {
  // only the "compose results" band picker may still use gradingSystems[0]
  expect(src.match(/const gs = gradingSystems\[0\];\n\s*const bandOrder/g) || []).toHaveLength(1);
  expect(src).not.toMatch(/scoreToGrade\(pct\)/);
  expect(src).not.toMatch(/gradeFromMeanPoints\([A-Za-z.]*\)/);   // always pass the class so Forms use KCSE
});
