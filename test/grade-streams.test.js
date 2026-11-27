// Stream is asked for only when the grade has more than one stream; one stream is joined automatically; none = no field.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const a = src.indexOf('function gradeStreamNames('), b = src.indexOf('let readmitIndex');
const make = classes => new Function('classesList', 'regData', src.slice(a, b) + '; return { gradeStreamNames, regSyncStream };');
const classes = [{ grade: 'Grade 10', stream: 'North' }, { grade: 'Grade 10', stream: 'South' }, { grade: 'Grade 11', stream: 'Grade 11' }, { grade: 'Grade 12', stream: '' }];
test('streams per grade', () => {
  const r = {}; const f = make()(classes, r);
  expect(f.gradeStreamNames('Grade 10')).toEqual(['North', 'South']);
  expect(f.gradeStreamNames('Grade 11')).toEqual(['Grade 11']);
  expect(f.gradeStreamNames('Grade 12')).toEqual([]);
});
test('sync: single stream auto, none cleared, several kept only if valid', () => {
  const r = { formGrade: 'Grade 11', stream: '' }; const f = make()(classes, r);
  f.regSyncStream(); expect(r.stream).toBe('Grade 11');
  r.formGrade = 'Grade 12'; f.regSyncStream(); expect(r.stream).toBe('');
  r.formGrade = 'Grade 10'; r.stream = 'North'; f.regSyncStream(); expect(r.stream).toBe('North');
  r.stream = 'East'; f.regSyncStream(); expect(r.stream).toBe('');
});
