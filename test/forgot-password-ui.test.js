/** @jest-environment jsdom */
// The Forgot Password form on the login page: asks the server to text/email a code, checks it, and only then saves the new
// password on the staff account. Runs the REAL functions out of the app source (no copies).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
const constSrc = name => { const m = src.match(new RegExp('\\nconst ' + name + ' = [^;]*;')); if (!m) throw new Error('const not found: ' + name); return m[0]; };
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const FNS = ['pwSha256Hex', 'pwHashWithSalt', 'pwNewSalt', 'userNeedsPasswordChange', 'userPasswordOk', 'passwordProblems', 'setUserPassword',
  'loginPhoneKey', 'staffPhoneForUser', 'userFirstName', 'userLastName', 'resetPwSay', 'resetPwApi', 'sendResetCode',
  'submitResetPassword', 'openResetPassword', 'closeResetPassword', 'digitsOnlyInput'];
const PROGRAM = [
  constSrc('WELCOME_PASSWORD'), constSrc('PW_MIN_LENGTH'), constSrc('PW_HASH_ROUNDS'),
  'let resetPwWaitTimer = null;',
  ...FNS.map(fnSrc),
  'window.__t = { get users(){ return systemUsers; }, set users(v){ systemUsers = v; }, get school(){ return currentSchool; } };',
].join('\n');

let api, audits, switched, alerts;
function setup({ cloud = 'in', users, teachers, other } = {}) {
  jest.useFakeTimers();
  document.body.innerHTML = `
    <input id="login_username"><input id="login_password">
    <div class="reset-pw-overlay open" id="reset_pw_overlay">
      <input id="reset_pw_phone"><button id="reset_pw_send">Send code</button>
      <input id="reset_pw_code"><input id="reset_pw_new"><input id="reset_pw_confirm"><div id="reset_pw_msg"></div></div>`;
  api = jest.fn(() => Promise.resolve({ ok: true })); audits = []; switched = []; alerts = [];
  window.alert = m => alerts.push(m);
  window.TextEncoder = window.TextEncoder || require('util').TextEncoder;   // jsdom lacks it; every real browser has it
  window.eval(`
    var currentSchool = 'S', schools = ['S', 'T'], saAgents = [];
    var systemUsers = ${JSON.stringify(users || [{ name: 'Jane Kamau', email: 'jane@x.ke', role: 'Teacher', status: 'Active', mustChange: true }])};
    var teachersList = ${JSON.stringify(teachers || [{ firstName: 'Jane', surname: 'Kamau', phone: '0712 345 678' }])};
    var staffList = [];
    var __other = ${JSON.stringify(other || null)};
    function teacherFullName(t){ return [t.firstName, t.otherNames, t.surname].filter(Boolean).join(' '); }
    function schoolsWithPhone(key){ return __other && key === '${other ? other.key : ''}' ? ['T'] : []; }
    function schoolLoginAllowed(){ return true; }
    function switchToSchool(n){ window.__switched.push(n); currentSchool = n; if(__other){ systemUsers = __other.users; teachersList = __other.teachers; } }
    function recordLoginAudit(u, o, x){ window.__audits.push({ u, o, x }); }
  `);
  window.__switched = switched; window.__audits = audits;
  window.MASMS_CLOUD = cloud === 'none' ? undefined : { signedIn: () => cloud === 'in', api };
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  window.eval(PROGRAM);
}
afterEach(() => { jest.useRealTimers(); delete window.MASMS_CLOUD; });
const $ = id => document.getElementById(id);
const fill = (o) => Object.entries(o).forEach(([k, v]) => { $('reset_pw_' + k).value = v; });
const msg = () => $('reset_pw_msg').textContent;

// resetPwApi now calls the public routes with fetch (no cloud sign-in needed)
let calls;
function useServer(reply = { ok: true, minutes: 10 }, status = 200) {
  calls = [];
  window.fetch = jest.fn((url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(reply) }); });
}
describe('Send code', () => {
  test('asks the server for a code and gives the same neutral message whoever the number belongs to', async () => {
    setup(); useServer(); fill({ phone: '0712 345 678' });
    window.sendResetCode(); await flush();
    expect(calls[0].url).toMatch(/\/api\/auth\/recover\/send$/); expect(calls[0].body.phone).toBe('0712 345 678');
    expect(msg()).toMatch(/If an account matches/); expect(msg()).toMatch(/10 minutes/);
    expect($('reset_pw_send').disabled).toBe(true);                    // one code a minute
    await jest.advanceTimersByTimeAsync(61000);
    expect($('reset_pw_send').disabled).toBe(false); expect($('reset_pw_send').textContent).toBe('Send code');
  });
  test('works on a device that is not signed in to the cloud', async () => {
    setup({ cloud: 'out' }); useServer(); fill({ phone: '0712345678' });
    window.sendResetCode(); await flush();
    expect(calls).toHaveLength(1); expect(msg()).toMatch(/If an account matches/);
  });
  test('"send to my email instead" asks for email delivery', async () => {
    setup(); useServer(); fill({ phone: '0712345678' });
    window.sendResetCode('email'); await flush();
    expect(calls[0].body.via).toBe('email');
  });
  test('a missing or short phone number is refused without calling the server', () => {
    setup(); useServer(); fill({ phone: '' });
    window.sendResetCode();
    expect(calls).toHaveLength(0); expect(msg()).toMatch(/phone number, email/);
  });
  test('a server refusal is shown and the button stays usable', async () => {
    setup(); useServer({ error: 'Too many attempts, try again later' }, 429); fill({ phone: '0712345678' });
    window.sendResetCode(); await flush();
    expect(msg()).toMatch(/Too many attempts/); expect($('reset_pw_send').disabled).toBe(false);
  });
  test('no internet, or the single-file offline copy, is told what to do', async () => {
    setup(); useServer(); fill({ phone: '0712345678' });
    window.fetch = jest.fn(() => Promise.reject(new Error('offline')));   // the request itself fails: Firefox/Edge's onLine flag is not trusted
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.sendResetCode(); await flush();
    expect(msg()).toMatch(/No internet connection/);
    setup({ cloud: 'none' }); useServer(); fill({ phone: '0712345678' });
    window.sendResetCode(); await flush();
    expect(msg()).toMatch(/administrator/);
  });
});

describe('OK (choose a new password)', () => {
  const good = { phone: '0712 345 678', code: '123456', new: 'Rainy2days', confirm: 'Rainy2days' };

  test('sends the code and the new password to the server, then closes and returns to the login page', async () => {
    setup(); useServer(); fill(good);
    window.submitResetPassword(); await flush();
    expect(calls[0].url).toMatch(/\/api\/auth\/recover\/reset$/);
    expect(calls[0].body).toEqual({ phone: '0712 345 678', code: '123456', password: 'Rainy2days' });
    expect(alerts.join()).toMatch(/Password changed/);
    expect($('reset_pw_overlay').classList.contains('open')).toBe(false);
    expect($('login_username').value).toBe('0712 345 678');
  });
  test('a wrong code shows the server\'s message and changes nothing', async () => {
    setup(); useServer({ error: 'That code is not correct. 4 tries left.' }, 400); fill(good);
    window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/4 tries left/); expect(alerts).toHaveLength(0);
    expect($('reset_pw_overlay').classList.contains('open')).toBe(true);
  });
  test('a weak or mismatched password is refused BEFORE the code is used up', async () => {
    setup(); useServer();
    for (const [pw, c, re] of [['short1', 'short1', /at least 8/], ['onlyletters', 'onlyletters', /letters and numbers/], ['welcome', 'welcome', /welcome/], ['Rainy2days', 'Rainy3days', /do not match/]]) {
      fill({ ...good, new: pw, confirm: c });
      window.submitResetPassword(); await flush();
      expect(msg().toLowerCase()).toMatch(re);
    }
    expect(calls).toHaveLength(0);
  });
  test('empty fields are refused before the server is asked', async () => {
    setup(); useServer(); fill({ ...good, code: '' });
    window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/fill in all fields/); expect(calls).toHaveLength(0);
  });
});

describe('the form in the app source', () => {
  const form = src.slice(src.indexOf('<div class="reset-pw-overlay"'), src.indexOf('Remember Password: bring back'));
  test('Send code, the email link and the status line are wired, and the fake "Verification code sent" alert is gone', () => {
    expect(form).toMatch(/id="reset_pw_send" onclick="sendResetCode\(\)"/);
    expect(form).toMatch(/sendResetCode\('email'\)/);
    expect(form).toMatch(/id="reset_pw_msg"/);
    expect(src).not.toMatch(/alert\('Verification code sent\.'\)/);
    expect(src).not.toMatch(/alert\('Password reset successfully/);
  });
  test('the code box takes digits only', () => { expect(form).toMatch(/id="reset_pw_code"[^>]*inputmode="numeric"[^>]*maxlength="6"/); });
  test('the Login Monitor knows the "reset" outcome', () => {
    expect(src).toMatch(/o === "reset" \? `<b style="color:#2563eb;">Password reset<\/b>`/);
    expect(src).toMatch(/<option value="reset"/);
  });
});
