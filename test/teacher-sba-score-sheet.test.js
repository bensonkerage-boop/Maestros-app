// Teacher dashboard > Examinations has an SBA SCORE SHEET card next to Enter Marks, and a Teacher login only sees
// the subjects / grades / streams it teaches on that sheet.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');

function fnSource(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}

test('the card sits right after Enter Marks and opens the score sheet view', () => {
  const hub = fnSource('renderTeacherExaminations');
  const enter = hub.indexOf('Enter Marks</div>'), sba = hub.indexOf('SBA SCORE SHEET</div>'), analysis = hub.indexOf('Analysis Reports</div>');
  expect(enter).toBeGreaterThan(-1); expect(sba).toBeGreaterThan(enter); expect(sba).toBeLessThan(analysis);
  expect(hub).toMatch(/setTeacherExamView\('scoreSheet'\)/);
  expect(hub).toMatch(/teacherExamView === 'scoreSheet'[\s\S]*renderScoreSheetTab\(\)/);
});

function world(role, rec, classAssign) {
  const ctx = {
    currentUserRole: role,
    currentTeacherRecord: () => rec,
    teacherSubjectClassSubjects: () => classAssign.map,
    classesList: classAssign.classes,
    CURRICULUM_GRADES: ['Grade 10', 'Grade 11', 'Grade 12'],
    CBC_SS_PATHWAYS: [{ key: 'stem', label: 'STEM', subjects: ['Mathematics', 'Biology', 'Physics'] }, { key: 'social', label: 'Social', subjects: ['History', 'Geography'] }],
    scoreSheet: { pathway: '', subject: '', task: '', entryGrade: 'Grade 10', entryStream: '' },
  };
  vm.createContext(ctx);
  ['scoreSheetTeacherScope', 'scoreSheetPathways', 'scoreSheetSubjectList', 'scoreSheetGradeList', 'scoreSheetClampToTeacher', 'scoreSheetTeacherFilter']
    .forEach(n => vm.runInContext(fnSource(n), ctx));
  return ctx;
}
const classes = [{ grade: 'Grade 10', stream: 'East' }, { grade: 'Grade 11', stream: 'West' }];

test('teacher sees only own subjects, pathways, grades and streams', () => {
  const c = world('Teacher', { subjects: ['Mathematics'] }, { classes, map: { 0: ['Mathematics'], 1: ['Physics'] } });
  expect(c.scoreSheetPathways().map(p => p.key)).toEqual(['stem']);                                   // Social has nothing of theirs
  expect(c.scoreSheetSubjectList(c.CBC_SS_PATHWAYS[0])).toEqual(['Mathematics', 'Physics']);          // record + class assignment
  expect(c.scoreSheetGradeList()).toEqual(['Grade 10', 'Grade 11']);                                   // no Grade 12
  const learners = [{ stream: 'East' }, { stream: 'West' }, { stream: 'North' }];
  c.scoreSheet.entryGrade = 'Grade 10';
  expect(c.scoreSheetTeacherFilter(learners)).toEqual([{ stream: 'East' }]);                           // only the stream they teach
});

test('leftover choices from another login are cleared; admins see everything', () => {
  const c = world('Teacher', { subjects: ['Mathematics'] }, { classes, map: { 0: ['Mathematics'] } });
  Object.assign(c.scoreSheet, { pathway: 'social', subject: 'History', entryGrade: 'Grade 12' });
  c.scoreSheetClampToTeacher();
  expect(c.scoreSheet).toMatchObject({ pathway: '', subject: '', entryGrade: 'Grade 10' });
  const a = world('Administrator', null, { classes, map: {} });
  expect(a.scoreSheetPathways().length).toBe(2); expect(a.scoreSheetGradeList().length).toBe(3);
  expect(a.scoreSheetTeacherFilter([{ stream: 'x' }, { stream: 'y' }]).length).toBe(2);
});

test('a teacher with no subjects gets a clear message instead of an open sheet', () => {
  expect(fnSource('renderScoreSheetTab')).toMatch(/haven't been assigned any subjects/);
});
