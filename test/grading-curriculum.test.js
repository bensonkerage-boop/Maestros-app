// Create Grading System has a required Curriculum field (CBC / 8-4-4) that is saved on the system.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
const bands = [{ low: 0, high: 100, grade: 'G', points: 1 }];
function sandbox(systems) {
  const ctx = { gradingSystems: systems, isEight44Grade: g => /^form/i.test(g || '') };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('gradingSystemCurriculum') + fnSrc('gradingSystemForGrade'), ctx);
  return ctx;
}

test('legacy systems without a curriculum are inferred from the name', () => {
  const c = sandbox([]);
  expect(c.gradingSystemCurriculum({ name: 'KCSE' })).toBe('844');
  expect(c.gradingSystemCurriculum({ name: 'My 8-4-4 scale' })).toBe('844');
  expect(c.gradingSystemCurriculum({ name: 'CBE' })).toBe('CBC');
  expect(c.gradingSystemCurriculum({ name: 'Anything', curriculum: '844' })).toBe('844');
});
test('built-in CBE / KCSE still win; custom systems are used when they are gone', () => {
  const both = sandbox([{ name: 'Mine844', curriculum: '844', bands }, { name: 'KCSE', bands }, { name: 'CBE', bands }]);
  expect(both.gradingSystemForGrade('Form 4').name).toBe('KCSE');
  expect(both.gradingSystemForGrade('Grade 10').name).toBe('CBE');
  const custom = sandbox([{ name: 'Mine CBC', curriculum: 'CBC', bands }, { name: 'Mine844', curriculum: '844', bands }]);
  expect(custom.gradingSystemForGrade('Form 4').name).toBe('Mine844');
  expect(custom.gradingSystemForGrade('Grade 10').name).toBe('Mine CBC');
});
test('create form has a curriculum select and the saved system carries it', () => {
  expect(src).toMatch(/id="newGradingSystemCurriculum"[^>]*onchange="setNewGradingSystemCurriculum\(this\.value\)"/);
  expect(src).toMatch(/gradingSystems\.push\(\{ name, curriculum: newGradingSystemCurriculum,/);
  expect(src).toMatch(/\{ name:"CBE", curriculum:"CBC"/);
  expect(src).toMatch(/\{ name:"KCSE", curriculum:"844"/);
});
test('sample scales are filtered by curriculum', () => {
  const ctx = { GRADING_SAMPLE_SYSTEMS: { KCSE: [], 'Old CBC': [], 'New CBC (AL)': [], 'New CBC (EE)': [] } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('gradingSampleNamesFor'), ctx);
  expect(ctx.gradingSampleNamesFor('844')).toEqual(['KCSE']);
  expect(ctx.gradingSampleNamesFor('CBC')).toEqual(['Old CBC', 'New CBC (AL)', 'New CBC (EE)']);
});
