// Forgotten-password recovery for staff who sign in to the app with their phone number.
//
// Staff passwords live in the school's data (systemUsers[].pw, checked on the device), so the server does not store or
// change them. What it does is prove the person is who they say: it finds the staff member by phone number in the school's
// data, sends a system-generated 6-digit code to the phone (SMS) or email address ON FILE (never one typed by the
// requester), and later confirms the code. The app then lets the person choose a new password and saves it as usual.
//
// Both routes need the device's cloud sign-in (the school's own token), so the school is known from the token and one
// school can never reset another's staff. Codes expire after 10 minutes, a new one can be asked for once a minute, and five
// wrong guesses cancel the code. Only a keyed hash of the code is stored.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getStore } = require('./store');
const { sendSms, sendEmail, normalizePhone, validEmail, configured } = require('./comms');

const CODE_TTL_MS = 10 * 60 * 1000, RESEND_MS = 60 * 1000, MAX_TRIES = 5;
const arr = v => (Array.isArray(v) ? v : []);
const phoneKey = v => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };   // last 9 digits, like the app's login
const nameKey = n => String(n || '').trim().toLowerCase();
const teacherFull = t => [t.firstName, t.otherNames, t.surname].filter(Boolean).join(' ');
const secret = () => process.env.JWT_SECRET || 'dev-only-secret';
const hashCode = (tenant, key, code) => crypto.createHmac('sha256', secret()).update(tenant + '|' + key + '|' + code).digest('hex');
const txId = (tenant, key) => 'pwreset:' + tenant + ':' + key;   // kept in the same small key/value store as M-Pesa records (never has status 'paid')

// Staff accounts (people who can have a password) whose phone number is `key`. The phone comes from the Teachers list, the
// Staff list or the account itself, in that order, exactly as the app's login does it.
function findStaff(data, key) {
  const hits = [], sd = (data && data.schoolData) || {};
  for (const school of Object.keys(sd)) {
    const ds = sd[school] || {};
    for (const u of arr(ds.systemUsers)) {
      if (!u || u.role === 'System Developer' || u.role === 'Sales Agent' || u.status === 'Inactive') continue;
      const nm = nameKey(u.name);
      const t = arr(ds.teachersList).find(x => x && nameKey(teacherFull(x)) === nm);
      const st = arr(ds.staffList).find(x => x && nameKey(x.name) === nm);
      const phone = (t && t.phone) || (st && st.phone) || u.phone || '';
      if (phoneKey(phone) !== key) continue;
      hits.push({ school, name: u.name, phone, email: [u.email, t && t.email, st && st.email].find(validEmail) || '' });
    }
  }
  return hits;
}
const maskPhone = p => '••••••' + String(p).replace(/\D/g, '').slice(-3);
const maskEmail = e => e.replace(/^(.).*(@.*)$/, '$1•••$2');

const router = express.Router();
const auth = (req, res, next) => req.app.locals.auth(req, res, next);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const perIp = Number(process.env.RECOVER_RATE_LIMIT) || 10;
const sendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: perIp, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: perIp * 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });

router.post('/auth/recover/send', auth, sendLimiter, wrap(async (req, res) => {
  const key = phoneKey(req.body && req.body.phone), via = req.body && req.body.via, tenant = req.user.tenant;
  if (!key) return res.status(400).json({ error: 'Enter the phone number you sign in with.' });
  const s = await getStore(), snap = await s.getSnapshot(req.app.locals.snapKey(tenant));
  const hits = snap && snap.data ? findStaff(snap.data, key) : [];
  if (!hits.length) return res.status(404).json({ error: 'No staff account has that phone number. If you have never signed in, use your phone number and the password "welcome".' });
  const id = txId(tenant, key), cur = await s.getTx(id);
  if (cur && cur.at && Date.now() - cur.at < RESEND_MS) return res.status(429).json({ error: 'A code was just sent. Wait a minute before asking for another.' });

  // Where the code may go: the phone and email kept on the staff record, whichever the server can send to (SMS first)
  const phone = normalizePhone(hits[0].phone), email = hits.map(h => h.email).find(Boolean) || '';
  const channels = [];
  if (phone && configured.sms() && via !== 'email') channels.push('sms');
  if (email && configured.email() && via !== 'sms') channels.push('email');
  if (!channels.length) return res.status(503).json({ error: 'A code cannot be sent: this person has no phone number or email on file that the server can send to, or SMS/email is not set up. Ask your administrator to reset the password (Settings > Users & Roles).' });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await s.saveTx(id, { h: hashCode(tenant, key, code), exp: Date.now() + CODE_TTL_MS, tries: 0, at: Date.now() });
  const text = 'Your MASMS password reset code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this message and do not share the code.';
  for (const ch of channels) {
    try {
      if (ch === 'sms') { const r = await sendSms([phone], text); if (!r.length || !r[0].ok) throw new Error('sms'); return res.json({ ok: true, via: 'sms', to: maskPhone(phone), minutes: 10 }); }
      await sendEmail({ to: email, subject: 'MASMS password reset code', text }); return res.json({ ok: true, via: 'email', to: maskEmail(email), minutes: 10 });
    } catch (e) { /* try the next channel */ }
  }
  await s.saveTx(id, { used: true, at: 0 });   // nothing went out: let the person try again at once
  res.status(502).json({ error: 'The code could not be sent. Try again in a moment, or ask your administrator to reset the password.' });
}));

// Checks the code once. A correct code is used up here; the app then saves the new password on the device.
router.post('/auth/recover/verify', auth, verifyLimiter, wrap(async (req, res) => {
  const key = phoneKey(req.body && req.body.phone), code = String((req.body && req.body.code) || '').replace(/\s+/g, ''), tenant = req.user.tenant;
  if (!key || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code that was sent to you.' });
  const s = await getStore(), id = txId(tenant, key), rec = await s.getTx(id);
  if (!rec || rec.used || !rec.h) return res.status(400).json({ error: 'No code is waiting for that number. Tap Send code first.' });
  if (Date.now() > rec.exp) return res.status(400).json({ error: 'That code has expired. Tap Send code for a new one.' });
  if (rec.tries >= MAX_TRIES) return res.status(429).json({ error: 'Too many wrong codes. Tap Send code for a new one.' });
  const a = Buffer.from(hashCode(tenant, key, code)), b = Buffer.from(rec.h);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await s.saveTx(id, { ...rec, tries: rec.tries + 1 });
    const left = MAX_TRIES - rec.tries - 1;
    return res.status(400).json({ error: left > 0 ? 'That code is not correct. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Too many wrong codes. Tap Send code for a new one.' });
  }
  await s.saveTx(id, { used: true, at: rec.at });
  res.json({ ok: true });
}));

module.exports = { router, findStaff, phoneKey };
