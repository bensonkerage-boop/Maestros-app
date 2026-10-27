/** @jest-environment jsdom */
const fs = require('fs'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-store.js'), 'utf8');
const tick = ms => new Promise(r => setTimeout(r, ms));

function boot(seed) {            // fresh "app launch" sharing the same localStorage (jsdom has no IndexedDB -> fallback path)
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', schoolData={A:{students:${JSON.stringify(seed)}}}, __renders=0;
    function collectBackupData(){ schoolData[currentSchool].students=students; return {_meta:{exportedAt:new Date().toISOString()},schools,currentSchool,schoolProfiles,schoolData}; }
    var students=schoolData.A.students;
    function loadSchoolData(n){ students=schoolData[n].students; }
    function render(){ __renders++; }
  `);
  window.eval(code);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return window.MASMS_LOCAL.ready;
}

test('data entered is saved on the device and restored on the next launch', async () => {
  localStorage.clear();
  await boot([]);
  window.eval(`students.push({name:'Amina'},{name:'Brian'})`);
  await window.MASMS_LOCAL.saveNow();
  expect(window.MASMS_LOCAL.status()).toMatch(/Saved on this device/);
  // "reopen the app": fresh globals, empty students, same storage
  await boot([]);
  expect(window.eval('students.map(s=>s.name)')).toEqual(['Amina', 'Brian']);
  expect(window.eval('__renders')).toBeGreaterThan(0);
});

test('first launch with nothing stored does not crash and starts autosaving', async () => {
  localStorage.clear();
  await boot([{ name: 'seed' }]);
  await window.MASMS_LOCAL.saveNow();
  expect(JSON.parse(JSON.parse(localStorage.getItem('masmsLocal:snapshot')).json).schoolData.A.students).toHaveLength(1);
});

test('an earlier copy is kept and can be restored', async () => {
  localStorage.clear();
  await boot([]);
  window.eval(`students.push({name:'One'})`);
  await window.MASMS_LOCAL.saveNow();
  await boot([]);                                   // new session rotates the old snapshot to "previous"
  window.eval(`students.push({name:'Two'})`);
  await window.MASMS_LOCAL.saveNow();
  window.confirm = () => true;
  expect(await window.MASMS_LOCAL.restorePrevious()).toBe(true);
  expect(window.eval('students.map(s=>s.name)')).toEqual(['One']);
});

test('unreadable storage pauses autosave instead of overwriting', async () => {
  localStorage.clear();
  localStorage.setItem('masmsLocal:snapshot', '{not json');
  await boot([{ name: 'x' }]);
  await window.MASMS_LOCAL.saveNow();
  expect(localStorage.getItem('masmsLocal:snapshot')).toBe('{not json');
  expect(window.MASMS_LOCAL.status()).toMatch(/autosave paused|problem/);
});

test('changes the cloud never received are reported once', async () => {
  localStorage.clear();
  await boot([]);
  window.eval(`students.push({name:'Offline'})`);
  await window.MASMS_LOCAL.saveNow();
  await boot([]);
  expect(window.MASMS_LOCAL.takeUnsynced()).toBe(true);
  expect(window.MASMS_LOCAL.takeUnsynced()).toBe(false);
});
