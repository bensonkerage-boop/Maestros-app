/** @jest-environment jsdom */
// An exam released on one device is uploaded at once (no timer wait), and a release arriving from another device is announced.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup(remote) {
  jest.useFakeTimers();
  localStorage.clear(); localStorage.setItem('masmsCloudToken', 't');
  const calls = { put: 0 }; let ver = 1;
  window.fetch = jest.fn((url, opt) => {
    const m = (opt && opt.method) || 'GET', ok = (j, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(j) });
    if (/\/data\/wait/.test(url)) return new Promise(() => {});            // held open
    if (/\/data\/version$/.test(url)) return ok({ version: ver });
    if (/\/data$/.test(url) && m === 'GET') return ok({ version: ver, data: remote() });
    if (/\/data$/.test(url) && m === 'PUT') { calls.put++; ver++; return ok({ version: ver }); }
    return ok({});
  });
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', examTerms=[{term:'Term 1',groups:[{exam:'Mid',rows:[{class:'Grade 7',published:false}]}]}], schoolData={A:{}}, __r=0;
    function collectBackupData(){ return {schools,currentSchool,schoolProfiles,schoolData,examTerms:JSON.parse(JSON.stringify(examTerms))}; }
    function loadSchoolData(){} function applyPlatformData(d){ if(d.examTerms) examTerms=d.examTerms; } function render(){ __r++; }
  `);
  window.eval(read('local-store.js')); window.eval(read('cloud-sync.js'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  calls.bump = () => { ver += 5; };
  return calls;
}
afterEach(() => { jest.useRealTimers(); document.body.innerHTML = ''; });

test('releasing an exam uploads straight away, not at the next timer tick', async () => {
  const calls = setup(() => null);
  await jest.advanceTimersByTimeAsync(10); await flush();
  const before = calls.put;
  window.eval(`examTerms[0].groups[0].rows[0].published=true; render();`);
  await jest.advanceTimersByTimeAsync(5); await flush();           // far less than the 3s timer
  expect(calls.put).toBe(before + 1);
});
