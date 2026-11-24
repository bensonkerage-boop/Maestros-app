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
    if (/\/staff\/login$/.test(url)) { const b = JSON.parse(opt.body); return b.username === '0733 000 111' && b.password === 'welcome' ? ok({ token: 'SCHOOL-TOKEN', user: { tenant: 'a' } }) : ok({ error: 'Incorrect username or password.' }, 401); }
    if (/\/auth\/status$/.test(url)) return ok({ needsSetup: false });
    if (/\/auth\/me$/.test(url)) return ok({ username: 'jane', tenant: 'A' });
    if (/\/auth\/login$/.test(url)) return ok({ token: 'DEVICE-TOKEN', user: { username: 'school-a', tenant: 'A' } });
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

test('a staff member on a device with no cloud sign-in is connected to their school automatically: no cloud sign-in is shown, and the sign-in carries on', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('0733 000 111', 'welcome');           // a staff phone number the server finds in a school
  await submit();
  await jest.advanceTimersByTimeAsync(200); await flush(200);
  expect(localStorage.getItem('masmsCloudToken')).toBe('SCHOOL-TOKEN');   // this device is now connected to that school only
  expect(entered()).toEqual(['0733 000 111']);                            // and the normal login went ahead with the typed details
  expect(document.querySelector('form')).toBeNull();                      // nobody was shown a cloud sign-in
});

test('details no school holds are refused with the usual message, and no cloud sign-in is shown', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('0700 999 999', 'nope');
  await submit();
  expect(entered()).toEqual([]);
  expect(error()).toMatch(/^Incorrect username or password[.]/);
  expect(localStorage.getItem('masmsCloudToken')).toBeNull();
  expect(document.querySelector('form')).toBeNull();
  window.MASMS_CLOUD.click();                                   // the cloud button does nothing for anyone but the System Developer
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(document.querySelector('form')).toBeNull();
});

test('the System Developer is offered the cloud sign-in once, then continues into the app and the device stays connected', async () => {
  setup();
  window.eval('var SYSDEV_USERNAME = "Oimeke", SYSDEV_PASSWORD = "Aiden@2023";');
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('Oimeke', 'Aiden@2023');
  await submit();
  expect(entered()).toEqual([]);
  const form = document.querySelector('form');
  expect(form).not.toBeNull(); expect(form.textContent).toMatch(/System Developer/);
  form.u.value = 'school-a'; form.p.value = 'password123';
  form.onsubmit({ preventDefault() {} });
  await jest.advanceTimersByTimeAsync(200); await flush(200);
  expect(localStorage.getItem('masmsCloudToken')).toBe('DEVICE-TOKEN');
  expect(entered()).toEqual(['Oimeke']);                         // carried straight on into the System Developer sign-in
});

test('empty fields are stopped without asking the server', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(10); await flush();
  type('', '');
  await submit();
  expect(entered()).toEqual([]);
  expect(window.fetch.mock.calls.some(c => /portal\/login|staff\/login/.test(c[0]))).toBe(false);
  expect(error()).toMatch(/Enter your username and password/);
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
