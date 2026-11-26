// Server-side messaging + payments: SMS (Africa's Talking), WhatsApp (Meta Cloud API, used for password-recovery codes), email (SMTP) and M-Pesa STK push (Daraja).
// Secrets live in environment variables, never in the browser. Every route needs a signed-in user,
// except the M-Pesa callback which Safaricom calls (protected by a secret path segment).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getStore } = require('./store');

const env = () => process.env;
const MAX_SMS = 1000, MAX_EMAIL = 300;

// Kenyan numbers -> +2547XXXXXXXX (also accepts other international numbers written with +).
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return /^\+\d{9,15}$/.test(p) ? p : null;
  if (p.startsWith('00')) p = p.slice(2);
  else if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? '+' + p : null;
}
const mpesaPhone = raw => { const p = normalizePhone(raw); return p && /^\+254/.test(p) ? p.slice(1) : null; };

const configured = {
  sms: () => !!(env().AT_USERNAME && env().AT_API_KEY),
  email: () => !!(env().SMTP_HOST && env().SMTP_USER && env().SMTP_PASS),
  whatsapp: () => !!(env().WHATSAPP_TOKEN && env().WHATSAPP_PHONE_ID),
  mpesa: () => !!(env().MPESA_CONSUMER_KEY && env().MPESA_CONSUMER_SECRET && env().MPESA_SHORTCODE && env().MPESA_PASSKEY && env().PUBLIC_URL && env().MPESA_CALLBACK_SECRET),
};
const notConfigured = (res, what, vars) => res.status(503).json({ error: `${what} is not set up on the server. Add ${vars} to the server environment.` });

// ---------- SMS ----------
async function sendSms(phones, message) {
  const sandbox = env().AT_USERNAME === 'sandbox';
  const body = new URLSearchParams({ username: env().AT_USERNAME, to: phones.join(','), message });
  if (env().AT_SENDER_ID) body.set('from', env().AT_SENDER_ID);
  const r = await fetch(`https://api${sandbox ? '.sandbox' : ''}.africastalking.com/version1/messaging`, {
    method: 'POST', headers: { apiKey: env().AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.SMSMessageData) throw new Error('SMS provider error (' + r.status + ')');
  return (j.SMSMessageData.Recipients || []).map(x => ({ to: x.number, ok: x.statusCode === 100 || x.statusCode === 101 || x.status === 'Success', status: x.status, cost: x.cost, messageId: x.messageId }));
}
// number of 160-char SMS segments (153 when concatenated), matching what providers bill
const smsUnits = m => (m.length <= 160 ? 1 : Math.ceil(m.length / 153));

// ---------- WhatsApp (Meta WhatsApp Business Cloud API) ----------
// Used to send a one-time code. WhatsApp only lets a business start a chat with an approved TEMPLATE, so set WHATSAPP_OTP_TEMPLATE to
// the name of an approved "authentication" template (one {{1}} in the body for the code; WHATSAPP_OTP_LANG, default en_US; the template's
// copy-code button also gets the code). Without a template name a plain text message is sent, which WhatsApp delivers only to people who
// messaged the school's number in the last 24 hours. Throws if WhatsApp refuses the message.
async function sendWhatsAppCode(phone, code, text) {
  const to = String(normalizePhone(phone) || '').replace(/\D/g, '');
  if (!to) throw new Error('whatsapp: bad number');
  const tpl = env().WHATSAPP_OTP_TEMPLATE;
  const message = tpl
    ? { type: 'template', template: { name: tpl, language: { code: env().WHATSAPP_OTP_LANG || 'en_US' }, components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        ...(env().WHATSAPP_OTP_BUTTON === '0' ? [] : [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }]) ] } }
    : { type: 'text', text: { body: text } };
  const r = await fetch('https://graph.facebook.com/' + (env().WHATSAPP_API_VERSION || 'v20.0') + '/' + env().WHATSAPP_PHONE_ID + '/messages', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env().WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...message }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !(j.messages && j.messages.length)) throw new Error('WhatsApp error (' + r.status + ')');
}

// ---------- Email ----------
let transport;
function mailer() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({ host: env().SMTP_HOST, port: Number(env().SMTP_PORT) || 587, secure: Number(env().SMTP_PORT) === 465, auth: { user: env().SMTP_USER, pass: env().SMTP_PASS } });
  }
  return transport;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
// One email through the server's SMTP account (also used for password-recovery codes). Throws if the send fails.
async function sendEmail({ to, subject, text }) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(text)}</div>`;
  await mailer().sendMail({ from: env().SMTP_FROM || env().SMTP_USER, to, subject, text, html });
}

// ---------- M-Pesa (Daraja) ----------
const darajaBase = () => (env().MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
async function darajaToken() {
  const basic = Buffer.from(env().MPESA_CONSUMER_KEY + ':' + env().MPESA_CONSUMER_SECRET).toString('base64');
  const r = await fetch(darajaBase() + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + basic } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('M-Pesa authentication failed');
  return j.access_token;
}
const stamp = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss (UTC is fine for Daraja; password uses the same value)

const router = express.Router();
const auth = (req, res, next) => req.app.locals.auth(req, res, next);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down' } });

router.get('/comms/status', auth, (req, res) => res.json({ sms: configured.sms(), email: configured.email(), mpesa: configured.mpesa(), smsSender: env().AT_SENDER_ID || '' }));

// Body: { to, message }  or  { messages: [{ to, message }, ...] } (personalised texts, one request).
router.post('/sms/send', auth, limiter, wrap(async (req, res) => {
  if (!configured.sms()) return notConfigured(res, 'SMS', 'AT_USERNAME and AT_API_KEY');
  const { to, message, messages } = req.body || {};
  let entries;
  if (Array.isArray(messages)) entries = messages.map(m => ({ to: m && m.to, message: m && m.message }));
  else entries = (Array.isArray(to) ? to : [to]).filter(x => x != null).map(t => ({ to: t, message: message }));
  if (!entries.length) return res.status(400).json({ error: 'No recipients' });
  if (entries.length > MAX_SMS) return res.status(400).json({ error: `Too many recipients (max ${MAX_SMS} per send)` });
  if (entries.some(e => typeof e.message !== 'string' || !e.message.trim())) return res.status(400).json({ error: 'Message is required' });
  if (entries.some(e => e.message.length > 1000)) return res.status(400).json({ error: 'Message too long (1000 characters max)' });
  const results = [], groups = new Map(), seen = new Set();
  for (const e of entries) {
    const p = normalizePhone(e.to), text = e.message.trim();
    if (!p) { results.push({ to: String(e.to), ok: false, status: 'Invalid number' }); continue; }
    const key = p + '\u0000' + text;
    if (seen.has(key)) continue; seen.add(key);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(p);
  }
  let units = 0;
  for (const [text, phones] of groups) {
    for (let i = 0; i < phones.length; i += 100) {            // provider batches
      const chunk = phones.slice(i, i + 100);
      try { const r = await sendSms(chunk, text); results.push(...r); units += r.filter(x => x.ok).length * smsUnits(text); }
      catch (err) { chunk.forEach(p => results.push({ to: p, ok: false, status: err.message })); }
    }
  }
  const sent = results.filter(r => r.ok).length;
  res.json({ sent, failed: results.length - sent, units, results });
}));

// Body: { to:[{email,name}|email], subject, message }  or  { messages:[{email,name,subject,message}] }
router.post('/email/send', auth, limiter, wrap(async (req, res) => {
  if (!configured.email()) return notConfigured(res, 'Email', 'SMTP_HOST, SMTP_USER and SMTP_PASS');
  const { to, subject, message, messages } = req.body || {};
  let entries;
  if (Array.isArray(messages)) entries = messages.map(m => ({ email: m && m.email, subject: m && m.subject, message: m && m.message }));
  else entries = (Array.isArray(to) ? to : []).map(r => ({ email: typeof r === 'string' ? r : r && r.email, subject, message }));
  if (!entries.length) return res.status(400).json({ error: 'No recipients' });
  if (entries.length > MAX_EMAIL) return res.status(400).json({ error: `Too many recipients (max ${MAX_EMAIL} per send)` });
  if (entries.some(e => typeof e.subject !== 'string' || !e.subject.trim() || typeof e.message !== 'string' || !e.message.trim())) return res.status(400).json({ error: 'Subject and message are required' });
  const results = [];
  for (const e of entries) {
    if (!validEmail(e.email)) { results.push({ to: String(e.email), ok: false, status: 'Invalid email' }); continue; }
    try { await sendEmail({ to: e.email, subject: e.subject.trim(), text: e.message }); results.push({ to: e.email, ok: true }); }
    catch (err) { results.push({ to: e.email, ok: false, status: 'Send failed' }); }
  }
  const sent = results.filter(r => r.ok).length;
  res.json({ sent, failed: results.length - sent, results });
}));

router.post('/mpesa/stkpush', auth, limiter, wrap(async (req, res) => {
  if (!configured.mpesa()) return notConfigured(res, 'M-Pesa', 'MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_SECRET and PUBLIC_URL');
  const { phone, amount, reference, description, purpose, meta } = req.body || {};
  const msisdn = mpesaPhone(phone), amt = Math.round(Number(amount));
  if (!msisdn) return res.status(400).json({ error: 'Enter a valid Safaricom number (07XX… or 2547XX…)' });
  if (!Number.isFinite(amt) || amt < 1 || amt > 250000) return res.status(400).json({ error: 'Amount must be between 1 and 250,000' });
  const ts = stamp(new Date());
  const password = Buffer.from(env().MPESA_SHORTCODE + env().MPESA_PASSKEY + ts).toString('base64');
  const token = await darajaToken();
  const r = await fetch(darajaBase() + '/mpesa/stkpush/v1/processrequest', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: env().MPESA_SHORTCODE, Password: password, Timestamp: ts, TransactionType: env().MPESA_TXN_TYPE || 'CustomerPayBillOnline',
      Amount: amt, PartyA: msisdn, PartyB: env().MPESA_TILL || env().MPESA_SHORTCODE, PhoneNumber: msisdn,
      CallBackURL: `${env().PUBLIC_URL.replace(/\/$/, '')}/api/mpesa/callback/${env().MPESA_CALLBACK_SECRET}`,
      AccountReference: String(reference || 'MASMS').slice(0, 12), TransactionDesc: String(description || 'Payment').slice(0, 13),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ResponseCode !== '0') return res.status(502).json({ error: j.errorMessage || j.ResponseDescription || 'M-Pesa rejected the request' });
  await (await getStore()).saveTx(j.CheckoutRequestID, { checkoutId: j.CheckoutRequestID, status: 'pending', phone: msisdn, amount: amt, reference: reference || '', purpose: purpose || '', meta: meta || null, by: req.user.username, tenant: req.user.tenant || 'default', createdAt: new Date().toISOString() });
  res.status(202).json({ checkoutId: j.CheckoutRequestID, message: j.CustomerMessage || 'Prompt sent' });
}));

// Safaricom -> us. Always answer 200 so Safaricom does not retry; the secret in the path is the only check.
router.post('/mpesa/callback/:secret', wrap(async (req, res) => {
  const ok = env().MPESA_CALLBACK_SECRET && req.params.secret === env().MPESA_CALLBACK_SECRET;
  const cb = ok && req.body && req.body.Body && req.body.Body.stkCallback;
  if (cb && cb.CheckoutRequestID) {
    const s = await getStore(), cur = await s.getTx(cb.CheckoutRequestID);
    if (cur && cur.status === 'pending') {
      const items = {}; ((cb.CallbackMetadata && cb.CallbackMetadata.Item) || []).forEach(i => { items[i.Name] = i.Value; });
      await s.saveTx(cb.CheckoutRequestID, cb.ResultCode === 0
        ? { ...cur, status: 'paid', receipt: items.MpesaReceiptNumber, paidAmount: items.Amount, paidPhone: String(items.PhoneNumber || ''), paidAt: new Date().toISOString() }
        : { ...cur, status: cb.ResultCode === 1032 ? 'cancelled' : 'failed', reason: cb.ResultDesc, paidAt: new Date().toISOString() });
    }
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

router.get('/mpesa/status/:id', auth, wrap(async (req, res) => {
  const t = await (await getStore()).getTx(req.params.id);
  if (!t || (t.tenant || 'default') !== (req.user.tenant || 'default')) return res.status(404).json({ error: 'Unknown transaction' });   // one school cannot see another's payments
  res.set('Cache-Control', 'no-store');
  res.json({ status: t.status, receipt: t.receipt || '', amount: t.paidAmount || t.amount, phone: t.paidPhone || t.phone, reason: t.reason || '', reference: t.reference, purpose: t.purpose, meta: t.meta });
}));

// Paid M-Pesa prompts raised from this app (newest first) so finance can receipt any the browser missed.
router.get('/mpesa/recent', auth, wrap(async (req, res) => {
  const list = (await (await getStore()).listTx(500)).filter(t => t.status === 'paid' && (t.tenant || 'default') === (req.user.tenant || 'default'))
    .map(t => ({ checkoutId: t.checkoutId, receipt: t.receipt, amount: t.paidAmount || t.amount, phone: t.paidPhone || t.phone, purpose: t.purpose, reference: t.reference, meta: t.meta, paidAt: t.paidAt, by: t.by }));
  res.set('Cache-Control', 'no-store');
  res.json({ payments: list });
}));

module.exports = { router, normalizePhone, smsUnits, sendSms, sendWhatsAppCode, sendEmail, validEmail, configured };
