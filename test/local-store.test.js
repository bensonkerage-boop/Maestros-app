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

// ---- idle autosave must not re-serialize the whole dataset when nothing changed ----
function countCollects() {
  window.eval(`var __collects=0; (function(){ var o=collectBackupData; collectBackupData=function(){ __collects++; return o.apply(this,arguments); }; })();`);
  return () => window.eval('__collects');
}

test('idle autosave ticks skip serializing until something changes', async () => {
  localStorage.clear();
  await boot([]);
  const collects = countCollects();
  window.MASMS_LOCAL.tick();                       // first tick always looks
  await tick(20);
  expect(collects()).toBe(1);
  window.MASMS_LOCAL.tick(); window.MASMS_LOCAL.tick(); window.MASMS_LOCAL.tick();
  await tick(20);
  expect(collects()).toBe(1);                      // nothing happened: no serialize, no hash

  window.eval(`students.push({name:'Zawadi'})`);
  window.eval('render()');                         // every edit ends in render() (or an input/click event)
  window.MASMS_LOCAL.tick();
  await tick(20);
  expect(collects()).toBe(2);
  expect(JSON.parse(JSON.parse(localStorage.getItem('masmsLocal:snapshot')).json).schoolData.A.students.map(s => s.name)).toContain('Zawadi');
});

test('typing or clicking counts as a change even if the handler does not re-render', async () => {
  localStorage.clear();
  await boot([]);
  const collects = countCollects();
  window.MASMS_LOCAL.tick(); await tick(20);
  const base = collects();
  window.eval(`students.push({name:'Typed'})`);
  document.dispatchEvent(new Event('input', { bubbles: true }));
  window.MASMS_LOCAL.tick(); await tick(20);
  expect(collects()).toBe(base + 1);
  window.eval(`students.push({name:'Clicked'})`);
  document.body.dispatchEvent(new Event('click', { bubbles: true }));
  window.MASMS_LOCAL.tick(); await tick(20);
  expect(collects()).toBe(base + 2);
});

test('a quiet app is still re-checked after RECHECK, and saveNow always serializes', async () => {
  localStorage.clear();
  await boot([]);
  const collects = countCollects();
  window.MASMS_LOCAL.tick(); await tick(20);
  window.MASMS_LOCAL.tick(); await tick(20);
  expect(collects()).toBe(1);
  window.MASMS_DIRTY.RECHECK = 0;                  // safety net for edits that never fire an event or render
  window.MASMS_LOCAL.tick(); await tick(20);
  expect(collects()).toBe(2);
  window.MASMS_DIRTY.RECHECK = 60 * 1000;
  await window.MASMS_LOCAL.saveNow();
  expect(collects()).toBe(3);
});

test('a failed write is retried on the next tick even though nothing else changed', async () => {
  localStorage.clear();
  await boot([]);
  const collects = countCollects();
  window.MASMS_LOCAL.tick(); await tick(20);       // establishes lastHash
  window.eval(`students.push({name:'Retry me'})`); window.eval('render()');
  const real = Storage.prototype.setItem; let fail = true;
  Storage.prototype.setItem = function (k, v) { if (fail && String(k) === 'masmsLocal:snapshot') throw new Error('quota'); return real.call(this, k, v); };
  try {
    window.MASMS_LOCAL.tick(); await tick(30);
    expect(window.MASMS_LOCAL.status()).toMatch(/problem/);
    fail = false;
    const before = collects();
    window.MASMS_LOCAL.tick(); await tick(30);     // no new epoch, but the failed save must be retried
    expect(collects()).toBe(before + 1);
    expect(window.MASMS_LOCAL.status()).toMatch(/Saved on this device/);
    expect(JSON.parse(JSON.parse(localStorage.getItem('masmsLocal:snapshot')).json).schoolData.A.students.map(s => s.name)).toContain('Retry me');
  } finally { Storage.prototype.setItem = real; }
});

test('hiding the app flushes unsaved changes without waiting for a tick', async () => {
  localStorage.clear();
  await boot([]);
  window.MASMS_LOCAL.tick(); await tick(20);
  window.eval(`students.push({name:'Last second'})`);   // no render, no event: only the safety paths can catch this
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await tick(30);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  expect(JSON.parse(JSON.parse(localStorage.getItem('masmsLocal:snapshot')).json).schoolData.A.students.map(s => s.name)).toContain('Last second');
});
