// Runs the app's real comms client helpers against a fake server API.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const a = src.indexOf('let commsStatus = {'), b = src.indexOf('// ---- Messaging > Compose Message: step wizard');
const block = src.slice(a, b);
function make(apiImpl, status = { sms: true, email: true }) {
  const calls = [];
  const ctx = { window: { MASMS_CLOUD: { signedIn: () => true, api: (m, p, body) => { calls.push({ m, p, body }); return apiImpl(m, p, body); } }, addEventListener() {} }, smsCreditBalance: 100, render() {}, console };
  vm.createContext(ctx);
  vm.runInContext(block + '\ncommsStatus = ' + JSON.stringify(Object.assign({ loaded: true }, status)) + ';', ctx);
  ctx.calls = calls; return ctx;
}
test('splits multiple guardian numbers and reports per-person failures', async () => {
  const c = make(async (m, p, body) => ({ sent: 2, units: 2, results: [{ to: '+254722000111', ok: false, status: 'InvalidPhoneNumber' }] }));
  const r = await c.commsSendSms([{ name: 'Mum', phone: '0712345678, 0722000111', message: 'hi' }, { name: 'None', phone: 'No number on file', message: 'hi' }]);
  expect(c.calls[0].body.messages.map(x => x.to)).toEqual(['0712345678', '0722000111']);
  expect(r.sent).toBe(2); expect(r.units).toBe(2);
  expect(r.failures.map(f => f.name).sort()).toEqual(['Mum', 'None']);
});
test('server errors become failures, not exceptions', async () => {
  const c = make(async () => { throw new Error('boom'); });
  const r = await c.commsSendEmails([{ name: 'A', email: 'a@x.com', subject: 's', message: 'm' }]);
  expect(r.sent).toBe(0); expect(r.failures[0].error).toBe('boom');
});
test('credits needed uses 160/153 segments; spend clamps at 0', () => {
  const c = make(async () => ({}));
  expect(c.smsCreditsNeeded([{ phone: '0712345678', message: 'a'.repeat(161) }, { phone: '0711111111,0722222222', message: 'x' }])).toBe(2 + 2);
  c.spendSmsCredits(500); expect(c.smsCreditBalance).toBe(0);
});
test('blocked message tells signed-out users to sign in', () => {
  const c = make(async () => ({}));
  c.window.MASMS_CLOUD.signedIn = () => false;
  expect(c.commsBlockedMessage('sms')).toMatch(/Sign in/);
  c.window.MASMS_CLOUD.signedIn = () => true;
  expect(c.commsBlockedMessage('mpesa')).toMatch(/MPESA_/);
});
