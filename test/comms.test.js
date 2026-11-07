process.env.NODE_ENV = 'test';
const sent = [];
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: async m => { if (/bad/.test(m.to)) throw new Error('x'); sent.push(m); } }) }));
const app = require('../src/app');
const { normalizePhone, smsUnits } = require('../src/comms');
const realFetch = global.fetch;
let srv, ext = [], token;
beforeAll(async () => {
  await new Promise(r => { srv = app.listen(0, r); });
  global.fetch = (url, o) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o);
    ext.push({ url: String(url), o });
    const json = b => Promise.resolve({ ok: true, status: 200, json: async () => b });
    if (/africastalking/.test(url)) return json({ SMSMessageData: { Recipients: String(o.body.get('to')).split(',').map(n => ({ number: n, statusCode: 100, status: 'Success', cost: 'KES 0.8', messageId: 'm' + n })) } });
    if (/oauth/.test(url)) return json({ access_token: 'tok' });
    if (/stkpush/.test(url)) return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', CustomerMessage: 'ok' });
    return Promise.reject(new Error('unexpected ' + url));
  };
  const r = await call('POST', '/api/auth/register', { username: 'admin', password: 'password123' });
  token = r.j.token;
});
afterAll(() => { global.fetch = realFetch; return new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }); });
const call = async (m, p, b, t = token) => {
  const r = await global.fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const setEnv = o => Object.assign(process.env, o);

test('phone normalisation', () => {
  expect(normalizePhone('0712 345 678')).toBe('+254712345678');
  expect(normalizePhone('254112345678')).toBe('+254112345678');
  expect(normalizePhone('712345678')).toBe('+254712345678');
  expect(normalizePhone('+256700123456')).toBe('+256700123456');
  expect(normalizePhone('12345')).toBeNull();
  expect(smsUnits('a'.repeat(160))).toBe(1); expect(smsUnits('a'.repeat(161))).toBe(2);
});

test('all routes need sign-in', async () => {
  for (const [m, p] of [['GET', '/api/comms/status'], ['POST', '/api/sms/send'], ['POST', '/api/email/send'], ['POST', '/api/mpesa/stkpush'], ['GET', '/api/mpesa/status/x']])
    expect((await call(m, p, {}, null)).s).toBe(401);
});

test('unconfigured features answer 503 with what to set', async () => {
  expect((await call('GET', '/api/comms/status')).j).toMatchObject({ sms: false, email: false, mpesa: false });
  for (const p of ['/api/sms/send', '/api/email/send', '/api/mpesa/stkpush']) { const r = await call('POST', p, {}); expect(r.s).toBe(503); expect(r.j.error).toMatch(/not set up/); }
});

test('SMS: validates, dedupes, reports invalid numbers', async () => {
  setEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'k' });
  expect((await call('POST', '/api/sms/send', { to: ['0712345678'], message: '' })).s).toBe(400);
  expect((await call('POST', '/api/sms/send', { to: [], message: 'hi' })).s).toBe(400);
  const r = await call('POST', '/api/sms/send', { to: ['0712345678', '+254712345678', 'abc', '0722000111'], message: 'Fees due' });
  expect(r.s).toBe(200);
  expect(r.j).toMatchObject({ sent: 2, failed: 1, units: 2 });
  const at = ext.find(e => /sandbox\.africastalking/.test(e.url));
  expect(at.o.headers.apiKey).toBe('k');
  expect(at.o.body.get('to')).toBe('+254712345678,+254722000111');
});

test('SMS: personalised messages array', async () => {
  const r = await call('POST', '/api/sms/send', { messages: [{ to: '0712345678', message: 'Hi A' }, { to: '0722000111', message: 'Hi B' }, { to: '0712345678', message: 'Hi A' }] });
  expect(r.j).toMatchObject({ sent: 2, failed: 0, units: 2 });
  expect((await call('POST', '/api/sms/send', { messages: [{ to: '0712345678' }] })).s).toBe(400);
});

test('email: personalised messages array', async () => {
  setEnv({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' });
  const before = sent.length;
  const r = await call('POST', '/api/email/send', { messages: [{ email: 'a@x.com', subject: 'S1', message: 'm1' }, { email: 'b@x.com', subject: 'S2', message: 'm2' }] });
  expect(r.j.sent).toBe(2); expect(sent.slice(before).map(m => m.subject)).toEqual(['S1', 'S2']);
});

test('email: sends, flags bad addresses, escapes html', async () => {
  setEnv({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' });
  const r = await call('POST', '/api/email/send', { to: [{ email: 'a@x.com' }, 'nope', { email: 'bad@x.com' }], subject: 'Hi', message: '<b>x</b>' });
  expect(r.j).toMatchObject({ sent: 1, failed: 2 });
  const m = sent.find(x => /&lt;b&gt;/.test(x.html)); expect(m.to).toBe('a@x.com');
});

test('M-Pesa: STK push, callback marks paid once, secret enforced', async () => {
  setEnv({ MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'pk', MPESA_CALLBACK_SECRET: 'sec', PUBLIC_URL: 'https://x.test/' });
  expect((await call('POST', '/api/mpesa/stkpush', { phone: '123', amount: 100 })).s).toBe(400);
  expect((await call('POST', '/api/mpesa/stkpush', { phone: '0712345678', amount: 0 })).s).toBe(400);
  const r = await call('POST', '/api/mpesa/stkpush', { phone: '0712345678', amount: 1500, reference: 'ADM123', purpose: 'fee', meta: { adm: '123' } });
  expect(r.s).toBe(202); expect(r.j.checkoutId).toBe('ws_CO_1');
  const stk = JSON.parse(ext.find(e => /stkpush/.test(e.url)).o.body);
  expect(stk).toMatchObject({ Amount: 1500, PartyA: '254712345678', CallBackURL: 'https://x.test/api/mpesa/callback/sec' });
  expect((await call('GET', '/api/mpesa/status/ws_CO_1')).j.status).toBe('pending');
  const cb = { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1500 }, { Name: 'MpesaReceiptNumber', Value: 'QWE123' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  await call('POST', '/api/mpesa/callback/wrong', cb, null);
  expect((await call('GET', '/api/mpesa/status/ws_CO_1')).j.status).toBe('pending');
  expect((await call('POST', '/api/mpesa/callback/sec', cb, null)).j.ResultCode).toBe(0);
  const st = (await call('GET', '/api/mpesa/status/ws_CO_1')).j;
  expect(st).toMatchObject({ status: 'paid', receipt: 'QWE123', amount: 1500, meta: { adm: '123' } });
  await call('POST', '/api/mpesa/callback/sec', { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 1032 } } }, null);
  expect((await call('GET', '/api/mpesa/status/ws_CO_1')).j.status).toBe('paid');
  const rec = (await call('GET', '/api/mpesa/recent')).j.payments;
  expect(rec).toHaveLength(1); expect(rec[0]).toMatchObject({ receipt: 'QWE123', amount: 1500, meta: { adm: '123' } });
});
