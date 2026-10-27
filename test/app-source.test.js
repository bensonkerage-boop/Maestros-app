const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('every inline script parses', () => { scripts.forEach(s => expect(() => new vm.Script(s)).not.toThrow()); });

describe('regressions fixed from the error scan', () => {
  test('Compose > Specific Classes uses a grade list that exists globally', () => {
    expect(src).not.toMatch(/\$\{GRADES\.map\(g => `<option value="\$\{g\}" \$\{g===composeClassGrade/);
    expect(src).toMatch(/GRADE_OPTIONS\.map\(g => `<option value="\$\{g\}" \$\{g===composeClassGrade/);
  });
  test('loadSchoolData backfills missing fields from the empty dataset', () => {
    const body = src.slice(src.indexOf('function loadSchoolData'), src.indexOf('function loadSchoolData') + 900);
    expect(body).toMatch(/emptySchoolDataset\(\)/);
    expect(body).toMatch(/=== undefined/);
  });
  test('no global identifier is used that is never defined (eslint no-undef)', () => {
    const { ESLint } = require('eslint');
    const globals = Object.fromEntries('window document navigator localStorage sessionStorage console setTimeout clearTimeout setInterval clearInterval fetch alert confirm prompt URL Blob FileReader Image Event CustomEvent MutationObserver NodeFilter requestAnimationFrame cancelAnimationFrame XLSX ExcelJS jspdf html2canvas QRCode location history performance Intl FormData URLSearchParams AbortController crypto btoa atob Notification matchMedia getComputedStyle XMLHttpRequest HTMLElement Element Node DOMParser TextEncoder TextDecoder structuredClone queueMicrotask indexedDB screen print speechSynthesis WebSocket BroadcastChannel ResizeObserver IntersectionObserver CSS File FileList Option aiGenRemark'.split(' ').map(k => [k, 'readonly']));
    const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals }, rules: { 'no-undef': 'error', 'no-dupe-keys': 'error' } }] });
    return eslint.lintText(scripts.join('\n')).then(([r]) => {
      expect(r.messages.map(m => `${m.line}: ${m.message}`)).toEqual([]);
    });
  });
});

test('build output: smaller page, images extracted, scripts valid, sync + dark mode included', () => {
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'build.js')], { stdio: 'pipe' });
  const out = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  expect(out.length).toBeLessThan(src.length * 0.8);
  expect(fs.readdirSync(path.join(__dirname, '..', 'public', 'assets')).filter(f => /^img-/.test(f)).length).toBeGreaterThanOrEqual(4);
  expect(out).toContain('/assets/cloud-sync.js');
  expect(out).toContain('window.MASMS_LOCAL');
  expect(out.indexOf('window.MASMS_LOCAL=')).toBeLessThan(out.indexOf('/assets/cloud-sync.js'));
  expect(out).toContain('masmsThemeBtn');
  [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m => expect(() => new vm.Script(m[1])).not.toThrow());
});

describe('clean start: no built-in teachers or learners', () => {
  test('no demo teachers, invoices or learner seed call', () => {
    expect(src).toMatch(/let teachersList = \[\];/);
    expect(src).toMatch(/const invoices = \[\];/);
    expect(src).not.toMatch(/^seedGrade10Registrations\(\);/m);
    expect(src).not.toMatch(/"surname": "(Mwangi|Achieng)"/);
  });
  test('Settings has a guarded "Clear teachers & learners" action', () => {
    expect(src).toMatch(/onclick="clearTeachersAndLearners\(\)"/);
    const fn = src.slice(src.indexOf('function clearTeachersAndLearners'), src.indexOf('function renderSettingsBackupTab'));
    expect(fn).toMatch(/prompt\('Type CLEAR/);
    expect(fn.indexOf('backupData()')).toBeGreaterThan(fn.indexOf("typed !== 'CLEAR'"));
  });
});

test('no demo exams or marks are seeded at startup', () => {
  ['seedTerm3Exam2026', 'seedTerm3OpenerGrade10', 'seedForm4MidExam', 'restructureStreamsAndReseedMarks', 'seedGrade10OpenerSampleMarks']
    .forEach(f => { if (f !== 'seedGrade10OpenerSampleMarks') expect(src).not.toMatch(new RegExp('^' + f + '\\(\\);', 'm')); });
});

test('Academics landing has only CBC and 8-4-4; the other cards live inside them', () => {
  const fn = src.slice(src.indexOf('function renderAcademicsPage'), src.indexOf('function renderStudentsPage'));
  const landing = fn.slice(fn.indexOf('// Landing'), fn.indexOf('// Inside CBC'));
  expect(landing).toMatch(/setAcademicsParent\('cbc'\)/);
  expect(landing).toMatch(/setAcademicsParent\('844'\)/);
  expect(landing).not.toMatch(/Calendar|Disciplinary|Lesson Sharing/);
  expect(fn.slice(fn.indexOf('// Inside CBC'))).toMatch(/sharedCards\(\)/);
});

test('8-4-4 views offer Form 4 only (no Grade 10-12)', () => {
  expect(src).toMatch(/academicsParent === '844' \? \["Form 4"\] : academicsParent === 'cbc'/);
  expect(src).toMatch(/function curriculumDesignGrades\(\)/);
  expect(src).toMatch(/curriculumDesignGrades\(\)\.map\(g => opt\(g, curriculumSel\.grade\)\)/);
});

test('CBC views never list Form 4 in Lesson Sharing', () => {
  expect(src).toMatch(/academicsParent === 'cbc' \? \["Grade 10","Grade 11","Grade 12"\]/);
  expect(src).toMatch(/academicsParent === 'cbc' \? CBC_GRADE_OPTIONS/);
});

describe('plain class list layout', () => {
  test('class & stream lists use S\\NO … DOB columns and a plain PDF/print layout', () => {
    expect(src).toMatch(/const columns = \['S\\\\NO', \.\.\.defs/);
    expect(src).toMatch(/key:'dob', label:'DOB'/);
    expect(src).toMatch(/if\(data\.roster\) return triggerPlainClassListPdf/);
    expect(src).toMatch(/if\(d\.roster\)\{ printPlainClassList/);
  });
  test('title line is "<CLASS> CLASS LIST-<year>" and teacher line is "CLASS TEACHER:"', () => {
    const fnSrc = src.slice(src.indexOf('function classListPlainHead'), src.indexOf('function classListPlainRows'));
    const classListPlainHead = new Function(fnSrc + '; return classListPlainHead;')();
    expect(classListPlainHead({ heading: 'GRADE 10 NORTH Class List', yearLine: 'Year: 2026', teacherLine: 'Class Teacher: Not assigned' }))
      .toEqual({ title: 'GRADE 10 NORTH CLASS LIST-2026', teacher: 'CLASS TEACHER:' });
    expect(classListPlainHead({ heading: 'North Stream Class List', yearLine: 'Year: 2026', teacherLine: 'Class Teacher: Mary Wanjiku, Paul Kamau' }))
      .toEqual({ title: 'NORTH STREAM CLASS LIST-2026', teacher: 'CLASS TEACHER: MARY WANJIKU, PAUL KAMAU' });
  });
});

test('a class can be created without a stream', () => {
  const fn = src.slice(src.indexOf('function submitClass'), src.indexOf('// Sub-toolbar inside the Students section'));
  expect(fn).not.toMatch(/!classFormData\.stream\)/);
  expect(src).toMatch(/<option value="" \$\{!classFormData\.stream\?'selected':''\}>No stream<\/option>/);
});

describe('staff can log in with their phone number', () => {
  test('login matches a staff phone on its last 9 digits; the password is checked by userPasswordOk (welcome or own)', () => {
    expect(src).toMatch(/function loginPhoneKey\(v\)[\s\S]*slice\(-9\)/);
    expect(src).toMatch(/loginPhoneKey\(staffPhoneForUser\(u\)\) === _phoneKey\)\) &&\s*userPasswordOk\(u, passwordRaw\)/);
    expect(src).toContain('placeholder="First name or phone number"');
  });
});

describe('Kenyan Sign Language is an elective, not compulsory', () => {
  const vm2 = require('vm');
  const grab = name => { const m = src.match(new RegExp('const ' + name + ' = \\[[\\s\\S]*?\\];')); expect(m).toBeTruthy(); return vm2.runInNewContext('(function(){' + m[0] + ' return ' + name + ';})()'); };
  test('not in the compulsory lists', () => {
    expect(grab('CBC_SS_CORE')).not.toContain('Kenyan Sign Language');
    expect(grab('EXAM_COMPULSORY_SUBJECTS')).not.toContain('Kenyan Sign Language');
    expect(src).not.toMatch(/compulsorySubjectsFor[\s\S]{0,400}Kenyan Sign Language/);
  });
  test('offered as an elective to every pathway', () => {
    expect(grab('CBC_SS_OPTIONAL_ALL_PATHWAYS')).toEqual(['Kenyan Sign Language']);
    expect(src).toMatch(/pathwayObj\.subjects\.filter[\s\S]{0,200}\.\.\.CBC_SS_OPTIONAL_ALL_PATHWAYS/);
    expect(src).toMatch(/\.\.\.CBC_SS_OPTIONAL_ALL_PATHWAYS\]\)\];/);
  });
});

test('module title bar shows only the module name (no descriptive note after it)', () => {
  expect(src).not.toMatch(/<span class="subbar-note">\$\{activeItem\.note/);
});
