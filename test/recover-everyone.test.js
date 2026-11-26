// Forgot password for learners, parents and staff-by-email: a 6-digit code goes to the contact ON FILE (a learner has none of their own,
// so it goes to the guardian's phone/email), and the right code + an acceptable password sets the new password.
process.env.NODE_ENV = 'test'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.RECOVER_RATE_LIMIT = '1000';
const mail = [];
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: async m => { mail.push(m); } }) }));
const app = require('../src/app');
const realFetch = global.fetch;
let srv, owner, sms = [];
const call = async (m, p, b, t) => {
  const r = await realFetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const wa = [];
const lastCode = () => /\b(\d{6})\b/.exec(sms[sms.length - 1].message)[1];
let clock = Date.now();
const later = () => { clock += 70000; jest.spyOn(Date, 'now').mockImplementation(() => clock); };
beforeAll(async () => {
  await new Promise(r => { srv = app.listen(0, r); });
  Object.assign(process.env, { AT_USERNAME: 'sandbox', AT_API_KEY: 'k', SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' });
  global.fetch = (url, o) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o);
    if (/graph\.facebook\.com/.test(url)) { wa.push({ url, headers: o.headers, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'w1' }] }) }); }
    const to = String(o.body.get('to')); sms.push({ to, message: o.body.get('message') });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ SMSMessageData: { Recipients: to.split(',').map(n => ({ number: n, statusCode: 100, status: 'Success' })) } }) });
  };
  owner = (await call('POST', '/api/auth/register', { username: 'owner', password: 'password123' })).j.token;
  const data = { schools: ['S'], currentSchool: 'S', schoolData: { S: {
    systemUsers: [{ name: 'Jane Kamau', email: 'jane@school.ac.ke', role: 'Teacher', status: 'Active' }], teachersList: [{ firstName: 'Jane', surname: 'Kamau', phone: '0712 345 678' }], staffList: [],
    students: [{ admissionNumber: '100', firstName: 'Amina', surname: 'Wanjiru', grade: 'Grade 7', guardianPhones: ['0722 111 222'], guardianEmail: 'mum@home.com' }] } } };
  expect((await call('PUT', '/api/data', { data, baseVersion: 0 }, owner)).s).toBe(200);
});
afterAll(() => { global.fetch = realFetch; return new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }); });
beforeEach(() => { wa.length = 0; sms = []; mail.length = 0; jest.restoreAllMocks(); });
const login = (u, p) => call('POST', '/api/portal/login', { username: u, password: p });

test('a learner types the admission number: the code goes to the guardian\'s phone, and the new password replaces "welcome"', async () => {
  later();
  expect((await call('POST', '/api/auth/recover/send', { identifier: '100' })).s).toBe(200);
  expect(sms[0].to).toMatch(/722111222/);
  const code = lastCode();
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '100', code: '000000', password: 'Maths2026' })).s).toBe(400);   // wrong code
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '100', code, password: 'amina' })).s).toBe(400);                   // weak password keeps the code
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '100', code, password: 'Maths2026' })).s).toBe(200);
  expect((await login('100', 'welcome')).s).toBe(401);
  const a = await login('100', 'Maths2026'); expect(a.s).toBe(200); expect(a.j.mustChange).toBe(false);
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '100', code, password: 'Another2026' })).s).toBe(400);          // a code works once
});
test('a parent types the guardian phone: the code is texted and the parent password is set (the learner\'s is untouched)', async () => {
  later();
  expect((await call('POST', '/api/auth/recover/send', { identifier: '0722111222' })).s).toBe(200);
  expect(sms[0].to).toMatch(/722111222/);
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '0722111222', code: lastCode(), password: 'Family2026' })).s).toBe(200);
  expect((await login('0722111222', '100')).s).toBe(401);
  expect((await login('0722111222', 'Family2026')).s).toBe(200);
  expect((await login('100', 'Maths2026')).s).toBe(200);
});
test('staff can use their email, and the code is emailed', async () => {
  later();
  expect((await call('POST', '/api/auth/recover/send', { identifier: 'Jane@School.ac.ke' })).s).toBe(200);
  expect(sms.length).toBe(0); expect(mail.length).toBe(1); expect(mail[0].to).toBe('jane@school.ac.ke');
  const code = /\b(\d{6})\b/.exec(mail[0].text)[1];
  expect((await call('POST', '/api/auth/recover/reset', { identifier: 'jane@school.ac.ke', code, password: 'Teacher2026' })).s).toBe(200);
  expect((await call('POST', '/api/staff/login', { username: '0712345678', password: 'Teacher2026' })).s).toBe(200);
});
test('an unknown admission number or email gets the same answer and nothing is sent', async () => {
  later(); expect((await call('POST', '/api/auth/recover/send', { identifier: '999' })).j).toEqual({ ok: true, minutes: 10 });
  later(); expect((await call('POST', '/api/auth/recover/send', { identifier: 'nobody@x.com' })).j).toEqual({ ok: true, minutes: 10 });
  expect(sms.length + mail.length).toBe(0);
  expect((await call('POST', '/api/auth/recover/send', { identifier: '!!' })).s).toBe(400);
});

test('WhatsApp: the code is sent as an approved template to the number on file, and works like any other code', async () => {
  Object.assign(process.env, { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '123', WHATSAPP_OTP_TEMPLATE: 'masms_code' });
  later();
  expect((await call('POST', '/api/auth/recover/send', { identifier: '0722111222', via: 'whatsapp' })).s).toBe(200);
  expect(sms.length).toBe(0); expect(wa.length).toBe(1);
  expect(wa[0].url).toMatch(/\/123\/messages$/); expect(wa[0].headers.Authorization).toBe('Bearer tok');
  expect(wa[0].body).toMatchObject({ messaging_product: 'whatsapp', to: '254722111222', type: 'template', template: { name: 'masms_code' } });
  const code = wa[0].body.template.components[0].parameters[0].text;
  expect(code).toMatch(/^\d{6}$/);
  expect((await call('POST', '/api/auth/recover/reset', { identifier: '0722111222', code, password: 'Whatsapp2026' })).s).toBe(200);
  expect((await login('0722111222', 'Whatsapp2026')).s).toBe(200);
});
test('WhatsApp: with no channel chosen SMS is still tried first; a WhatsApp failure is reported, not hidden', async () => {
  later();
  expect((await call('POST', '/api/auth/recover/send', { identifier: '0722111222' })).s).toBe(200);
  expect(sms.length).toBe(1); expect(wa.length).toBe(0);
  global.fetch = (url, o) => /graph\.facebook/.test(url) ? Promise.resolve({ ok: false, status: 400, json: async () => ({ error: {} }) }) : realFetch(url, o);
  later(); expect((await call('POST', '/api/auth/recover/send', { identifier: '0722111222', via: 'whatsapp' })).s).toBe(502);
});
