/** @jest-environment jsdom */
// The cloud button opens an account panel; admins get user management, the platform owner gets the schools list.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup(me) {
  jest.useFakeTimers();
  localStorage.clear(); localStorage.setItem('masmsCloudToken', 't'); localStorage.setItem('masmsCloudTenant', me.tenant);
  window.fetch = jest.fn((url, opt) => {
    const m = (opt && opt.method) || 'GET', ok = j => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(j) });
    if (/\/auth\/me$/.test(url)) return ok(me);
    if (/\/data\/version$/.test(url)) return ok({ version: 1 });
    if (/\/data$/.test(url) && m === 'GET') return ok({ version: 1, data: { schools: ['A'], currentSchool: 'A', schoolProfiles: {}, schoolData: { A: { students: [] } } } });
    if (/\/users(\?.*)?$/.test(url)) return ok({ tenant: me.tenant, users: [{ username: me.username, role: 'admin' }, { username: 't1', role: 'staff' }] });
    if (/\/schools$/.test(url)) return ok({ schools: [{ code: 'a', name: 'School A', active: true, users: 2, lastSaved: null }] });
    return ok({});
  });
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', schoolData={A:{students:[]}};
    function collectBackupData(){ return {_meta:{},schools,currentSchool,schoolProfiles,schoolData}; }
    function loadSchoolData(){} function applyPlatformData(){} function render(){}
  `);
  window.eval(read('local-store.js')); window.eval(read('cloud-sync.js'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
}
afterEach(() => { jest.useRealTimers(); document.body.innerHTML = ''; });
const texts = () => [...document.querySelectorAll('button')].map(b => b.textContent);

test('staff see only change-password and sign-out', async () => {
  setup({ username: 'teach', role: 'staff', tenant: 'a', tenantName: 'School A', platform: false });
  await jest.advanceTimersByTimeAsync(10); await flush();
  window.MASMS_CLOUD.click();
  expect(document.body.textContent).toMatch(/School A/);
  expect(texts()).toEqual(expect.arrayContaining(['Sync now', 'Change my password', 'Sign out']));
  expect(texts()).not.toContain('Users of this school'); expect(texts()).not.toContain('All schools');
});

test('school admin can open the users list; platform owner also gets All schools', async () => {
  setup({ username: 'boss', role: 'admin', tenant: 'a', tenantName: 'School A', platform: true });
  await jest.advanceTimersByTimeAsync(10); await flush();
  window.MASMS_CLOUD.click();
  expect(texts()).toEqual(expect.arrayContaining(['Users of this school', 'All schools']));
  [...document.querySelectorAll('button')].find(b => b.textContent === 'All schools').click(); await flush();
  expect(document.body.textContent).toMatch(/Schools on this server/); expect(document.body.textContent).toMatch(/School A/);
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Users').click(); await flush();
  expect(document.body.textContent).toMatch(/Reset password/); expect(document.body.textContent).toMatch(/t1/);
});
