/** @jest-environment jsdom */
// On the hosted site and the Android app (window.MASMS_ONLINE_ONLY) a saved session is picked up again only after the server
// has been reached. Offline, or when the server rejects this device's cloud sign-in, the saved session is dropped and the
// person lands on the login page.
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function setup({ onlineOnly = true, status = 200, reject = false, navOnline = true } = {}) {
  jest.useFakeTimers();
  localStorage.clear(); sessionStorage.clear();
  sessionStorage.setItem('masmsSession', JSON.stringify({ name: 'Jane Kamau', role: 'Teacher', school: 'S', active: 'dashboard' }));
  Object.defineProperty(navigator, 'onLine', { value: navOnline, configurable: true });
  window.fetch = jest.fn(() => reject ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve({ needsSetup: false }) }));
  window.MASMS_ONLINE_ONLY = onlineOnly;
  window.eval(`
    var isLoggedIn=false, loginError='', pwChangePending=false, currentSchool='S', schools=['S'], active='', saAgents=[], portalEnabled=false, students=[],
        currentUserName='', currentUserRole='', currentAgentId=null, isPortalSession=false, currentPortalStudentAdm=null,
        systemUsers=[{name:'Jane Kamau',role:'Teacher',status:'Active',pw:{h:'x'}}];
    function switchToSchool(){} function renderLoginPage(){} function render(){} function renderPortalApp(){} function canAccessModule(){return true;} function saLoginUser(a){return a;}
    function userNeedsPasswordChange(u){ return !u||!u.pw||!u.pw.h; }
    document.body.innerHTML='<div id="appWrap" style="display:none"></div><div id="portalAppRoot"></div>';
  `);
  window.eval(read('keep-session.js'));
}
afterEach(() => { jest.useRealTimers(); delete window.MASMS_ONLINE_ONLY; });
const state = () => window.eval('({in:isLoggedIn,err:loginError})');

test('online: the saved session is restored once the server answers', async () => {
  setup();
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(window.fetch).toHaveBeenCalled();
  expect(state().in).toBe(true);
});

test('offline (no signal): the saved session is dropped and the login page asks for internet', async () => {
  setup({ reject: true });
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(state()).toEqual({ in: false, err: 'No internet connection. Connect to the internet to sign in.' });
  expect(sessionStorage.getItem('masmsSession')).toBeNull();
});

test('offline (browser reports no network): no request is made and nobody is signed in', async () => {
  setup({ navOnline: false });
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(window.fetch).not.toHaveBeenCalled();
  expect(state().in).toBe(false);
});

test('server rejects the cloud sign-in (401): the saved session is dropped', async () => {
  setup({ status: 401 });
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(state().in).toBe(false);
  expect(state().err).toMatch(/no longer valid/);
});

test('the single-file offline build (no MASMS_ONLINE_ONLY) still restores without the server', async () => {
  setup({ onlineOnly: false, reject: true });
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(window.fetch).not.toHaveBeenCalled();
  expect(state().in).toBe(true);
});

test('an HTML page answering 200 (the app\'s own files, a Wi-Fi login page) is not the server: the saved session is dropped', async () => {
  setup();
  window.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }));
  await jest.advanceTimersByTimeAsync(50); await flush();
  expect(state()).toEqual({ in: false, err: 'No internet connection. Connect to the internet to sign in.' });
});
