// Forgot password: the server sends a system-generated code to the phone/email ON FILE for a staff member, then confirms it.
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

test('both routes need the device to be signed in to the cloud, and a learner token is not enough', async () => {
  expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678' })).s).toBe(401);
  expect((await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code: '123456' })).s).toBe(401);
});

test('a phone number nobody has is refused with a hint about the welcome password', async () => {
  setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' });
  const r = await call('POST', '/api/auth/recover/send', { phone: '0700 000 000' }, owner);
  expect(r.s).toBe(404); expect(r.j.error).toMatch(/welcome/);
  expect((await call('POST', '/api/auth/recover/send', { phone: '12' }, owner)).s).toBe(400);
  expect(sms).toHaveLength(0);
});

test('an inactive account, the System Developer and a person with no phone cannot be recovered this way', async () => {
  setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' });
  for (const phone of ['0733 000 111', '0799 111 222']) expect((await call('POST', '/api/auth/recover/send', { phone }, owner)).s).toBe(404);
  expect(sms).toHaveLength(0);
});

describe('SMS delivery', () => {
  beforeAll(() => setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' }));
  afterAll(() => clearEnv('AT_USERNAME', 'AT_API_KEY'));

  test('the code goes to the phone on file in any number format, is never in the response, and the number is masked', async () => {
    const r = await call('POST', '/api/auth/recover/send', { phone: '+254 712-345-678' }, owner);
    expect(r.s).toBe(200); expect(r.j).toMatchObject({ ok: true, via: 'sms', minutes: 10 });
    expect(sms).toHaveLength(1); expect(sms[0].to).toBe('+254712345678');
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(r.j)).not.toContain(code);
    expect(r.j.to).toMatch(/678$/); expect(r.j.to).not.toContain('712345');
  });

  test('a second code cannot be asked for within a minute', async () => {
    const r = await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
    expect(r.s).toBe(429);
    expect(sms).toHaveLength(0);
  });

  test('wrong codes count down, the right one works once, and then it is used up', async () => {
    const t = Date.now() + 61000; jest.spyOn(Date, 'now').mockImplementation(() => t);   // past the resend wait
    await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
    const code = lastCode(), wrong = code === '000000' ? '111111' : '000000';
    const w = await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code: wrong }, owner);
    expect(w.s).toBe(400); expect(w.j.error).toMatch(/4 tries left/);
    expect((await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code: 'abc' }, owner)).s).toBe(400);
    expect((await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, owner)).j).toEqual({ ok: true });
    const again = await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, owner);
    expect(again.s).toBe(400); expect(again.j.error).toMatch(/Send code/);
  });

  test('five wrong guesses cancel the code, even if the right one is tried next', async () => {
    let t = Date.now() + 200000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
    const code = lastCode(), wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code: wrong }, owner);
    const r = await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, owner);
    expect(r.s).toBe(429);
  });

  test('a code stops working after 10 minutes', async () => {
    let t = Date.now() + 400000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
    const code = lastCode();
    t += 10 * 60 * 1000 + 1000;
    const r = await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, owner);
    expect(r.s).toBe(400); expect(r.j.error).toMatch(/expired/);
  });

  test('another school cannot send or confirm codes for this school\'s staff', async () => {
    expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, other)).s).toBe(404);
    let t = Date.now() + 700000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
    const code = lastCode();
    expect((await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, other)).s).toBe(400);   // no code waiting in their school
  });

  test('when the SMS provider refuses and there is no email, the person is told and may retry at once', async () => {
    let t = Date.now() + 900000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    smsFails = true;
    expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner)).s).toBe(502);
    smsFails = false;
    expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner)).s).toBe(200);   // no one-minute wait after a failed send
  });
});

describe('email delivery', () => {
  beforeAll(() => setEnv({ SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'MASMS <noreply@school.ac.ke>' }));
  afterAll(() => clearEnv('SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'AT_USERNAME', 'AT_API_KEY'));

  test('with no SMS set up the code goes to the email on file, never to an address the requester types', async () => {
    let t = Date.now() + 1200000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    const r = await call('POST', '/api/auth/recover/send', { phone: '0712345678', email: 'attacker@evil.com' }, owner);
    expect(r.s).toBe(200); expect(r.j).toMatchObject({ via: 'email' }); expect(r.j.to).toMatch(/^j•••@school\.ac\.ke$/);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'jane@school.ac.ke', subject: 'MASMS password reset code' });
    const code = /\b(\d{6})\b/.exec(mail[0].text)[1];
    expect((await call('POST', '/api/auth/recover/verify', { phone: '0712345678', code }, owner)).j).toEqual({ ok: true });
  });

  test('SMS is preferred when both are set up, and the person can ask for email instead', async () => {
    setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' });
    let t = Date.now() + 1500000; jest.spyOn(Date, 'now').mockImplementation(() => t);
    expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner)).j.via).toBe('sms');
    t += 61000;
    expect((await call('POST', '/api/auth/recover/send', { phone: '0712345678', via: 'email' }, owner)).j.via).toBe('email');
  });
});

test('nothing set up on the server: a clear message that points to the administrator', async () => {
  clearEnv('AT_USERNAME', 'AT_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS');
  const t = Date.now() + 2000000; jest.spyOn(Date, 'now').mockImplementation(() => t);
  const r = await call('POST', '/api/auth/recover/send', { phone: '0712345678' }, owner);
  expect(r.s).toBe(503); expect(r.j.error).toMatch(/administrator/);
});
