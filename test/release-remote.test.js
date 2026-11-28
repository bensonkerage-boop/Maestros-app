/** @jest-environment jsdom */
// A release arriving from another device is shown on this device and announced (own file: each test needs a fresh page).
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

test('an exam released on another device is shown and announced', async () => {
  const remoteData = { schools: ['A'], currentSchool: 'A', schoolProfiles: {}, schoolData: { A: {} },
    examTerms: [{ term: 'Term 1', groups: [{ exam: 'Mid', rows: [{ class: 'Grade 7', published: true }] }] }] };
  let useRemote = false;
  const c = setup(() => (useRemote ? remoteData : null));
  await jest.advanceTimersByTimeAsync(10); await flush();
  useRemote = true; c.bump();
  await jest.advanceTimersByTimeAsync(16000); await flush();       // the 15s check finds the newer version
  expect(window.eval('examTerms[0].groups[0].rows[0].published')).toBe(true);
  expect(document.body.textContent).toMatch(/Exam results released: Mid – Grade 7/);
});
