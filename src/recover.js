// Forgotten-password reset for staff who sign in to the app with their phone number. It works from the login page of the
// website or the Android app with only an internet connection: no cloud sign-in on the device is needed, because the person
// proves who they are with a code sent to the phone or email ON FILE (never one typed by the requester).
//
// Staff passwords live in the school's data (systemUsers[].pw = {s: salt, h: hash}). The server finds the staff member by phone
// number in every active school, sends a system-generated 6-digit code, and when the right code comes back together with a new
// password that passes the password rules it writes the new salted hash into that school's saved data (devices pick it up on
// their next cloud check). The same hash recipe as the app is used (see pwHash).
//
// Safeguards: the answer to "send code" is the same whether or not a staff account has that number (no way to probe which
// numbers are staff), a new code can be asked for once a minute per number, codes expire after 10 minutes, five wrong guesses
// cancel the code, a correct code is used once, and only a keyed hash of the code is stored. Requests are rate-limited per
// address. The System Developer, Sales Agents and inactive accounts cannot be reset this way.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getStore } = require('./store');
const { sendSms, sendEmail, normalizePhone, validEmail, configured } = require('./comms');

const CODE_TTL_MS = 10 * 60 * 1000, RESEND_MS = 60 * 1000, MAX_TRIES = 5, PW_MIN_LENGTH = 8, PW_HASH_ROUNDS = 1500, WELCOME = 'welcome';
const arr = v => (Array.isArray(v) ? v : []);
const phoneKey = v => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };   // last 9 digits, like the app's login
const nameKey = n => String(n || '').trim().toLowerCase();
const teacherFull = t => [t.firstName, t.otherNames, t.surname].filter(Boolean).join(' ');
const secret = () => process.env.JWT_SECRET || 'dev-only-secret';
const hashCode = (key, code) => crypto.createHmac('sha256', secret()).update('pwreset|' + key + '|' + code).digest('hex');
const txId = key => 'pwreset:' + key;   // kept in the same small key/value store as M-Pesa records (never has status 'paid')
const sha = str => crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
// the app's password recipe (pwHashWithSalt in the app): salted SHA-256, PW_HASH_ROUNDS extra rounds
const pwHash = (salt, pw) => { let h = sha(salt + ':' + pw); for (let i = 0; i < PW_HASH_ROUNDS; i++) h = sha(h + salt + pw); return h; };

// Staff accounts (people who can have a password) in one school's data whose phone number is `key`. The phone comes from the
// Teachers list, the Staff list or the account itself, in that order, exactly as the app's login does it.
function findStaff(data, key) {
  const hits = [], sd = (data && data.schoolData) || {};
  for (const school of Object.keys(sd)) {
    const ds = sd[school] || {};
    arr(ds.systemUsers).forEach((u, index) => {
      if (!u || u.role === 'System Developer' || u.role === 'Sales Agent' || u.status === 'Inactive') return;
      const nm = nameKey(u.name);
      const t = arr(ds.teachersList).find(x => x && nameKey(teacherFull(x)) === nm);
      const st = arr(ds.staffList).find(x => x && nameKey(x.name) === nm);
      const phone = (t && t.phone) || (st && st.phone) || u.phone || '';
      if (phoneKey(phone) !== key) return;
      hits.push({ school, index, name: u.name, phone, email: [u.email, t && t.email, st && st.email].find(validEmail) || '' });
    });
  }
  return hits;
}
// the same rules as passwordProblems() in the app
function passwordProblems(pw, hit) {
  const out = [], low = pw.toLowerCase(), parts = nameKey(hit && hit.name).split(/\s+/).filter(Boolean);
  if (pw.length < PW_MIN_LENGTH) out.push('At least ' + PW_MIN_LENGTH + ' characters');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) out.push('Both letters and numbers');
  if (low === WELCOME) out.push('Different from the welcome password');
  const personal = [parts[0], parts[parts.length - 1], phoneKey(hit && hit.phone)].filter(x => x && x.length >= 3);
  if (personal.includes(low)) out.push('Not just your name or phone number');
  return out;
}
// every active school's staff accounts with this phone number: [{ code, hits }]
async function findEverywhere(s, snapKey, key) {
  const out = [];
  for (const t of (await s.listTenants()).filter(x => x.active !== false)) {
    const snap = await s.getSnapshot(snapKey(t.code));
    const hits = snap && snap.data ? findStaff(snap.data, key) : [];
    if (hits.length) out.push({ code: t.code, hits });
  }
  return out;
}

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const perIp = Number(process.env.RECOVER_RATE_LIMIT) || 10;
const lim = n => rateLimit({ windowMs: 15 * 60 * 1000, limit: n, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });
const sendLimiter = lim(perIp), resetLimiter = lim(perIp * 3);

// Public: no cloud sign-in needed. The answer never says whether the number belongs to a staff account.
router.post('/auth/recover/send', sendLimiter, wrap(async (req, res) => {
  const key = phoneKey(req.body && req.body.phone), via = req.body && req.body.via;
  if (!key) return res.status(400).json({ error: 'Enter the phone number you sign in with.' });
  if (!configured.sms() && !configured.email()) return res.status(503).json({ error: 'A code cannot be sent right now: SMS and email are not set up on the server. Ask your administrator to reset the password (Settings > Users & Roles).' });
  const s = await getStore(), id = txId(key), cur = await s.getTx(id);
  if (cur && cur.at && Date.now() - cur.at < RESEND_MS) return res.status(429).json({ error: 'A code was just sent. Wait a minute before asking for another.' });
  const found = await findEverywhere(s, req.app.locals.snapKey, key), all = found.flatMap(f => f.hits);
  const same = { ok: true, minutes: 10 };

  // Where the code may go: the phone and email kept on the staff record, whichever the server can send to (SMS first)
  const phone = all.length ? normalizePhone(all[0].phone) : '', email = all.map(h => h.email).find(Boolean) || '';
  const channels = [];
  if (phone && configured.sms() && via !== 'email') channels.push('sms');
  if (email && configured.email() && via !== 'sms') channels.push('email');
  if (!channels.length) { await s.saveTx(id, { used: true, at: Date.now() }); return res.json(same); }   // nobody to send to: same answer, nothing sent

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await s.saveTx(id, { h: hashCode(key, code), exp: Date.now() + CODE_TTL_MS, tries: 0, at: Date.now(), schools: found.map(f => f.code) });
  const text = 'Your MASMS password reset code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this message and do not share the code.';
  for (const ch of channels) {
    try {
      if (ch === 'sms') { const r = await sendSms([phone], text); if (!r.length || !r[0].ok) throw new Error('sms'); return res.json(same); }
      await sendEmail({ to: email, subject: 'MASMS password reset code', text }); return res.json(same);
    } catch (e) { /* try the next channel */ }
  }
  await s.saveTx(id, { used: true, at: 0 });   // nothing went out: let the person try again at once
  res.status(502).json({ error: 'The code could not be sent. Try again in a moment, or ask your administrator to reset the password.' });
}));

// Public: checks the code and, only if the new password follows the rules, saves it on the person's account(s) in the school's
// saved data. The code is used up only when the password is saved, so a weak password does not cost the person their code.
router.post('/auth/recover/reset', resetLimiter, wrap(async (req, res) => {
  const b = req.body || {}, key = phoneKey(b.phone), code = String(b.code || '').replace(/\s+/g, ''), pw = typeof b.password === 'string' ? b.password : '';
  if (!key || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code that was sent to you.' });
  if (!pw || pw.length > 100) return res.status(400).json({ error: 'Enter a new password.' });
  const s = await getStore(), id = txId(key), rec = await s.getTx(id);
  if (!rec || rec.used || !rec.h) return res.status(400).json({ error: 'No code is waiting for that number. Tap Send code first.' });
  if (Date.now() > rec.exp) return res.status(400).json({ error: 'That code has expired. Tap Send code for a new one.' });
  if (rec.tries >= MAX_TRIES) return res.status(429).json({ error: 'Too many wrong codes. Tap Send code for a new one.' });
  const a = Buffer.from(hashCode(key, code)), c = Buffer.from(rec.h);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) {
    await s.saveTx(id, { ...rec, tries: rec.tries + 1 });
    const left = MAX_TRIES - rec.tries - 1;
    return res.status(400).json({ error: left > 0 ? 'That code is not correct. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Too many wrong codes. Tap Send code for a new one.' });
  }
  // the code is right: look the accounts up again (they may have changed since the code went out) and check the password
  const snapKey = req.app.locals.snapKey, targets = [];
  for (const code0 of arr(rec.schools)) {
    const t = await s.getTenant(code0);
    if (!t || t.active === false) continue;
    const snap = await s.getSnapshot(snapKey(code0)), hits = snap && snap.data ? findStaff(snap.data, key) : [];
    if (hits.length) targets.push({ code: code0, hits });
  }
  if (!targets.length) return res.status(404).json({ error: 'No staff account has that phone number any more. Ask your administrator.' });
  const bad = [...new Set(targets.flatMap(t => t.hits.flatMap(h => passwordProblems(pw, h))))];
  if (bad.length) return res.status(400).json({ error: 'Password needs: ' + bad.join('; ').toLowerCase() + '.', problems: bad });
  await s.saveTx(id, { used: true, at: rec.at });

  const salt = crypto.randomBytes(12).toString('hex'), pwObj = { s: salt, h: pwHash(salt, pw) };
  for (const t of targets) {
    let saved = false;
    for (let i = 0; i < 6 && !saved; i++) {   // another device may save at the same moment: re-read and try again
      const snap = await s.getSnapshot(snapKey(t.code));
      if (!snap || !snap.data) break;
      for (const h of findStaff(snap.data, key)) {
        const u = snap.data.schoolData[h.school].systemUsers[h.index];
        u.pw = { ...pwObj }; u.mustChange = false;
      }
      saved = (await s.saveSnapshot(snapKey(t.code), snap.data, snap.version, 'password reset')).ok;
    }
    if (!saved) { await s.saveTx(id, { used: true, at: 0 }); return res.status(503).json({ error: 'The password could not be saved just now. Tap Send code and try again.' }); }
  }
  res.json({ ok: true });
}));

module.exports = { router, findStaff, phoneKey, pwHash };
