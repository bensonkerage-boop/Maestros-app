/** @jest-environment jsdom */
// cloud-sync's 20s timer must not serialize the dataset while nothing changed, and must still retry after a failed upload.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup() {
  jest.useFakeTimers();
  localStorage.clear(); localStorage.setItem('masmsCloudToken', 't');
  const calls = { put: 0, get: 0 }; let failPut = false;
  window.fetch = jest.fn((url, opt) => {
    const m = (opt && opt.method) || 'GET', ok = (j, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(j) });
    if (/\/data$/.test(url) && m === 'GET') { calls.get++; return ok({ version: 0, data: null }); }
    if (/\/data$/.test(url) && m === 'PUT') { calls.put++; return failPut ? ok({ error: 'down' }, 500) : ok({ version: calls.put }); }
    return ok({});
  });
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', schoolData={A:{students:[]}}, students=schoolData.A.students, __collects=0;
    function collectBackupData(){ __collects++; schoolData.A.students=students; return {_meta:{exportedAt:new Date().toISOString()},schools,currentSchool,schoolProfiles,schoolData}; }
    function loadSchoolData(){} function applyPlatformData(){} function render(){}
  `);
  window.eval(read('local-store.js')); window.eval(read('cloud-sync.js'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return { calls, setFail: v => { failPut = v; }, collects: () => window.eval('__collects') };
}
afterEach(() => { jest.useRealTimers(); });

test('idle 20s ticks do not serialize; a change uploads once; a failed upload is retried', async () => {
  const t = setup();
  await jest.advanceTimersByTimeAsync(10); await flush();       // start(): load, then first upload (cloud has no data yet)
  expect(t.calls.put).toBe(1);
  await jest.advanceTimersByTimeAsync(6000); await flush();      // let local-store's own first 5s tick run (it shares the counter)
  const base = t.collects();

  await jest.advanceTimersByTimeAsync(20000); await flush();     // idle tick
  await jest.advanceTimersByTimeAsync(20000); await flush();
  expect(t.collects()).toBe(base);                               // nothing serialized
  expect(t.calls.put).toBe(1);

  window.eval(`students.push({name:'New'}); render();`);
  t.setFail(true);
  await jest.advanceTimersByTimeAsync(20000); await flush();
  expect(t.calls.put).toBe(2);                                   // change noticed, upload attempted (and failed)
  t.setFail(false);
  await jest.advanceTimersByTimeAsync(20000); await flush();
  expect(t.calls.put).toBe(3);                                   // retried although nothing else changed
  await jest.advanceTimersByTimeAsync(20000); await flush();
  expect(t.calls.put).toBe(3);                                   // and then quiet again
});
