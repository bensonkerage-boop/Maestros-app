/** @jest-environment jsdom */
// online-login.js stops a sign-in until the device has a valid cloud sign-in. Learners and parents sign in on their own
// phones with no cloud account (the server checks them: /api/portal/login), so the gate must let them through, while staff
// on a device with no cloud sign-in are still stopped.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// what the real server answers for /api/portal/login: a learner (adm + welcome), a parent (guardian phone + adm), else 401
const portalStatus = b => (b.username === '4501' && b.password === 'welcome') || (b.username === '0712 345 678' && b.password === '4501') ? 200
  : (b.username === '4502' && b.password === 'welcome') ? 409 : 401;

function setup({ cloudToken } = {}) {
  jest.useFakeTimers();
  localStorage.clear(); if (cloudToken) localStorage.setItem('masmsCloudToken', cloudToken);
  window.fetch = jest.fn((url, opt) => {
    const ok = (j, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(j) });
    if (/\/portal\/login$/.test(url)) { const st = portalStatus(JSON.parse(opt.body)); return ok(st === 200 ? { token: 't' } : { error: 'More than one school has this admission number.' }, st); }
    if (/\/auth\/status$/.test(url)) return ok({ needsSetup: false });
    if (/\/auth\/me$/.test(url)) return ok({ username: 'jane' });
    if (/\/data\/version$/.test(url)) return ok({ version: 1 });
    if (/\/data$/.test(url)) return ok({ version: 0, data: null });
    return ok({});
  });
  window.eval(`
    var schools=['A'], schoolProfiles={}, currentSchool='A', schoolData={A:{students:[]}}, isLoggedIn=false, loginError='', __entered=[];
    function collectBackupData(){ return {_meta:{},schools,currentSchool,schoolProfiles,schoolData}; }
    function loadSchoolData(){} function applyPlatformData(){} function render(){} function renderLoginPage(){} function logout(){}
    document.body.innerHTML = '<input id="login_username"><input id="login_password">';
    function submitLogin(e){ __entered.push(document.getElementById('login_username').value); }
  `);
  window.eval(read('local-store.js')); window.eval(read('cloud-sync.js')); window.eval(read('online-login.js'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
}
afterEach(() => { jest.useRealTimers(); });

const type = (u, p) => { document.getElementById('login_username').value = u; document.getElementById('login_password').value = p; };
const submit = async () => { window.submitLogin({ preventDefault() {} }); await jest.advanceTimersByTimeAsync(50); await flush(); };
const entered = () => window.eval('__entered'), error = () => window.eval('loginError');

test('a learner (admission number + welcome) on a phone with no cloud sign-in is let through to the normal login', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('4501', 'welcome');
  await submit();
  expect(entered()).toEqual(['4501']);
  expect(error()).toBe('');
});

test('a parent (guardian phone + admission number) with no cloud sign-in is let through too', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('0712 345 678', '4501');
  await submit();
  expect(entered()).toEqual(['0712 345 678']);
});

test('an admission number shared by two schools still reaches the login, which shows the server\'s "add your school code" hint', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('4502', 'welcome');
  await submit();
  expect(entered()).toEqual(['4502']);
});

test('staff details on a device with no cloud sign-in are still stopped and told to sign in to the cloud', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('0733 000 111', 'welcome');           // a staff phone number: the server does not accept it as a learner or parent
  await submit();
  expect(entered()).toEqual([]);
  expect(error()).toMatch(/Sign in to the cloud first/);
});

test('empty fields are stopped without asking the server', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('', '');
  await submit();
  expect(entered()).toEqual([]);
  expect(window.fetch.mock.calls.some(c => /portal\/login/.test(c[0]))).toBe(false);
});

test('a device that IS signed in to the cloud signs in as before, without asking the portal', async () => {
  setup({ cloudToken: 't' });
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('janekamau@school', 'welcome');
  await submit();
  expect(entered()).toEqual(['janekamau@school']);
  expect(window.fetch.mock.calls.some(c => /portal\/login/.test(c[0]))).toBe(false);
});

// An app installed with no server address (built without API_BASE) talks to its own built-in web server, which answers every
// path with the app's own page and a 200. That is not the internet and must not let anyone sign in.
test('an HTML page answering with 200 (the app\'s own files, a Wi-Fi login page) is not the server: sign-in is stopped', async () => {
  setup();
  window.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }));
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('4501', 'welcome');
  await submit();
  expect(entered()).toEqual([]);
  expect(error()).toMatch(/No internet connection/);
});

test('an installed app with no server address says it is not linked, and nobody signs in', async () => {
  setup();
  window.Capacitor = {}; window.MASMS_API_BASE = '';
  type('4501', 'welcome');
  await submit();
  expect(entered()).toEqual([]);
  expect(error()).toMatch(/not linked to the MASMS server/);
  delete window.Capacitor;
});
