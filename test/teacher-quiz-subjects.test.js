// A Teacher can post online quizzes only for the subjects they teach. The list is worked out live from the school's subject-teacher
// assignments (classSubjectTeachers), so it follows the administrator's changes by itself and is never a separate copy.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const code = [
  cut('function tNameEq(', 'function teacherIsClassTeacher('),
  cut('function teacherSubjectClassSubjects(', 'function teacherClassTeacherIdx('),
  cut('function currentTeacherRecord(', '// Classes (grade+stream) where the logged-in teacher'),
  cut('function classSubjectTeacherKey(', 'function setClassSubjectTeacher('),
  cut('function qzIsTeacher(', 'function qzExamsFor('),
  cut('function qzType(', 'function qzNorm('),
  cut('function qzValidate(', '// Students open quizzes on their own phones'),
].join('\n');
const make = (role, name) => {
  const ctx = { currentUserRole: role, currentUserName: name, teacherFullName: t => t.firstName + ' ' + t.surname,
    classesList: [
      { grade: 'Grade 8', stream: 'A', teacher: 'X', subjects: ['Mathematics', 'English', 'Science'] },
      { grade: 'Grade 8', stream: 'B', teacher: 'Y', subjects: ['Mathematics', 'English', 'Science'] },
      { grade: 'Grade 9', stream: '', teacher: 'Z', subjects: ['Mathematics', 'Kiswahili'] }],
    classSubjectTeachers: { '0::Mathematics': 'Jane Kamau', '1::Mathematics': 'Jane Kamau', '0::English': 'Peter Otieno', '2::Mathematics': 'Jane Kamau' },
    teachersList: [{ firstName: 'Jane', surname: 'Kamau', subjects: ['Mathematics'] }, { firstName: 'Mary', surname: 'Wanjiru', subjects: ['Kiswahili'] }] };
  vm.createContext(ctx); vm.runInContext(code + ';this.f={qzTeacherScope,qzScopeOk,qzGrades,qzStreams,qzSubjects,qzCanEdit,qzValidate};', ctx); return ctx;
};
const quiz = (grade, stream, subject) => ({ title: 'T', grade, stream, subject, minutes: 10, type: 'mcq', questions: [{ text: 'Q', options: ['a', 'b', 'c', 'd'], answer: 0 }] });

test('a teacher is offered only the classes, streams and subjects assigned to them', () => {
  const { f } = make('Teacher', 'Jane Kamau');
  expect(f.qzGrades().sort()).toEqual(['Grade 8', 'Grade 9']);
  expect(f.qzStreams('Grade 8').sort()).toEqual(['A', 'B']);
  expect(f.qzSubjects('Grade 8', 'A')).toEqual(['Mathematics']);       // English in 8A belongs to Peter
  expect(f.qzSubjects('Grade 8', '')).toEqual(['Mathematics']);        // she teaches Maths in every Grade 8 stream
  expect(f.qzSubjects('Grade 9', '')).toEqual(['Mathematics']);
});
test('a quiz for a subject someone else teaches is refused, saved or published', () => {
  const { f } = make('Teacher', 'Jane Kamau');
  expect(f.qzValidate(quiz('Grade 8', 'A', 'English'))).toMatch(/only for the subjects you teach/);
  expect(f.qzValidate(quiz('Grade 8', 'A', 'Mathematics'))).toBe('');
  expect(f.qzCanEdit(quiz('Grade 8', 'A', 'Science'))).toBe(false);
});
test('a teacher assigned to only one stream cannot post to the whole grade', () => {
  const { f } = make('Teacher', 'Peter Otieno');
  expect(f.qzScopeOk(quiz('Grade 8', 'A', 'English'))).toBe(true);
  expect(f.qzScopeOk(quiz('Grade 8', 'B', 'English'))).toBe(false);
  expect(f.qzScopeOk(quiz('Grade 8', '', 'English'))).toBe(false);
});
test('subjects stay in sync: reassigning a subject changes the teacher\'s list at once, with nothing to copy', () => {
  const c = make('Teacher', 'Peter Otieno');
  expect(c.f.qzScopeOk(quiz('Grade 8', 'B', 'English'))).toBe(false);
  c.classSubjectTeachers['1::English'] = 'Peter Otieno';                // the administrator assigns 8B English too
  expect(c.f.qzScopeOk(quiz('Grade 8', '', 'English'))).toBe(true);     // now he has every Grade 8 stream
  expect(c.f.qzScopeOk(quiz('Grade 8', 'B', 'English'))).toBe(true);
  delete c.classSubjectTeachers['0::English'];                          // and takes 8A away
  expect(c.f.qzScopeOk(quiz('Grade 8', 'A', 'English'))).toBe(false);
});
test('a subject listed on the teacher\'s record counts where the class has no assigned subject teacher', () => {
  const { f } = make('Teacher', 'Mary Wanjiru');
  expect(f.qzScopeOk(quiz('Grade 9', '', 'Kiswahili'))).toBe(true);
  expect(f.qzScopeOk(quiz('Grade 9', '', 'Mathematics'))).toBe(false);
});
test('a teacher with no assignment has nothing to post; other roles are not restricted', () => {
  expect(make('Teacher', 'Nobody Here').f.qzGrades()).toEqual([]);
  const a = make('Administrator', 'Admin').f;
  expect(a.qzGrades().sort()).toEqual(['Grade 8', 'Grade 9']);
  expect(a.qzSubjects('Grade 8')).toEqual(['Mathematics', 'English', 'Science']);
  expect(a.qzValidate(quiz('Grade 8', 'A', 'English'))).toBe('');
});
test('the screens use the scope: stream change re-filters subjects, lists hide others\' quizzes, locked rows lose their buttons', () => {
  expect(src).toMatch(/onchange="qzSetStream\(this\.value\)"/);
  expect(src).toMatch(/qzSubjects\(q\.grade, q\.stream\)/);
  expect(src).toMatch(/qzScopeOk\(q\) \|\| tNameEq\(q\.createdBy, currentUserName\)/);
  expect(src).toMatch(/No longer your subject/);
});
