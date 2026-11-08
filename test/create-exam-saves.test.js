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
