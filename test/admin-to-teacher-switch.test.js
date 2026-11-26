// Clicking "Administrator" on the admin dashboard switches to Teacher and opens the teacher dashboard; the Teacher chip switches back.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');

test('the Administrator chip is a button that calls setViewMode("teacher")', () => {
  expect(html).toMatch(/<button type="button" class="hm-link" id="roleChipAdmin"[^>]*onclick="setViewMode\('teacher'\)[^"]*"[^>]*>[^<]*<i class="fa-solid fa-user-shield"><\/i>&nbsp;Administrator<\/button>/);
});
test('the Teacher chip on the teacher dashboard switches back to Administrator', () => {
  expect(html).toMatch(/title="Click to switch back to Administrator" onclick="setViewMode\(previewingAsTeacher\?'admin':'teacher'\)/);
});
test('setViewMode: Administrator -> Teacher dashboard, and back restores the real identity', () => {
  const i = html.indexOf('let previewingAsTeacher'), j = html.indexOf('let classesList', i);
  const ctx = vm.createContext({ currentUserName: 'Jane Admin', currentUserRole: 'Administrator', active: 'students', teachersList: [{ id: 1 }], systemUsers: [], teacherFullName: () => 'Tom Teacher', render() { ctx.renders = (ctx.renders || 0) + 1; } });
  vm.runInContext(html.slice(i, j), ctx);
  vm.runInContext("setViewMode('teacher')", ctx);
  expect(ctx.currentUserRole).toBe('Teacher'); expect(ctx.active).toBe('dashboard'); expect(vm.runInContext('previewingAsTeacher', ctx)).toBe(true); expect(ctx.renders).toBe(1);
  vm.runInContext("setViewMode('admin')", ctx);
  expect(ctx.currentUserRole).toBe('Administrator'); expect(ctx.currentUserName).toBe('Jane Admin'); expect(vm.runInContext('previewingAsTeacher', ctx)).toBe(false);
});
