require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { findStaffLogin } = require('./staff');
const { getStore } = require('./store');

const app = express();
const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!SECRET) throw new Error('JWT_SECRET is required in production');
const SNAP_KEY = process.env.SNAPSHOT_KEY || 'default';

app.disable('x-powered-by');
app.set('trust proxy', 1);
// CSP is off because the app relies on inline scripts/handlers; other security headers stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// The Android app (Capacitor) runs from https://localhost, so that origin is always allowed.
app.use(cors({ origin: ['https://localhost', 'capacitor://localhost'].concat(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : []) }));
app.use('/api', express.json({ limit: '4mb' })); // Vercel caps request bodies at ~4.5MB

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// ---- Multi-school (multi-tenant) model --------------------------------------------------------------------
// Every school ("tenant") has its own data snapshot and its own users. The school a request may touch comes only from the
// signed token (set at login), never from anything the browser sends, so one school can never read or write another's data.
//   platform owner : may create / suspend schools and reset any password. Created by the very first registration, and
//                    accounts made before multi-school existed (admin with no school) count as platform owners too.
//   school admin   : manages the users of their own school.        staff : uses the school's data.
const DEFAULT_TENANT = 'default';
const tenantOf = u => (u && u.tenant) || DEFAULT_TENANT;
const platformOf = u => !!u && (u.platform === true || (!u.tenant && u.role === 'admin'));
const snapKey = tenant => (tenant === DEFAULT_TENANT ? SNAP_KEY : 'tenant:' + tenant);
// A device is connected to the cloud once, by the System Developer, and then stays connected: the token lasts months and is renewed
// automatically (see /api/auth/me), so staff never meet a cloud sign-in. Removing the account or suspending the school still ends it
// within seconds (stillValid below). The platform owner's own token is shorter because it can create schools and reset passwords.
const TOKEN_DAYS = Number(process.env.CLOUD_TOKEN_DAYS) || 180, PLATFORM_TOKEN_DAYS = Number(process.env.PLATFORM_TOKEN_DAYS) || 90, RENEW_AFTER_S = 24 * 3600;
const signClaims = c => jwt.sign({ sub: c.sub, username: c.username, role: c.role, tenant: c.tenant, platform: !!c.platform, ...(c.staff ? { staff: true } : {}) }, SECRET, { expiresIn: (c.platform ? PLATFORM_TOKEN_DAYS : TOKEN_DAYS) + 'd' });
const sign = u => signClaims({ sub: u.id, username: u.username, role: u.role, tenant: tenantOf(u), platform: platformOf(u) });

// A token stays cryptographically valid for months, so every request also checks (cached for 15s) that the account still
// exists and that its school has not been suspended. Removing a user or suspending a school therefore bites within seconds.
const live = new Map();
const LIVE_MS = 15000;
const forget = () => live.clear();
async function stillValid(claims) {
  if (claims.staff) {   // a school-scoped token from the staff sign-in (POST /api/staff/login): there is no cloud account behind it, only the school
    const key = 'staff|' + claims.tenant, hit = live.get(key);
    if (hit && Date.now() - hit.at < LIVE_MS) return hit.v;
    const t = await (await getStore()).getTenant(claims.tenant);
    const v = !t ? 'gone' : t.active === false ? 'suspended' : 'ok';
    live.set(key, { v, at: Date.now() });
    return v;
  }
  const key = claims.username + '|' + claims.tenant, hit = live.get(key);
  if (hit && Date.now() - hit.at < LIVE_MS) return hit.v;
  const s = await getStore();
  const u = await s.findUser(claims.username);
  let v = 'ok';
  if (!u) v = 'gone';
  else {
    const t = await s.getTenant(tenantOf(u));
    if (t && t.active === false && !platformOf(u)) v = 'suspended';
  }
  live.set(key, { v, at: Date.now() });
  return v;
}
const bearer = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m && m[1]; };
const auth = async (req, res, next) => {
  let claims;
  try { claims = jwt.verify(bearer(req), SECRET); } catch { return res.status(401).json({ error: 'Not signed in' }); }
  if (claims.portal) return res.status(401).json({ error: 'Not signed in' });   // student/parent tokens never open staff routes
  try {
    const v = await stillValid(claims);
    if (v === 'gone') return res.status(401).json({ error: 'Not signed in' });
    if (v === 'suspended') return res.status(403).json({ error: 'This school account is suspended. Contact the platform administrator.' });
  } catch (e) { return next(e); }
  req.user = { ...claims, tenant: claims.tenant || DEFAULT_TENANT, platform: !!claims.platform };
  next();
};
const adminOnly = (req, res, next) => (req.user.role === 'admin' || req.user.platform ? next() : res.status(403).json({ error: 'Only an admin can do this' }));
const platformOnly = (req, res, next) => (req.user.platform ? next() : res.status(403).json({ error: 'Only the platform administrator can do this' }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT) || 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });
const USERNAME_OK = /^[a-z0-9._@+-]{3,60}$/;
const userInfo = async (u, s) => { const code = tenantOf(u), t = await s.getTenant(code); return { username: u.username, role: u.role, tenant: code, tenantName: t ? t.name : code, platform: platformOf(u) }; };
const slug = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

app.locals.auth = auth;
app.locals.snapKey = snapKey;
app.use('/api', require('./comms').router);
app.use('/api', require('./recover').router);

app.get('/api/health', wrap(async (req, res) => { await getStore(); res.json({ ok: true }); }));

// First account is created freely (it becomes the platform owner and owns the first school); after that only admins add users.
app.get('/api/auth/status', wrap(async (req, res) => { const s = await getStore(); res.json({ needsSetup: (await s.countUsers()) === 0 }); }));

app.post('/api/auth/register', loginLimiter, wrap(async (req, res) => {
  const s = await getStore();
  const { username, password, role, tenant, schoolName } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.trim().length < 3 || password.length < 8)
    return res.status(400).json({ error: 'Username (3+ chars) and password (8+ chars) required' });
  const uname = username.trim().toLowerCase();
  if (!USERNAME_OK.test(uname)) return res.status(400).json({ error: 'Username may use letters, numbers and . _ - @ + only' });
  const first = (await s.countUsers()) === 0;
  let me = null;
  if (!first) {
    try { me = jwt.verify(bearer(req), SECRET); } catch { return res.status(401).json({ error: 'Only an admin can add users' }); }
    if (me.role !== 'admin' && !me.platform) return res.status(403).json({ error: 'Only an admin can add users' });
    if ((await stillValid(me)) !== 'ok') return res.status(401).json({ error: 'Not signed in' });
  }
  if (await s.findUser(uname)) return res.status(409).json({ error: 'Username already taken' });
  let target = DEFAULT_TENANT, newRole = 'staff', platform = false;
  if (first) {
    newRole = 'admin'; platform = true;
    await s.createTenant({ code: DEFAULT_TENANT, name: (typeof schoolName === 'string' && schoolName.trim().slice(0, 120)) || 'Main school' });
  } else {
    target = me.platform && typeof tenant === 'string' && tenant ? tenant.toLowerCase() : tenantOf(me);   // only the platform owner may pick another school
    const t = await s.getTenant(target);
    if (!t && target !== DEFAULT_TENANT) return res.status(404).json({ error: 'School not found' });
    if (t && t.active === false) return res.status(409).json({ error: 'That school is suspended' });
    if (role === 'admin' || role === 'staff') newRole = role;
  }
  const user = await s.createUser({ username: uname, passwordHash: await bcrypt.hash(password, 11), role: newRole, tenant: target, platform });
  res.status(201).json({ token: first ? sign(user) : undefined, user: await userInfo(user, s) });
}));

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const s = await getStore();
  const { username, password } = req.body || {};
  const u = typeof username === 'string' && typeof password === 'string' ? await s.findUser(username) : null;
  // compare even when the user is missing to keep timing similar
  const ok = await bcrypt.compare(String(password || ''), u ? u.passwordHash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!u || !ok) return res.status(401).json({ error: 'Invalid username or password' });
  const t = await s.getTenant(tenantOf(u));
  if (t && t.active === false && !platformOf(u)) return res.status(403).json({ error: 'This school account is suspended. Contact the platform administrator.' });
  res.json({ token: sign(u), user: await userInfo(u, s) });
}));

// Also the sliding renewal: a token older than a day is swapped for a fresh one, so a device in use never runs out.
app.get('/api/auth/me', auth, wrap(async (req, res) => {
  const info = await userInfo({ username: req.user.username, role: req.user.role, tenant: req.user.tenant, platform: req.user.platform }, await getStore());
  const age = Math.floor(Date.now() / 1000) - (Number(req.user.iat) || 0);
  res.json(age > RENEW_AFTER_S ? { ...info, token: signClaims(req.user) } : info);
}));

// change your own password
app.post('/api/auth/password', auth, loginLimiter, wrap(async (req, res) => {
  const s = await getStore(), { current, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  const u = await s.findUser(req.user.username);
  if (!u || !(await bcrypt.compare(String(current || ''), u.passwordHash))) return res.status(401).json({ error: 'Current password is wrong' });
  await s.setPassword(u.username, await bcrypt.hash(password, 11));
  res.json({ ok: true });
}));

// ---- user management: school admins manage their own school; the platform owner can manage any ------------------------
// Returns the target account if the caller may manage it, else sends the error itself and returns null.
async function manageable(req, res) {
  const s = await getStore(), t = await s.findUser(String(req.params.username || ''));
  if (!t) { res.status(404).json({ error: 'User not found' }); return null; }
  if (!req.user.platform && (tenantOf(t) !== req.user.tenant || platformOf(t))) { res.status(403).json({ error: 'You cannot manage that user' }); return null; }
  return t;
}
app.get('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const want = req.user.platform && typeof req.query.tenant === 'string' && req.query.tenant ? req.query.tenant.toLowerCase() : req.user.tenant;
  res.set('Cache-Control', 'no-store');
  res.json({ tenant: want, users: await (await getStore()).listUsers(want) });
}));
app.delete('/api/users/:username', auth, adminOnly, wrap(async (req, res) => {
  const t = await manageable(req, res); if (!t) return;
  if (t.username === req.user.username) return res.status(400).json({ error: 'You cannot remove your own account' });
  const s = await getStore();
  if (t.role === 'admin' && (await s.listUsers(tenantOf(t))).filter(u => u.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'Every school needs at least one admin. Add another admin first.' });
  await s.deleteUser(t.username); forget();
  res.json({ ok: true });
}));
app.put('/api/users/:username/password', auth, adminOnly, wrap(async (req, res) => {
  const t = await manageable(req, res); if (!t) return;
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  await (await getStore()).setPassword(t.username, await bcrypt.hash(password, 11));
  res.json({ ok: true });
}));

// ---- schools: platform owner only ------------------------------------------------------------------------------------
app.get('/api/schools', auth, platformOnly, wrap(async (req, res) => {
  const s = await getStore(), users = await s.listUsers(), out = [];
  for (const t of await s.listTenants()) {
    const m = await s.getSnapshotMeta(snapKey(t.code));
    out.push({ code: t.code, name: t.name, active: t.active, users: users.filter(u => u.tenant === t.code).length, lastSaved: m ? m.updatedAt : null, lastSavedBy: m ? m.updatedBy : null });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ schools: out });
}));
app.post('/api/schools', auth, platformOnly, wrap(async (req, res) => {
  const s = await getStore(), { name, code, adminUsername, adminPassword } = req.body || {};
  const nm = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  const au = typeof adminUsername === 'string' ? adminUsername.trim().toLowerCase() : '';
  if (nm.length < 2) return res.status(400).json({ error: 'School name required' });
  if (!USERNAME_OK.test(au) || typeof adminPassword !== 'string' || adminPassword.length < 8) return res.status(400).json({ error: 'Admin username (3+ chars) and password (8+ chars) required' });
  if (await s.findUser(au)) return res.status(409).json({ error: 'That admin username is already taken' });
  let c = slug(code || nm);
  if (!c || c === DEFAULT_TENANT) return res.status(400).json({ error: 'Choose a school code using letters and numbers' });
  let created = await s.createTenant({ code: c, name: nm });
  if (!created && !code) for (let i = 2; i < 30 && !created; i++) { c = slug(nm).slice(0, 26) + '-' + i; created = await s.createTenant({ code: c, name: nm }); }
  if (!created) return res.status(409).json({ error: 'That school code is already used' });
  await s.createUser({ username: au, passwordHash: await bcrypt.hash(adminPassword, 11), role: 'admin', tenant: c, platform: false });
  res.status(201).json({ school: { code: c, name: nm, active: true }, admin: au });
}));
// A school registered in the app is linked to the cloud automatically: this makes its own private cloud space (a "school" on the
// server) and starts it with the school's registered details and principal login. Called by the System Developer's device. Safe to repeat:
// a school that is already linked is simply returned.
// Makes a school's own private cloud space (a tenant) and starts it with the school's registered details and principal login.
// Returns { code, created }. A school that already has a space is simply returned (matched by name), so this is safe to repeat.
async function linkSchool(s, nm, seed, by) {
  const existing = (await s.listTenants()).find(t => t.name === nm && t.code !== DEFAULT_TENANT);
  if (existing) return { code: existing.code, created: false };
  let c = slug(nm), created = c && c !== DEFAULT_TENANT ? await s.createTenant({ code: c, name: nm }) : null;
  for (let i = 2; i < 30 && !created; i++) { c = (slug(nm).slice(0, 26) || 'school') + '-' + i; created = await s.createTenant({ code: c, name: nm }); }
  if (!created) return null;
  const sd = seed && typeof seed === 'object' ? seed : {}, obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const data = { _meta: { app: 'MASMS', version: 2 }, schools: [nm], currentSchool: nm, schoolProfiles: obj(sd.schoolProfile) ? { [nm]: sd.schoolProfile } : {},
    schoolData: { [nm]: obj(sd.schoolData) || {} }, platform: { sdSchools: obj(sd.sdRecord) ? [sd.sdRecord] : [] } };
  await s.saveSnapshot(snapKey(c), data, 0, 'linked by ' + by);
  forget();
  return { code: c, created: true };
}
// A school registered in the app is linked to the cloud automatically: this makes its own private cloud space (a "school" on the
// server) and starts it with the school's registered details and principal login. Called by the System Developer's device. Safe to repeat:
// a school that is already linked is simply returned.
app.post('/api/schools/link', auth, platformOnly, wrap(async (req, res) => {
  const s = await getStore(), { name, seed } = req.body || {};
  const nm = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  if (nm.length < 2) return res.status(400).json({ error: 'School name required' });
  const r = await linkSchool(s, nm, seed, req.user.username);
  if (!r) return res.status(409).json({ error: 'Could not choose a school code' });
  res.status(r.created ? 201 : 200).json(r);
}));

// Safety net for a school that was registered but never got linked (the System Developer's device was offline or its sign-in had
// lapsed at that moment). The System Developer's working copy on the server lists every registered school with its data. When
// someone's staff details match a REGISTERED, ACTIVE school there that has no cloud space yet, the space is made now from that
// copy, so signing in from any browser works the first time with nothing to connect. Only schools in the registry qualify
// (never the built-in demo school or a name that is merely present in the data).
async function linkFromPlatformCopy(s, username, password) {
  const tenants = await s.listTenants();
  for (const t of tenants.filter(x => x.active !== false)) {
    const snap = await s.getSnapshot(snapKey(t.code));
    const d = snap && snap.data;
    if (!d || !d.schoolData || Object.keys(d.schoolData).length < 2) continue;   // only a multi-school working copy
    const reg = Array.isArray(d.platform && d.platform.sdSchools) ? d.platform.sdSchools : [];
    for (const rec of reg) {
      const nm = rec && typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!nm || rec.status === 'Inactive' || !d.schoolData[nm] || tenants.some(x => x.name === nm && x.code !== DEFAULT_TENANT)) continue;
      const seed = { schoolProfile: (d.schoolProfiles || {})[nm] || null, schoolData: d.schoolData[nm], sdRecord: rec };
      const one = { schools: [nm], schoolData: { [nm]: d.schoolData[nm] }, platform: { sdSchools: [rec] } };
      if (!findStaffLogin(one, username, password)) continue;
      const r = await linkSchool(s, nm, seed, 'sign-in from ' + t.code);
      if (r) return (await s.listTenants()).find(x => x.code === r.code) || null;
    }
  }
  return null;
}

// Staff sign-in with no cloud sign-in on the device: finds the school that holds these details and gives this device that school's
// token (and nothing else). The person then signs in to the app as usual against the school's data. Wrong details always get the same answer.
const staffLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.STAFF_LOGIN_RATE_LIMIT) || 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });
app.post('/api/staff/login', staffLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password.trim()) return res.status(400).json({ error: 'Enter your username and password.' });
  const s = await getStore(), found = [];
  for (const t of (await s.listTenants()).filter(x => x.active !== false)) {
    const snap = await s.getSnapshot(snapKey(t.code));
    if (snap && snap.data && findStaffLogin(snap.data, username, password)) found.push(t);
  }
  if (!found.length) { const t = await linkFromPlatformCopy(s, username, password); if (t && t.active !== false) found.push(t); }
  if (!found.length) return res.status(401).json({ error: 'Incorrect username or password.' });
  if (found.length > 1) return res.status(409).json({ error: 'More than one school has this account. Sign in with your user name that ends in @ and your school\'s name.' });
  const t = found[0], uname = 'staff@' + t.code;
  res.json({ token: signClaims({ sub: 'staff:' + t.code, username: uname, role: 'staff', tenant: t.code, platform: false, staff: true }),
    user: { username: uname, role: 'staff', tenant: t.code, tenantName: t.name, platform: false } });
}));
app.patch('/api/schools/:code', auth, platformOnly, wrap(async (req, res) => {
  const s = await getStore(), code = String(req.params.code).toLowerCase(), patch = {};
  const { name, active } = req.body || {};
  if (typeof name === 'string' && name.trim().length >= 2) patch.name = name.trim().slice(0, 120);
  if (typeof active === 'boolean') { if (!active && code === req.user.tenant) return res.status(400).json({ error: 'You cannot suspend your own school' }); patch.active = active; }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
  const t = await s.updateTenant(code, patch);
  if (!t) return res.status(404).json({ error: 'School not found' });
  forget();
  res.json({ school: t });
}));

app.get('/api/data', auth, wrap(async (req, res) => {
  const snap = await (await getStore()).getSnapshot(snapKey(req.user.tenant));
  res.set('Cache-Control', 'no-store');
  res.json(snap ? { version: snap.version, updatedAt: snap.updatedAt, updatedBy: snap.updatedBy, data: snap.data } : { version: 0, data: null });
}));

// tiny "has another device saved?" check; devices poll this and only download the data when the version moved
app.get('/api/data/version', auth, wrap(async (req, res) => {
  const m = await (await getStore()).getSnapshotMeta(snapKey(req.user.tenant));
  res.set('Cache-Control', 'no-store');
  res.json(m || { version: 0 });
}));

app.put('/api/data', auth, wrap(async (req, res) => {
  const { data, baseVersion } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.schools) || typeof data.schoolData !== 'object')
    return res.status(400).json({ error: 'Body must be { data: <MASMS backup object>, baseVersion }' });
  const st = await getStore(), key = snapKey(req.user.tenant), base = Number(baseVersion) || 0;
  const r = await st.saveSnapshot(key, data, base, req.user.username);
  if (r.ok) return res.json({ version: r.version, updatedAt: r.updatedAt });
  // Learners saving quiz attempts move the version too. If every save since this device last synced came from learners,
  // keep this device's changes AND the learners' attempts instead of making the teacher choose between them.
  const cur = base > 0 ? await st.getSnapshot(key) : null;
  if (cur && typeof cur.staffVersion === 'number' && cur.staffVersion <= base && cur.version > base) {
    mergeAttempts(data, cur.data);
    const r2 = await st.saveSnapshot(key, data, cur.version, req.user.username);
    if (r2.ok) return res.json({ version: r2.version, updatedAt: r2.updatedAt, merged: true });
  }
  return res.status(409).json({ error: 'Data changed elsewhere — reload before saving' });
}));

// Copy quiz attempts that learners saved (in `from`) into the staff copy (`into`): a finished attempt beats an unfinished one,
// otherwise the learner's newer progress wins, and attempts the staff copy does not have yet are added.
function mergeAttempts(into, from) {
  const a = (into && into.schoolData) || {}, b = (from && from.schoolData) || {};
  for (const school of Object.keys(b)) {
    const theirs = b[school] && b[school].quizAttempts;
    if (!Array.isArray(theirs) || !a[school]) continue;
    if (!Array.isArray(a[school].quizAttempts)) a[school].quizAttempts = [];
    const mine = a[school].quizAttempts;
    for (const t of theirs) {
      if (!t) continue;
      const i = mine.findIndex(x => x && x.quizId === t.quizId && x.adm === t.adm);
      if (i < 0) mine.push(t); else if (!mine[i].submittedAt) mine[i] = t;   // a finished attempt is final: the staff copy may hold the teacher's marks
    }
  }
}

// ---- Student / parent portal over the cloud -----------------------------------------------------------------------------
// A learner's own phone holds no school data, so it signs in HERE with the same details the portal always used
// (admission number + "welcome", or guardian phone + admission number). The token it gets is limited to that one learner:
// it can read the quizzes published to the learner's class and save that learner's own quiz attempts, nothing else.
const portalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.PORTAL_RATE_LIMIT) || 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });
const portalSign = (tenant, adm, school) => jwt.sign({ portal: true, tenant, adm, school }, SECRET, { expiresIn: '12h' });
const digitsOf = v => String(v == null ? '' : v).replace(/\D/g, '');
const phoneMatch = (stored, typed) => { const a = digitsOf(stored), b = digitsOf(typed); return !!a && !!b && (a === b || (a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9))); };
const arr = v => (Array.isArray(v) ? v : []);
function matchPortalStudent(data, userRaw, pass) {
  const sd = (data && data.schoolData) || {}, adm = userRaw.toLowerCase(), welcome = pass.toLowerCase() === 'welcome';
  for (const school of Object.keys(sd)) {
    for (const st of arr(sd[school] && sd[school].students)) {
      const a = String(st.admissionNumber == null ? '' : st.admissionNumber).trim();
      if (!a) continue;
      if ((welcome && a.toLowerCase() === adm) || (a === pass && arr(st.guardianPhones).some(p => phoneMatch(p, userRaw)))) return { school, student: st };
    }
  }
  return null;
}
// Quiz types: mcq (default), short (typed, marked here against the accepted answers), structured (typed, marked by the teacher)
const qzType = q => (q && (q.type === 'short' || q.type === 'structured')) ? q.type : 'mcq';
const qzNorm = v => String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').replace(/^[\s.,;:!?'"]+|[\s.,;:!?'"]+$/g, '').trim();
const qzMarksOf = (quiz, q) => (qzType(quiz) === 'structured' && Math.floor(Number(q.marks)) > 0) ? Math.floor(Number(q.marks)) : 1;
// <qz-scheme>
// Marking scheme for structured answers. Each question has marking points (the worked answer, step by step), each worth some marks.
// A learner's answer is compared with every point's wording and its accepted alternatives: a full match earns the point's marks, a
// partial match earns proportional marks, no match earns none. Numbers must match exactly. Key terms must be spelled exactly (see qzKeyEq). The server runs this same code.
const QZ_STOP = new Set('a an the of to in on at is are was were be been being it its this that these those and or but for with as by from into than then so such which who whom what when where there their they them he she his her we you your i me my our us not no can could will would should may might do does did has have had if also very'.split(' '));
// Key terms: words whose spelling must be exact (a point's own "Key terms", plus a built-in glossary of science, geography and mathematics terms when the
// quiz turns on strict spelling). Ordinary words still forgive slips and word endings; a key term only forgives its plural.
const QZ_GLOSSARY = new Set('photosynthesis respiration chlorophyll chloroplast chloroplasts mitochondria mitochondrion nucleus cytoplasm membrane diffusion osmosis transpiration stomata xylem phloem germination pollination fertilisation fertilization reproduction ovary ovule stamen anther pistil stigma cotyledon embryo enzyme enzymes digestion absorption excretion circulation ventilation alveoli bronchus bronchi trachea diaphragm haemoglobin hemoglobin platelets artery arteries capillary capillaries oesophagus intestine pancreas kidney nephron urethra hormone hormones insulin adrenaline chromosome chromosomes allele dominant recessive heredity mutation evolution ecosystem habitat population community predator herbivore carnivore omnivore decomposer decomposers producer consumer parasite symbiosis bacteria virus fungi protozoa amoeba nutrition carbohydrate carbohydrates protein proteins vitamin vitamins antibody antibodies immunity vaccination malaria anopheles tuberculosis cholera typhoid molecule molecules atom atoms element compound mixture solution solvent solute filtration evaporation condensation distillation chromatography sublimation electron electrons proton protons neutron neutrons isotope valency valence electrolysis electrolyte electrode cathode anode oxidation reduction combustion corrosion catalyst indicator neutralisation neutralization precipitate hydrogen oxygen nitrogen carbon sulphur sulfur chlorine sodium potassium calcium magnesium aluminium ammonia sulphate carbonate hydroxide chloride nitrate periodic reactivity exothermic endothermic saturated hydrocarbon alkane alkene polymer esterification fermentation detergent hardness rusting alloy velocity acceleration momentum friction gravity density pressure buoyancy upthrust conduction convection radiation thermometer expansion refraction reflection diffraction dispersion spectrum concave convex wavelength amplitude frequency resonance voltage resistance resistor ammeter voltmeter conductor insulator circuit capacitor magnetic electromagnet transformer generator dynamo kinetic potential efficiency fulcrum pulley equilibrium radioactivity nuclear latitude longitude equator tropic meridian atmosphere climate weather precipitation humidity altitude erosion deposition weathering sedimentary igneous metamorphic volcano earthquake epicentre epicenter plateau escarpment delta estuary tributary watershed glacier peninsula archipelago vegetation savannah tundra irrigation urbanisation urbanization migration agriculture horticulture pastoralism tourism manufacturing renewable conservation afforestation deforestation numerator denominator hypotenuse perpendicular parallel perimeter circumference diameter radius quadrilateral parallelogram rhombus trapezium polygon pentagon hexagon octagon equilateral isosceles scalene obtuse acute reflex bisector tangent chord sector segment symmetry congruent gradient coefficient variable equation inequality quadratic simultaneous factorise factorize expression binomial logarithm exponent integer rational irrational median probability fertiliser fertilizer manure compost mulching pruning livestock silage rotation drainage'.split(' '));
function qzKeyEq(p, r){ return p === r || r === p + 's' || r === p + 'es' || p === r + 's' || (/y$/.test(p) && r === p.slice(0, -1) + 'ies') || (/y$/.test(r) && p === r.slice(0, -1) + 'ies'); }
function qzTermWords(list){ const s = new Set(); (Array.isArray(list) ? list : []).forEach(t => qzWords(t).forEach(w => { if(w.length > 2 && !/^\d/.test(w) && !QZ_STOP.has(w)) s.add(w); })); return s; }
function qzMarkOpts(quiz){ return { strict: !!(quiz && quiz.strictTerms) }; }
function qzStem(w){
  if(/^\d/.test(w) || w.length < 5) return w;
  if(/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if(/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
  if(/(ed|es)$/.test(w)) return w.slice(0, -2);
  if(/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
// Mathematics-friendly folding, so equivalent working reads the same: 1/2 = 0.5, 5.0 = 5, 1,500 = 1500, x² = x^2, × · = *, 2*x = 2x
function qzFold(s){
  return String(s == null ? '' : s).toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[−–—]/g, '-').replace(/×|·|\\cdot|\\times/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, (m, a, b) => Number(b) ? String(+(Number(a) / Number(b)).toFixed(6)) : m)
    .replace(/\d+\.\d+/g, m => String(Number(m)));
}
function qzWords(s){ return qzFold(s).match(/\d+(?:\.\d+)?|[a-zà-ɏ]+/g) || []; }
function qzMath(s){ return qzFold(s).replace(/\s*([=+\-*\/^%])\s*/g, '$1').replace(/(\d|[a-z)])\*(?=[a-z(])/g, '$1').replace(/\s+/g, ' ').trim(); }
// Working-based subjects: a step the learner skipped, or only implied, is credited when a later step (or the final answer) is correct.
// A teacher can switch it on or off for a quiz (impliedSteps); otherwise it is on for Mathematics, Physics, Chemistry, Accounting and Statistics.
function qzImpliedOn(quiz){ if(quiz && typeof quiz.impliedSteps === 'boolean') return quiz.impliedSteps; return /math|physic|chem|account|statist/i.test(String(quiz && quiz.subject || '')); }
function qzLev(a, b){
  if(Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length:b.length + 1 }, (_, j) => j);
  for(let i = 1; i <= a.length; i++){
    const cur = [i];
    for(let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function qzTokEq(p, r){
  const pn = /^\d/.test(p), rn = /^\d/.test(r);
  if(pn || rn) return pn && rn && Number(p) === Number(r);
  if(p === r) return true;
  const sp = qzStem(p), sr = qzStem(r);
  if(sp === sr) return true;
  const n = Math.min(sp.length, sr.length);
  return n >= 5 && qzLev(sp, sr) <= (n >= 9 ? 2 : 1);
}
// how much of this phrase the response contains: 0 to 1 (a wrong number makes it 0)
function qzPhraseCov(phrase, rw, rm, isKey){
  const pw = qzWords(phrase).filter(w => /^\d/.test(w) || !QZ_STOP.has(w));
  if(!pw.length) return 0;
  if(/[=+\-*\/^%×÷]/.test(phrase)){
    const e = t => t.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'), pm = qzMath(phrase);
    const has = t => t.length >= 3 && new RegExp('(^|[^0-9a-z.])' + e(t) + '($|[^0-9a-z])').test(rm);
    if(has(pm)) return 1;
    const sd = pm.split('=');
    if(sd.length === 2 && sd[0] && sd[1]){
      if(has(sd[1] + '=' + sd[0])) return 1;                                                                 // 5 = x for x = 5
      if(new RegExp('(^|[^0-9a-z.])' + e(sd[0]) + '=[^,;]*=' + e(sd[1]) + '($|[^0-9a-z])').test(rm)) return 1;   // x = 10/2 = 5 (steps run together)
    }
  }
  let hit = 0, numMiss = false;
  for(const w of pw){ const key = !!isKey && !/^\d/.test(w) && isKey(w); if(rw.some(r => key ? qzKeyEq(w, r) : qzTokEq(w, r))) hit++; else if(/^\d/.test(w)) numMiss = true; }
  return numMiss ? 0 : hit / pw.length;
}
// the question's marking points, scaled so they add up to the question's marks; null when there is no scheme (the teacher marks it)
function qzPoints(x, max){
  let pts = (Array.isArray(x && x.points) ? x.points : []).map(p => ({
    text:String(p && p.text || '').trim(), alt:(Array.isArray(p && p.alt) ? p.alt : []).map(t => String(t || '').trim()).filter(Boolean), marks:Math.max(0, Number(p && p.marks) || 0), shown:!!(p && p.shown),
    terms:(Array.isArray(p && p.terms) ? p.terms : []).map(t => String(t || '').trim()).filter(Boolean)
  })).filter(p => (p.text || p.alt.length) && p.marks > 0);
  if(!pts.length){ const m = String(x && x.modelAnswer || '').trim(); if(m) pts = [{ text:m, alt:[], marks:max }]; }
  if(!pts.length) return null;
  const sum = pts.reduce((t, p) => t + p.marks, 0);
  return sum === max ? pts : pts.map(p => ({ ...p, marks:p.marks * max / sum }));
}
// { marks, max, points:[{ text, max, got, implied? }] } for one typed answer, or null when the question has no marking scheme.
// With `implied` on (working-based subjects) the points are read in order as a chain of working: when a later point is fully shown, the
// earlier ones are credited as implied, so a learner who skips steps (or just writes the answer) is not penalised. A point ticked
// "Must be shown" is independent: it is never implied and does not imply the others.
function qzMarkTyped(x, resp, max, implied, opts){
  const pts = qzPoints(x, max); if(!pts) return null;
  const strict = !!(opts && opts.strict);
  const rw = qzWords(resp), rm = qzMath(resp), r2 = v => Math.round(v * 100) / 100;
  const keyOf = pts.map(p => { const ks = qzTermWords(p.terms); return w => ks.has(w) || (strict && QZ_GLOSSARY.has(w)); });
  const covs = pts.map((p, i) => {
    let cov = 0;
    for(const c of [p.text, ...p.alt]) if(c) cov = Math.max(cov, qzPhraseCov(c, rw, rm, keyOf[i]));
    return cov >= 0.8 ? 1 : cov < 0.3 ? 0 : cov;
  });
  // key terms the learner wrote almost right: reported so the teacher can see why marks were lost
  const miss = pts.map((p, i) => { const out = [];
    for(const c of [p.text, ...p.alt]) for(const w of qzWords(c)){
      if(/^\d/.test(w) || QZ_STOP.has(w) || !keyOf[i](w) || out.some(o => o.term === w) || rw.some(r => qzKeyEq(w, r))) continue;
      const near = rw.find(r => qzTokEq(w, r)); if(near) out.push({ term:w, wrote:near });
    }
    return out; });
  const got = pts.map((p, i) => p.marks * covs[i]), imp = pts.map(() => false);
  if(implied){
    let later = false;
    for(let i = pts.length - 1; i >= 0; i--){
      if(pts[i].shown) continue;
      if(covs[i] >= 1) later = true;
      else if(later){ got[i] = pts[i].marks; imp[i] = true; }
    }
  }
  const points = pts.map((p, i) => ({ text:p.text || p.alt[0], max:r2(p.marks), got:r2(got[i]), ...(imp[i] ? { implied:true } : {}), ...(miss[i].length ? { misspelt:miss[i] } : {}) }));
  return { marks:Math.min(max, Math.round(points.reduce((t, p) => t + p.got, 0) * 2) / 2), max, points };
}
// </qz-scheme>
// accepted answers, worked answers and marking schemes of typed quizzes never leave the server (the server does the marking).
// `autoMark` only tells the learner's phone that the server will mark a structured quiz at once (every question has a scheme).
const forLearner = q => qzType(q) === 'mcq' ? q : { ...q, ...(qzType(q) === 'structured' ? { autoMark: arr(q.questions).length > 0 && arr(q.questions).every(x => !!qzPoints(x, qzMarksOf(q, x))) } : {}),
  questions: arr(q.questions).map(({ accepted, modelAnswer, points, explanation, ...rest }) => rest) };
// Same rule as studentTakesSubject() in the app: a paper reaches only the learners who take its subject. Subjects every learner sits
// go to the whole class; in Grade 10-12 the others go only to learners who chose them (or the mathematics track); in other grades a
// learner with a chosen-subjects list sees only those, and one with no list is treated as taking the class's subjects.
const QZ_COMPULSORY = ['English', 'Kiswahili', 'Community Service Learning', 'Physical Education', 'Pastoral/Religious Programme Information', 'Information Communication Technology', 'Mathematics'];
const QZ_SENIOR = ['Grade 10', 'Grade 11', 'Grade 12'];
const takesSubject = (st, subject) => {
  if (!subject || QZ_COMPULSORY.includes(subject)) return true;
  const opt = arr(st && st.optionalSubjects);
  if (!QZ_SENIOR.includes(st && st.grade)) return opt.length ? opt.includes(subject) : true;
  return opt.includes(subject) || (st && st.mathematicsChoice) === subject;
};
const quizzesFor = (ds, st) => arr(ds.onlineQuizzes).filter(q => q && q.published && q.grade === st.grade && (!q.stream || q.stream === st.stream) && takesSubject(st, q.subject));
function portalPayload(data, school, adm) {
  const ds = (data.schoolData || {})[school] || {};
  const st = arr(ds.students).find(x => String(x.admissionNumber).trim() === adm);
  if (!st) return null;
  return { school, student: st, quizzes: quizzesFor(ds, st).map(forLearner), attempts: arr(ds.quizAttempts).filter(a => a && a.adm === adm) };
}
const portalAuth = async (req, res, next) => {
  let c;
  try { c = jwt.verify(bearer(req), SECRET); } catch { return res.status(401).json({ error: 'Not signed in' }); }
  if (!c.portal || !c.adm) return res.status(401).json({ error: 'Not signed in' });
  try { const t = await (await getStore()).getTenant(c.tenant); if (t && t.active === false) return res.status(403).json({ error: 'This school account is suspended.' }); } catch (e) { return next(e); }
  req.portal = c; next();
};

app.post('/api/portal/login', portalLimiter, wrap(async (req, res) => {
  const s = await getStore();
  const body = req.body || {};
  if (typeof body.username !== 'string' || typeof body.password !== 'string') return res.status(400).json({ error: 'Enter your user name and password' });
  const raw = body.username.trim(), pass = body.password.trim();
  if (!raw || !pass || raw.length > 80 || pass.length > 80) return res.status(401).json({ error: 'Incorrect username or password.' });
  // "4501@schoolcode" picks the school when the same admission number exists in more than one school
  const at = raw.indexOf('@'), userRaw = at > 0 ? raw.slice(0, at) : raw, hint = at > 0 ? slug(raw.slice(at + 1)) : '';
  let tenants = (await s.listTenants()).filter(t => t.active !== false);
  if (hint) { const m = tenants.filter(t => slug(t.code) === hint || slug(t.name) === hint || slug(t.name).replace(/-?(school|schools)$/, '') === hint); if (m.length) tenants = m; }
  const hits = [];
  for (const t of tenants) {
    const snap = await s.getSnapshot(snapKey(t.code));
    const m = snap && snap.data && matchPortalStudent(snap.data, userRaw, pass);
    if (m) hits.push({ t, snap, m });
  }
  if (!hits.length) return res.status(401).json({ error: 'Incorrect username or password.' });
  if (hits.length > 1) return res.status(409).json({ error: 'More than one school has this admission number. Type it with your school code, e.g. ' + userRaw + '@' + hits[0].t.code });
  const { t, snap, m } = hits[0], adm = String(m.student.admissionNumber).trim();
  res.set('Cache-Control', 'no-store');
  res.json({ token: portalSign(t.code, adm, m.school), schoolName: m.school, ...portalPayload(snap.data, m.school, adm) });
}));

// current quizzes + this learner's attempts (also used to resume after a page refresh)
app.get('/api/portal/quizzes', portalAuth, wrap(async (req, res) => {
  const snap = await (await getStore()).getSnapshot(snapKey(req.portal.tenant));
  const p = snap && snap.data && portalPayload(snap.data, req.portal.school, req.portal.adm);
  if (!p) return res.status(404).json({ error: 'Your record was not found. Ask your school.' });
  res.set('Cache-Control', 'no-store');
  res.json({ schoolName: req.portal.school, ...p });
}));

// save this learner's quiz attempt into the school's data. The server owns the marking: a submitted attempt is final and its
// score is worked out here from the teacher's answers, so a modified phone cannot post a better score.
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
// Photos of written working (structured quizzes whose teacher switched it on). The school's whole data is one document, so photos are small
// (the app shrinks them), few per question, and limited in total per school: QUIZ_PHOTO_BUDGET characters (default about 6 MB).
const PHOTO_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, PHOTO_CHARS = 150000, PHOTOS_PER_Q = 2;
const photoBudget = () => Number(process.env.QUIZ_PHOTO_BUDGET) || 6 * 1024 * 1024;
const photoChars = at => Object.values((at && at.photos) || {}).reduce((t, l) => t + arr(l).reduce((u, s) => u + String(s).length, 0), 0);
function cleanPhotos(raw, qids, room) {
  const out = {}; let dropped = 0;
  for (const [k, list] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (!qids.has(k) || !Array.isArray(list)) continue;
    for (const src of list.slice(0, PHOTOS_PER_Q)) {
      if (typeof src !== 'string' || src.length > PHOTO_CHARS || !PHOTO_RE.test(src)) { dropped++; continue; }
      if (src.length > room) { dropped++; continue; }
      room -= src.length; (out[k] = out[k] || []).push(src);
    }
  }
  return { photos: out, dropped };
}
app.put('/api/portal/attempt', portalAuth, portalLimiter, wrap(async (req, res) => {
  const a = (req.body && req.body.attempt) || null, { tenant, school, adm } = req.portal;
  if (!a || typeof a !== 'object' || typeof a.quizId !== 'string') return res.status(400).json({ error: 'attempt required' });
  const s = await getStore(), key = snapKey(tenant);
  for (let i = 0; i < 6; i++) {
    const snap = await s.getSnapshot(key);
    const ds = snap && snap.data && snap.data.schoolData && snap.data.schoolData[school];
    if (!ds) return res.status(404).json({ error: 'School data not found' });
    const st = arr(ds.students).find(x => String(x.admissionNumber).trim() === adm);
    const quiz = st && quizzesFor(ds, st).find(q => q.id === a.quizId);
    if (!quiz) return res.status(404).json({ error: 'That quiz is not available to you' });
    ds.quizAttempts = arr(ds.quizAttempts);
    const idx = ds.quizAttempts.findIndex(x => x && x.quizId === quiz.id && x.adm === adm), cur = idx >= 0 ? ds.quizAttempts[idx] : null;
    if (cur && cur.submittedAt) return res.json({ attempt: cur });                      // already submitted: final
    const qids = new Set(arr(quiz.questions).map(q => q.id)), answers = {}, saved = {}, qt = qzType(quiz);
    const totalMarks = qt === 'structured' ? arr(quiz.questions).reduce((t, q) => t + qzMarksOf(quiz, q), 0) : arr(quiz.questions).length;
    for (const [k, v] of Object.entries(a.answers && typeof a.answers === 'object' ? a.answers : {})) {
      if (!qids.has(k)) continue;
      if (qt === 'mcq') { if (Number.isInteger(v) && v >= 0 && v < 4) { answers[k] = v; saved[k] = true; } }
      else if (typeof v === 'string' && v.trim()) { answers[k] = clip(v, qt === 'short' ? 200 : 2000); saved[k] = true; }
    }
    let photos = {}, photoNote = '';
    if (qt === 'structured' && quiz.allowPhotos && a.photos) {
      const others = arr(ds.quizAttempts).reduce((t, x, j) => t + (j === idx ? 0 : photoChars(x)), 0);
      const r = cleanPhotos(a.photos, qids, Math.max(0, photoBudget() - others));
      photos = r.photos;
      if (r.dropped) photoNote = 'Some photos were not saved (too large, or the school\'s photo space is full). Type that working in your answer instead.';
      for (const k of Object.keys(photos)) if (!saved[k]) { answers[k] = ''; saved[k] = true; }   // a photo alone is an answer
    }
    const att = {
      id: cur ? cur.id : clip(a.id, 40) || (Date.now().toString(36)), quizId: quiz.id, adm,
      startedAt: cur ? cur.startedAt : (Number(a.startedAt) || Date.now()),
      pos: Number.isInteger(a.pos) && a.pos >= 0 && a.pos <= qids.size ? a.pos : 0, saved, answers,
      order: cur ? cur.order : (a.order && JSON.stringify(a.order).length < 40000 ? a.order : { qids: [...qids], opts: {} }),
      submittedAt: null, score: 0, total: totalMarks,
      ...(Object.keys(photos).length ? { photos } : {}), ...(photoNote ? { photoNote } : {}),
    };
    if (a.submittedAt) {
      att.submittedAt = Date.now(); att.auto = !!a.auto;
      const qs = arr(quiz.questions);
      if (qt === 'mcq') att.score = qs.filter(q => answers[q.id] === q.answer).length;
      else if (qt === 'short') {
        att.right = {};
        for (const q of qs) att.right[q.id] = !!qzNorm(answers[q.id]) && arr(q.accepted).some(t => qzNorm(t) === qzNorm(answers[q.id]));
        att.score = Object.values(att.right).filter(Boolean).length;
      } else {
        // structured: compared with the marking scheme and marked at once when every question has one (the teacher can still review);
        // otherwise the teacher gives the marks
        att.score = 0; att.marked = false;
        const got = {};
        const handMarked = Object.keys(photos).length > 0;   // written working in a photo is read and marked by the teacher
        for (const q of qs) { const r = qzMarkTyped(q, answers[q.id], qzMarksOf(quiz, q), qzImpliedOn(quiz), qzMarkOpts(quiz)); if (!r) break; got[q.id] = r.marks; }
        if (!handMarked && qs.length && Object.keys(got).length === qs.length) {
          att.marks = got; att.score = Object.values(got).reduce((t, m) => t + m, 0); att.marked = true; att.autoMarked = true;
          att.markedBy = 'Marking scheme'; att.markedOn = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
        }
      }
    }
    if (idx >= 0) ds.quizAttempts[idx] = att; else ds.quizAttempts.push(att);
    const r = await s.saveSnapshot(key, snap.data, snap.version, 'portal:' + adm, true);
    if (r.ok) return res.json({ attempt: att });
  }
  res.status(409).json({ error: 'Busy, try again' });
}));

// Newest Android version, read by the app's automatic update check (scripts/app-update.js). Set these in Vercel's
// Environment Variables after publishing a new APK; no redeploy of the app itself is needed beyond the env change.
//   APP_LATEST_VERSION_CODE  the versionCode of the newest build (a whole number, goes up every release)
//   APP_LATEST_VERSION_NAME  e.g. 1.2   APP_MIN_VERSION_CODE  builds below this must update (optional)
//   APP_DOWNLOAD_URL         where APK installs download the update (defaults to the Play Store page)   APP_UPDATE_NOTES  one short line (optional)
app.get('/api/app-version', (req, res) => {
  const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  const e = process.env;
  const playUrl = 'https://play.google.com/store/apps/details?id=com.maestro.masms';
  res.set('Cache-Control', 'no-store');
  res.json({
    latestVersionCode: int(e.APP_LATEST_VERSION_CODE), latestVersionName: e.APP_LATEST_VERSION_NAME || '',
    minVersionCode: int(e.APP_MIN_VERSION_CODE), downloadUrl: e.APP_DOWNLOAD_URL || apkUrl() || playUrl, playUrl, notes: e.APP_UPDATE_NOTES || ''
  });
});

// "Download Android app" button on the website. Always sends the browser to the newest APK, which the "Build Android APK"
// workflow republishes at the same address on every build. Set APK_URL in Vercel to that address, or just GITHUB_REPOSITORY
// (owner/repo) and the standard GitHub release address is used.
function apkUrl() {
  const e = process.env;
  if (e.APK_URL) return e.APK_URL;
  if (/^[\w.-]+\/[\w.-]+$/.test(e.GITHUB_REPOSITORY || '')) return 'https://github.com/' + e.GITHUB_REPOSITORY + '/releases/download/android-latest/MASMS.apk';
  return '';
}
app.get('/api/android-apk', (req, res) => {
  const u = apkUrl();
  res.set('Cache-Control', 'no-store');
  if (!u) return res.status(404).type('text').send('The Android app is not published yet. Ask your administrator.');
  res.redirect(302, u);
});

// Landing-page content (text, contacts, gallery photos) edited by the System Developer in the app (Web Page tab).
// Reading is public so the landing page can show it before anyone logs in; saving needs a cloud admin sign-in.
const WP_STR = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
function cleanWebPage(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const hero = c.hero || {}, ct = c.contacts || {};
  const gallery = [];
  for (const g of (Array.isArray(c.gallery) ? c.gallery : []).slice(0, 24)) {
    const src = typeof g.src === 'string' ? g.src : '';
    if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) || src.length > 700 * 1024) continue;
    gallery.push({ id: WP_STR(g.id, 40), title: WP_STR(g.title, 80), caption: WP_STR(g.caption, 240), src });
  }
  return {
    hero: { heading: WP_STR(hero.heading, 80), text: WP_STR(hero.text, 600) },
    contacts: { phone: WP_STR(ct.phone, 40), email: WP_STR(ct.email, 120), facebookName: WP_STR(ct.facebookName, 80), facebookUrl: WP_STR(ct.facebookUrl, 300), whatsapp: WP_STR(ct.whatsapp, 40) },
    gallery,
  };
}
app.get('/api/web-page', wrap(async (req, res) => {
  const rec = await (await getStore()).getTx('webpage');
  res.set('Cache-Control', 'no-store');
  res.json(rec ? { version: rec.version, content: rec.content } : { version: 0, content: null });
}));
app.put('/api/web-page', auth, wrap(async (req, res) => {
  if (!req.user.platform) return res.status(403).json({ error: 'Only the platform administrator can change the web page' });
  const content = cleanWebPage(req.body && req.body.content);
  if (!content) return res.status(400).json({ error: 'Body must be { content: { hero, contacts, gallery } }' });
  const rec = { version: Date.now(), content, updatedBy: req.user.username };
  await (await getStore()).saveTx('webpage', rec);
  res.json({ version: rec.version });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Static site (local/Node hosting). On Vercel, files in /public are served by the CDN instead.
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { maxAge: '30d', immutable: true, setHeaders: (res, p) => { if (/\.html$|sw\.js$|manifest\.webmanifest$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Data too large for one upload (4MB limit)' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});
module.exports = app;
