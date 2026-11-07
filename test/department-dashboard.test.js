// Department heads see their department; club patrons see ONLY their own clubs.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
const T = (f, s, resp, dept) => ({ firstName: f, surname: s, otherNames: '', responsibility: resp, department: dept, subjects: [], phone: '' });
function sandbox(user, role) {
  const ctx = {
    currentUserName: user, currentUserRole: role || 'Teacher',
    teachersList: [T('Cora', 'Head', 'Head of Department', ['Co-curricular']), T('Sam', 'Soccer', 'Teacher', []), T('Dina', 'Drama', 'Teacher', []), T('Pat', 'Plain', 'Teacher', [])],
    clubs: ['Football', 'Drama', 'Debate'],
    clubMembers: { Football: [{ admissionNumber: '1', status: 'Active' }], Drama: [{ admissionNumber: '2', status: 'Active' }] },
    clubPatrons: { Football: 'Sam Soccer', Drama: 'Dina Drama' },
    clubAttendance: {}, clubAttendanceSaved: {}, students: [{ admissionNumber: '1' }, { admissionNumber: '2' }],
    teacherFullName: t => `${t.firstName} ${t.surname}`, tNameEq: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    tEsc: v => String(v ?? ''), upperStr: v => String(v).toUpperCase(), fullName: s => 'S' + s.admissionNumber,
    cocurricularRosterRows: c => (ctx.clubMembers[c] || []).map(m => ({ admissionNumber: m.admissionNumber, name: 'Learner of ' + c, grade: '', stream: '', position: '', status: m.status })),
    examTerms: [], boardingDorms: [], boardingAllocations: [], transportRoutes: [],
    studentsForSubject: () => [], studentsForGrade: () => [], getMaxMarks: () => 100, combinedSubjectMark: () => undefined,
  };
  vm.createContext(ctx);
  const names = ['currentTeacherRecord', 'myHeadedDepartments', 'deptTeachers', 'deptDate', 'deptStat', 'deptTable', 'deptPanel', 'clubActiveMembers', 'clubAttendanceStats', 'clubSummaryRows',
    'renderCocurricularHeadPanel', 'renderPatronClubsPanel', 'deptStaffTable', 'deptLatestExamAverages', 'renderAcademicDeptPanel', 'renderBoardingDeptPanel', 'renderTransportDeptPanel',
    'renderExaminationsDeptPanel', 'renderDepartmentPanel', 'renderDepartmentAndClubPanels', 'teacherCocurricularClubs'];
  vm.runInContext(names.map(fnSrc).join('\n') + '\nconst CLUB_TABLE_HEADERS=["A"];const ACADEMIC_DEPARTMENTS=[];', ctx);
  return ctx;
}
const panels = (u, r) => sandbox(u, r).renderDepartmentAndClubPanels();

test('Co-curricular head sees every club', () => {
  const h = panels('Cora Head');
  expect(h).toMatch(/Co-curricular Department/);
  expect(h).toMatch(/Football/); expect(h).toMatch(/Drama/); expect(h).toMatch(/Debate/);
});
test('a patron sees only their own club', () => {
  const f = panels('Sam Soccer');
  expect(f).toMatch(/My Clubs/); expect(f).toMatch(/Football/);
  expect(f).not.toMatch(/Drama/); expect(f).not.toMatch(/Debate/); expect(f).not.toMatch(/Department/);
  const d = panels('Dina Drama');
  expect(d).toMatch(/Drama/); expect(d).not.toMatch(/Football/);
});
test('an ordinary teacher gets no department or club panel', () => {
  expect(panels('Pat Plain')).toBe('');
});
test('the dashboards show the panels', () => {
  expect(src).toMatch(/\$\{renderDepartmentAndClubPanels\(\)\}\n\s*\$\{renderAdminOverviewDashboard\(false, false, false\)\}/);
  expect(src).toMatch(/currentUserRole === "HOD"\) \? renderDepartmentAndClubPanels\(\)/);
});
