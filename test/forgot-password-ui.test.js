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
  'loginPhoneKey', 'staffPhoneForUser', 'userFirstName', 'userLastName', 'resetPwSay', 'resetPwApi', 'resetPwFindUser', 'sendResetCode',
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

describe('Send code', () => {
  test('asks the server to send a code for the typed phone number and says where it went', async () => {
    setup(); fill({ phone: '0712 345 678' });
    api.mockResolvedValueOnce({ ok: true, via: 'sms', to: '••••••678', minutes: 10 });
    window.sendResetCode(); await flush();
    expect(api).toHaveBeenCalledWith('POST', '/auth/recover/send', { phone: '0712 345 678', via: undefined });
    expect(msg()).toMatch(/by SMS to ••••••678/); expect(msg()).toMatch(/10 minutes/);
    expect($('reset_pw_send').disabled).toBe(true);                    // one code a minute
    await jest.advanceTimersByTimeAsync(61000);
    expect($('reset_pw_send').disabled).toBe(false); expect($('reset_pw_send').textContent).toBe('Send code');
  });
  test('"send to my email instead" asks for email delivery', async () => {
    setup(); fill({ phone: '0712345678' });
    api.mockResolvedValueOnce({ ok: true, via: 'email', to: 'j•••@x.ke', minutes: 10 });
    window.sendResetCode('email'); await flush();
    expect(api.mock.calls[0][2].via).toBe('email'); expect(msg()).toMatch(/by email to j•••@x\.ke/);
  });
  test('a missing or short phone number is refused without calling the server', () => {
    setup(); fill({ phone: '07' });
    window.sendResetCode();
    expect(api).not.toHaveBeenCalled(); expect(msg()).toMatch(/phone number/);
  });
  test('a server refusal is shown and the button stays usable', async () => {
    setup(); fill({ phone: '0712345678' });
    api.mockRejectedValueOnce(new Error('No staff account has that phone number.'));
    window.sendResetCode(); await flush();
    expect(msg()).toMatch(/No staff account/); expect($('reset_pw_send').disabled).toBe(false);
  });
  test('a device with no cloud sign-in, or the offline app, is told what to do instead', async () => {
    setup({ cloud: 'out' }); fill({ phone: '0712345678' });
    window.sendResetCode(); await flush();
    expect(api).not.toHaveBeenCalled(); expect(msg()).toMatch(/Sign in to the cloud first/);
    setup({ cloud: 'none' }); fill({ phone: '0712345678' });
    window.sendResetCode(); await flush();
    expect(msg()).toMatch(/administrator/);
  });
});

describe('OK (choose a new password)', () => {
  const good = { phone: '0712 345 678', code: '123456', new: 'Rainy2days', confirm: 'Rainy2days' };

  test('a correct code saves the new password: it works, the welcome password stops working, and it is logged', async () => {
    setup(); fill(good);
    window.submitResetPassword(); await flush();
    expect(api).toHaveBeenCalledWith('POST', '/auth/recover/verify', { phone: '0712 345 678', code: '123456' });
    const u = window.__t.users[0];
    expect(u.mustChange).toBe(false); expect(u.pw.h).toBeTruthy();
    expect(window.userPasswordOk(u, 'Rainy2days')).toBe(true);
    expect(window.userPasswordOk(u, 'rainy2days')).toBe(false);          // chosen passwords are case-sensitive
    expect(window.userPasswordOk(u, 'welcome')).toBe(false);
    expect(alerts.join()).toMatch(/Password changed/);
    expect($('reset_pw_overlay').classList.contains('open')).toBe(false);
    expect($('login_username').value).toBe('0712 345 678');
    expect(audits).toEqual([expect.objectContaining({ u: '0712 345 678', o: 'reset', x: expect.objectContaining({ name: 'Jane Kamau', portal: false }) })]);
  });
  test('a wrong code leaves the account untouched and shows the server\'s message', async () => {
    setup(); fill(good);
    api.mockRejectedValueOnce(new Error('That code is not correct. 4 tries left.'));
    window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/4 tries left/);
    expect(window.__t.users[0].pw).toBeUndefined(); expect(window.__t.users[0].mustChange).toBe(true);
    expect(alerts).toHaveLength(0); expect(audits).toHaveLength(0);
  });
  test('a weak or mismatched password is refused BEFORE the code is used up', async () => {
    setup();
    for (const [pw, c, re] of [['short1', 'short1', /at least 8/], ['onlyletters', 'onlyletters', /letters and numbers/], ['welcome', 'welcome', /welcome/], ['Rainy2days', 'Rainy3days', /do not match/]]) {
      fill({ ...good, new: pw, confirm: c });
      window.submitResetPassword(); await flush();
      expect(msg().toLowerCase()).toMatch(re);
    }
    expect(api).not.toHaveBeenCalled();
  });
  test('empty fields, or a phone number with no staff account on this device, are refused before the server is asked', async () => {
    setup(); fill({ ...good, code: '' });
    window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/fill in all fields/);
    fill({ ...good, phone: '0799 999 999' });
    window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/No staff account on this device/); expect(msg()).toMatch(/welcome/);
    expect(api).not.toHaveBeenCalled();
  });
  test('the System Developer, sales agents and inactive people cannot be reset this way', async () => {
    setup({ users: [
      { name: 'Dev Eloper', role: 'System Developer', phone: '0712 345 678', status: 'Active' },
      { name: 'Jane Kamau', role: 'Teacher', status: 'Inactive' }] });
    fill(good); window.submitResetPassword(); await flush();
    expect(msg()).toMatch(/No staff account on this device/); expect(api).not.toHaveBeenCalled();
  });
  test('a person whose phone belongs to another school is found there and the password is saved in that school', async () => {
    setup({ users: [{ name: 'Someone Else', role: 'Teacher', status: 'Active' }], teachers: [], other: { key: '711222333',
      users: [{ name: 'Paul Otieno', role: 'Teacher', status: 'Active', email: 'p@y.ke' }], teachers: [{ firstName: 'Paul', surname: 'Otieno', phone: '0711 222 333' }] } });
    fill({ ...good, phone: '0711 222 333' });
    window.submitResetPassword(); await flush();
    expect(switched).toEqual(['T']); expect(window.__t.school).toBe('T');
    expect(window.userPasswordOk(window.__t.users[0], 'Rainy2days')).toBe(true);
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
