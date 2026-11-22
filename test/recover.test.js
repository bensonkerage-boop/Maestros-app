// Forgot password from the login page: public routes (no cloud sign-in on the device). The server sends a system-generated code to the
// phone/email ON FILE for a staff member, and when the right code comes with an acceptable new password it saves the password in the school's data.
process.env.NODE_ENV = 'test'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.RECOVER_RATE_LIMIT = '1000';
const mail = [];
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: async m => { mail.push(m); } }) }));
const app = require('../src/app');
const realFetch = global.fetch;
let srv, owner, other, sms = [], smsFails = false;
const call = async (m, p, b, t) => {
  const r = await realFetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const setEnv = o => Object.assign(process.env, o);
const clearEnv = (...k) => k.forEach(x => delete process.env[x]);
const lastCode = () => /\b(\d{6})\b/.exec(sms[sms.length - 1].message)[1];
const school = (extra = {}) => ({ schools: ['S'], currentSchool: 'S', schoolData: { S: {
  systemUsers: [
    { name: 'Jane Kamau', email: 'jane@school.ac.ke', role: 'Teacher', status: 'Active' },
    { name: 'Peter Otieno', email: 'peter@school.ac.ke', role: 'Teacher', status: 'Inactive' },
    { name: 'Dev Eloper', email: '', phone: '0799 111 222', role: 'System Developer', status: 'Active' },
    { name: 'Sam Phoneless', email: '', role: 'Teacher', status: 'Active' },
  ],
  teachersList: [{ firstName: 'Jane', surname: 'Kamau', phone: '0712 345 678', email: '' }, { firstName: 'Peter', surname: 'Otieno', phone: '0733 000 111' }],
  staffList: [], students: [], ...extra } } });

beforeAll(async () => {
  await new Promise(r => { srv = app.listen(0, r); });
  global.fetch = (url, o) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o);
    if (/africastalking/.test(url)) {
      const to = String(o.body.get('to')); sms.push({ to, message: o.body.get('message') });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ SMSMessageData: { Recipients: to.split(',').map(n => ({ number: n, statusCode: smsFails ? 403 : 100, status: smsFails ? 'Failed' : 'Success' })) } }) });
    }
    return Promise.reject(new Error('unexpected ' + url));
  };
  owner = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  expect((await call('PUT', '/api/data', { data: school(), baseVersion: 0 }, owner)).s).toBe(200);
  // a second school on the same server, with different people
  expect((await call('POST', '/api/schools', { name: 'Other School', adminUsername: 'otheradmin', adminPassword: 'password123' }, owner)).s).toBe(201);
  other = (await call('POST', '/api/auth/login', { username: 'otheradmin', password: 'password123' })).j.token;
  expect((await call('PUT', '/api/data', { data: { schools: ['O'], currentSchool: 'O', schoolData: { O: { systemUsers: [], teachersList: [], staffList: [], students: [] } } }, baseVersion: 0 }, other)).s).toBe(200);
});
afterAll(() => { global.fetch = realFetch; return new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }); });
beforeEach(() => { sms = []; mail.length = 0; smsFails = false; jest.restoreAllMocks(); });

const { pwHash } = require('../src/recover');
const SMS = () => setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' });
const send = (phone, extra) => call('POST', '/api/auth/recover/send', { phone, ...extra });
const reset = (phone, code, password) => call('POST', '/api/auth/recover/reset', { phone, code, password });
const jane = async () => ((await call('GET', '/api/data', null, owner)).j.data.schoolData.S.systemUsers.find(u => u.name === 'Jane Kamau'));
let clock = Date.now();
const later = ms => { clock += ms; jest.spyOn(Date, 'now').mockImplementation(() => clock); };

test('the routes are public: no cloud sign-in is needed', async () => {
  SMS(); later(70000);
  expect((await send('0712345678')).s).toBe(200);
});

test('the answer is the same for a number nobody has, so numbers cannot be probed; nothing is sent', async () => {
  SMS(); later(70000);
  const real = await send('0712 345 678'); later(70000);
  const none = await send('0700 000 000');
  expect(none.s).toBe(200); expect(none.j).toEqual(real.j);
  expect(sms).toHaveLength(1);
  expect((await send('12')).s).toBe(400);
});

test('an inactive account, the System Developer and a person with no phone cannot be recovered this way (same answer, nothing sent)', async () => {
  SMS(); later(70000);
  for (const phone of ['0733 000 111', '0799 111 222']) { expect((await send(phone)).s).toBe(200); later(70000); }
  expect(sms).toHaveLength(0);
});

describe('SMS delivery and reset', () => {
  beforeAll(SMS);
  afterAll(() => clearEnv('AT_USERNAME', 'AT_API_KEY'));

  test('the code goes to the phone on file in any number format and is never in the response', async () => {
    later(70000);
    const r = await send('+254 712-345-678');
    expect(r.s).toBe(200); expect(r.j).toEqual({ ok: true, minutes: 10 });
    expect(sms).toHaveLength(1); expect(sms[0].to).toBe('+254712345678');
    expect(JSON.stringify(r.j)).not.toContain(lastCode());
  });

  test('a second code cannot be asked for within a minute', async () => {
    expect((await send('0712345678')).s).toBe(429);
  });

  test('the right code with a good password saves it on the account: it matches the app\'s hash, the welcome password stops working', async () => {
    later(70000); await send('0712345678'); const code = lastCode();
    expect((await reset('0712 345 678', code, 'Rainy2days')).j).toEqual({ ok: true });
    const u = await jane();
    expect(u.mustChange).toBe(false); expect(u.pw.h).toBe(pwHash(u.pw.s, 'Rainy2days')); expect(u.pw.h).not.toBe(pwHash(u.pw.s, 'welcome'));
    const again = await reset('0712345678', code, 'Rainy2days');
    expect(again.s).toBe(400); expect(again.j.error).toMatch(/Send code/);   // used up
  });

  test('a weak password is refused BEFORE the code is used up, so the person can try again with the same code', async () => {
    later(70000); await send('0712345678'); const code = lastCode();
    for (const pw of ['short1', 'onlyletters', 'welcome', 'jane']) {
      const r = await reset('0712345678', code, pw); expect(r.s).toBe(400); expect(r.j.error).toMatch(/Password needs/);
    }
    expect((await reset('0712345678', code, 'Sunny5days')).j).toEqual({ ok: true });
  });

  test('wrong codes count down and five cancel the code, even if the right one is tried next', async () => {
    later(70000); await send('0712345678'); const code = lastCode(), wrong = code === '000000' ? '111111' : '000000';
    const w = await reset('0712345678', wrong, 'Rainy2days'); expect(w.s).toBe(400); expect(w.j.error).toMatch(/4 tries left/);
    expect((await reset('0712345678', 'abc', 'Rainy2days')).s).toBe(400);
    for (let i = 0; i < 4; i++) await reset('0712345678', wrong, 'Rainy2days');
    expect((await reset('0712345678', code, 'Rainy2days')).s).toBe(429);
  });

  test('a code stops working after 10 minutes', async () => {
    later(70000); await send('0712345678'); const code = lastCode();
    later(10 * 60 * 1000 + 1000);
    const r = await reset('0712345678', code, 'Rainy2days'); expect(r.s).toBe(400); expect(r.j.error).toMatch(/expired/);
  });

  test('the person is found in whichever school holds the number, and only that school changes', async () => {
    const before = (await call('GET', '/api/data', null, other)).j.data;
    later(70000); await send('0712345678'); const code = lastCode();
    expect((await reset('0712345678', code, 'Maple7trees')).s).toBe(200);
    expect((await call('GET', '/api/data', null, other)).j.data).toEqual(before);
  });

  test('when the SMS provider refuses and there is no email, the person is told and may retry at once', async () => {
    later(70000); smsFails = true;
    expect((await send('0712345678')).s).toBe(502);
    smsFails = false;
    expect((await send('0712345678')).s).toBe(200);
  });
});

describe('email delivery', () => {
  beforeAll(() => setEnv({ SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'MASMS <noreply@school.ac.ke>' }));
  afterAll(() => clearEnv('SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'AT_USERNAME', 'AT_API_KEY'));

  test('with no SMS set up the code goes to the email on file, never to an address the requester types', async () => {
    later(70000);
    const r = await send('0712345678', { email: 'attacker@evil.com' });
    expect(r.s).toBe(200); expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'jane@school.ac.ke', subject: 'MASMS password reset code' });
    const code = /\b(\d{6})\b/.exec(mail[0].text)[1];
    expect((await reset('0712345678', code, 'Birch8leaves')).j).toEqual({ ok: true });
  });
});

test('nothing set up on the server: a clear message that points to the administrator', async () => {
  clearEnv('AT_USERNAME', 'AT_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS');
  later(70000);
  const r = await send('0712345678');
  expect(r.s).toBe(503); expect(r.j.error).toMatch(/administrator/);
});
