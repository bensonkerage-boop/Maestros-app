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
//
// Who can recover: staff (type in the phone number or email they have on file), parents/guardians (the guardian phone or email on
// the learner's record) and learners (type the admission number: the code goes to the guardian's phone/email on file, because a
// learner has none of their own). The code is always sent to the contact ON FILE, never to anything typed by the requester.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getStore } = require('./store');
const { sendSms, sendWhatsAppCode, sendEmail, normalizePhone, validEmail, configured } = require('./comms');
const { saveDirectory } = require('./directory');

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
// What the person typed: a phone number, an email address or (learners) an admission number. The key also names the pending code.
function parseId(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t || t.length > 80) return null;
  if (t.includes('@')) return validEmail(t) ? { kind: 'email', key: 'e:' + t.toLowerCase() } : null;
  const pk = /^[\d\s+()-]+$/.test(t) ? phoneKey(t) : '';
  if (pk) return { kind: 'phone', key: pk };
  return /^[\w./-]{1,30}$/.test(t) ? { kind: 'adm', key: 'a:' + t.toLowerCase() } : null;
}
const lc = v => String(v == null ? '' : v).trim().toLowerCase();
const studentName = st => [st.firstName, st.otherNames, st.surname || st.lastName].filter(Boolean).join(' ') || st.name || '';
const guardianPhones = st => [...arr(st.guardianPhones), st.guardianPhone].filter(Boolean);
// every account (staff, parent, learner) in one school's data that this identifier belongs to
function findAccounts(data, id) {
  const hits = [], sd = (data && data.schoolData) || {};
  if (id.kind === 'phone') findStaff(data, id.key).forEach(h => hits.push({ ...h, type: 'staff' }));
  for (const school of Object.keys(sd)) {
    const ds = sd[school] || {};
    if (id.kind === 'email') {
      arr(ds.systemUsers).forEach((u, index) => {
        if (!u || u.role === 'System Developer' || u.role === 'Sales Agent' || u.status === 'Inactive') return;
        const nm = nameKey(u.name), t = arr(ds.teachersList).find(x => x && nameKey(teacherFull(x)) === nm), st = arr(ds.staffList).find(x => x && nameKey(x.name) === nm);
        const emails = [u.email, t && t.email, st && st.email].filter(validEmail);
        if (!emails.some(e => lc(e) === id.key.slice(2))) return;
        hits.push({ type: 'staff', school, index, name: u.name, phone: (t && t.phone) || (st && st.phone) || u.phone || '', email: emails[0] });
      });
    }
    arr(ds.students).forEach((st, index) => {
      if (!st) return;
      const base = { school, index, adm: String(st.admissionNumber == null ? '' : st.admissionNumber).trim(), phone: guardianPhones(st)[0] || '', email: validEmail(st.guardianEmail) ? st.guardianEmail : '' };
      if (id.kind === 'phone' && guardianPhones(st).some(p => phoneKey(p) === id.key)) hits.push({ ...base, type: 'parent', name: st.guardian || st.guardianName || studentName(st) });
      else if (id.kind === 'email' && base.email && lc(base.email) === id.key.slice(2)) hits.push({ ...base, type: 'parent', name: st.guardian || st.guardianName || studentName(st) });
      else if (id.kind === 'adm' && base.adm && lc(base.adm) === id.key.slice(2)) hits.push({ ...base, type: 'learner', name: studentName(st) });
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
  const personal = [parts[0], parts[parts.length - 1], phoneKey(hit && hit.phone), lc(hit && hit.adm)].filter(x => x && x.length >= 3);
  if (personal.includes(low)) out.push('Not just your name or phone number');
  return out;
}
// every active school's staff accounts with this phone number: [{ code, hits }]
async function findEverywhere(s, snapKey, id) {
  const out = [];
  for (const t of (await s.listTenants()).filter(x => x.active !== false)) {
    const snap = await s.getSnapshot(snapKey(t.code));
    const hits = snap && snap.data ? findAccounts(snap.data, id) : [];
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
  const b0 = req.body || {}, ident = parseId(b0.identifier || b0.phone), key = ident && ident.key;
  let via = b0.via;
  if (!key) return res.status(400).json({ error: 'Enter your phone number, email address or (learners) admission number.' });
  if (ident.kind === 'email' && !via) via = 'email';
  if (!configured.sms() && !configured.email() && !configured.whatsapp()) return res.status(503).json({ error: 'A code cannot be sent right now: SMS, WhatsApp and email are not set up on the server. Ask your administrator to reset the password (Settings > Users & Roles).' });
  const s = await getStore(), id = txId(key), cur = await s.getTx(id);
  if (cur && cur.at && Date.now() - cur.at < RESEND_MS) return res.status(429).json({ error: 'A code was just sent. Wait a minute before asking for another.' });
  let found = await findEverywhere(s, req.app.locals.snapKey, ident);
  // an admission number can exist in several schools: never guess which one, so nothing is sent (the school's administrator can reset it)
  if (ident.kind === 'adm' && found.length > 1) found = [];
  const all = found.flatMap(f => f.hits);
  const same = { ok: true, minutes: 10 };

  // Where the code may go: the phone and email kept on the staff record, whichever the server can send to (SMS first)
  const phone = all.length ? normalizePhone(all[0].phone) : '', email = all.map(h => h.email).find(Boolean) || '';
  const channels = [];
  // no choice made: SMS first, then WhatsApp, then email. A chosen channel (sms / whatsapp / email) is the only one tried.
  const may = ch => !via || via === ch;
  if (phone && configured.sms() && may('sms')) channels.push('sms');
  if (phone && configured.whatsapp() && may('whatsapp')) channels.push('whatsapp');
  if (email && configured.email() && may('email')) channels.push('email');
  if (!channels.length) { await s.saveTx(id, { used: true, at: Date.now() }); return res.json(same); }   // nobody to send to: same answer, nothing sent

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await s.saveTx(id, { h: hashCode(key, code), exp: Date.now() + CODE_TTL_MS, tries: 0, at: Date.now(), schools: found.map(f => f.code) });
  const text = 'Your MASMS password reset code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this message and do not share the code.';
  for (const ch of channels) {
    try {
      if (ch === 'whatsapp') { await sendWhatsAppCode(phone, code, text); return res.json(same); }
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
  const b = req.body || {}, ident = parseId(b.identifier || b.phone), key = ident && ident.key, code = String(b.code || '').replace(/\s+/g, ''), pw = typeof b.password === 'string' ? b.password : '';
  if (!key || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code that was sent to you.' });
  if (!pw || pw.length > 100) return res.status(400).json({ error: 'Enter a new password.' });
  const s = await getStore(), id = txId(key), rec = await s.getTx(id);
  if (!rec || rec.used || !rec.h) return res.status(400).json({ error: 'No code is waiting for that phone number, email or admission number. Tap Send code first.' });
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
    const snap = await s.getSnapshot(snapKey(code0)), hits = snap && snap.data ? findAccounts(snap.data, ident) : [];
    if (hits.length) targets.push({ code: code0, hits });
  }
  if (!targets.length) return res.status(404).json({ error: 'No account matches that any more. Ask your administrator.' });
  const bad = [...new Set(targets.flatMap(t => t.hits.flatMap(h => passwordProblems(pw, h))))];
  if (bad.length) return res.status(400).json({ error: 'Password needs: ' + bad.join('; ').toLowerCase() + '.', problems: bad });
  await s.saveTx(id, { used: true, at: rec.at });

  const salt = crypto.randomBytes(12).toString('hex'), pwObj = { s: salt, h: pwHash(salt, pw) };
  for (const t of targets) {
    let saved = false;
    for (let i = 0; i < 6 && !saved; i++) {   // another device may save at the same moment: re-read and try again
      const snap = await s.getSnapshot(snapKey(t.code));
      if (!snap || !snap.data) break;
      for (const h of findAccounts(snap.data, ident)) {
        const ds = snap.data.schoolData[h.school];
        if (h.type === 'staff') { const u = ds.systemUsers[h.index]; u.pw = { ...pwObj }; u.mustChange = false; }
        else ds.students[h.index][h.type === 'parent' ? 'parentPw' : 'pw'] = { ...pwObj };
      }
      saved = (await s.saveSnapshot(snapKey(t.code), snap.data, snap.version, 'password reset')).ok;
      if (saved) { try { await saveDirectory(s, t.code, snap.data); } catch (e) { /* the sign-in directory is refreshed on the next full save */ } }   // keeps the old password from working through a stale copy
    }
    if (!saved) { await s.saveTx(id, { used: true, at: 0 }); return res.status(503).json({ error: 'The password could not be saved just now. Tap Send code and try again.' }); }
  }
  res.json({ ok: true });
}));

module.exports = { router, findStaff, findAccounts, parseId, phoneKey, pwHash };
