/** @jest-environment jsdom */
// A device signed in to the cloud picks up data that another device saved, and asks before replacing its own unsaved changes.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup() {
  jest.useFakeTimers();
  localStorage.clear(); localStorage.setItem('masmsCloudToken', 't');
  const cloud = { version: 1, by: 'admin', data: { schools: ['A'], currentSchool: 'A', schoolProfiles: {}, schoolData: { A: { students: [{ n: 'Old' }] } } } };
  const calls = { put: 0, dataGet: 0 };
  window.fetch = jest.fn((url, opt) => {
    const m = (opt && opt.method) || 'GET', ok = (j, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(j) });
    if (/\/auth\/me$/.test(url)) return ok({ username: 'me', role: 'admin', tenant: 'school-a', tenantName: 'School A', platform: false });
    if (/\/data\/version$/.test(url)) return ok({ version: cloud.version, updatedBy: cloud.by });
    if (/\/data$/.test(url) && m === 'GET') { calls.dataGet++; return ok({ version: cloud.version, updatedBy: cloud.by, data: cloud.data }); }
    if (/\/data$/.test(url) && m === 'PUT') {
      const body = JSON.parse(opt.body);
      if (body.baseVersion !== cloud.version) return ok({ error: 'conflict' }, 409);
      calls.put++; cloud.version++; cloud.data = body.data; cloud.by = 'me'; return ok({ version: cloud.version });
    }
    return ok({});
  });
  window.confirm = jest.fn(() => true);
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', schoolData={A:{students:[]}}, students=schoolData.A.students;
    function collectBackupData(){ schoolData.A.students=students; return {_meta:{exportedAt:new Date().toISOString()},schools,currentSchool,schoolProfiles,schoolData}; }
    function loadSchoolData(s){ students=schoolData[s].students; } function applyPlatformData(){} function render(){}
  `);
  window.eval(read('local-store.js')); window.eval(read('cloud-sync.js'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  const names = () => window.eval('students.map(s=>s.n).join(",")');
  return { cloud, calls, names };
}
afterEach(() => { jest.useRealTimers(); });

test('loads cloud data on start, then picks up another device\'s save without any local change', async () => {
  const t = setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  expect(t.names()).toBe('Old');
  t.cloud.version = 2; t.cloud.by = 'teacher2'; t.cloud.data = { ...t.cloud.data, schoolData: { A: { students: [{ n: 'Old' }, { n: 'FromOtherDevice' }] } } };
  await jest.advanceTimersByTimeAsync(15000); await flush();
  expect(t.names()).toBe('Old,FromOtherDevice');
  expect(window.confirm).not.toHaveBeenCalled();                 // nothing of ours was at risk, so no prompt
  expect(t.calls.put).toBe(0);                                    // and we did not upload the just-downloaded copy
});

test('does not redraw while the person is typing, then updates once they stop', async () => {
  const t = setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  const input = document.createElement('input'); document.body.appendChild(input); input.focus();
  t.cloud.version = 2; t.cloud.data = { ...t.cloud.data, schoolData: { A: { students: [{ n: 'New' }] } } };
  await jest.advanceTimersByTimeAsync(15000); await flush();
  expect(t.names()).toBe('Old');
  input.blur();
  await jest.advanceTimersByTimeAsync(15000); await flush();
  expect(t.names()).toBe('New');
});

test('both devices changed: asks, and "keep mine" overwrites the cloud while "use cloud" replaces this device', async () => {
  let t = setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  window.eval(`students.push({n:'Mine'}); render();`);          // unsaved local change...
  t.cloud.version = 2; t.cloud.by = 'teacher2'; t.cloud.data = { ...t.cloud.data, schoolData: { A: { students: [{ n: 'Theirs' }] } } };   // ...and another device saved first
  window.confirm.mockReturnValueOnce(false);                       // keep this device's data
  await jest.advanceTimersByTimeAsync(15000); await flush();
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(window.confirm.mock.calls[0][0]).toMatch(/teacher2/);
  await jest.advanceTimersByTimeAsync(10000); await flush();
  expect(t.cloud.data.schoolData.A.students.map(s => s.n)).toEqual(['Old', 'Mine']);   // cloud now holds this device's data
  expect(t.calls.put).toBeGreaterThanOrEqual(1);

  t = setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  window.eval(`students.push({n:'Mine'}); render();`);
  t.cloud.version = 2; t.cloud.data = { ...t.cloud.data, schoolData: { A: { students: [{ n: 'Theirs' }] } } };
  window.confirm.mockReturnValueOnce(true);                        // use the cloud copy
  await jest.advanceTimersByTimeAsync(15000); await flush();
  expect(t.names()).toBe('Theirs');
});

test('a different school signing in on the same device wipes the earlier school\'s local data first', async () => {
  const t = setup();
  localStorage.setItem('masmsCloudTenant', 'some-other-school');
  const wipe = jest.fn(() => Promise.resolve());
  window.MASMS_LOCAL.wipe = wipe;
  const reload = jest.fn();
  try { Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true }); } catch (e) { /* jsdom: reload is a no-op */ }
  await jest.advanceTimersByTimeAsync(10); await flush();
  expect(wipe).toHaveBeenCalledTimes(1);                      // the other school's copy is removed ...
  expect(localStorage.getItem('masmsCloudTenant')).toBe('school-a');
  expect(t.calls.put).toBe(0);                                // ... and never uploaded into this school's account
});
