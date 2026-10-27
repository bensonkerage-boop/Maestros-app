require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const sign = u => jwt.sign({ sub: u.id, username: u.username, role: u.role }, SECRET, { expiresIn: '12h' });
const auth = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  try { req.user = jwt.verify(m && m[1], SECRET); next(); } catch { res.status(401).json({ error: 'Not signed in' }); }
};
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });

app.get('/api/health', wrap(async (req, res) => { await getStore(); res.json({ ok: true }); }));

// First account is created freely (becomes admin); after that only an admin may add users.
app.get('/api/auth/status', wrap(async (req, res) => { const s = await getStore(); res.json({ needsSetup: (await s.countUsers()) === 0 }); }));

app.post('/api/auth/register', loginLimiter, wrap(async (req, res) => {
  const s = await getStore();
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.trim().length < 3 || password.length < 8)
    return res.status(400).json({ error: 'Username (3+ chars) and password (8+ chars) required' });
  const first = (await s.countUsers()) === 0;
  if (!first) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    let me; try { me = jwt.verify(m && m[1], SECRET); } catch { return res.status(401).json({ error: 'Only an admin can add users' }); }
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only an admin can add users' });
  }
  if (await s.findUser(username)) return res.status(409).json({ error: 'Username already taken' });
  const user = await s.createUser({ username: username.trim().toLowerCase(), passwordHash: await bcrypt.hash(password, 11), role: first ? 'admin' : 'staff' });
  res.status(201).json({ token: sign(user), user: { username: user.username, role: user.role } });
}));

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const s = await getStore();
  const { username, password } = req.body || {};
  const u = typeof username === 'string' && typeof password === 'string' ? await s.findUser(username) : null;
  // compare even when the user is missing to keep timing similar
  const ok = await bcrypt.compare(String(password || ''), u ? u.passwordHash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!u || !ok) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: sign(u), user: { username: u.username, role: u.role } });
}));

app.get('/api/auth/me', auth, (req, res) => res.json({ username: req.user.username, role: req.user.role }));

app.get('/api/data', auth, wrap(async (req, res) => {
  const snap = await (await getStore()).getSnapshot(SNAP_KEY);
  res.set('Cache-Control', 'no-store');
  res.json(snap ? { version: snap.version, updatedAt: snap.updatedAt, updatedBy: snap.updatedBy, data: snap.data } : { version: 0, data: null });
}));

app.put('/api/data', auth, wrap(async (req, res) => {
  const { data, baseVersion } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.schools) || typeof data.schoolData !== 'object')
    return res.status(400).json({ error: 'Body must be { data: <MASMS backup object>, baseVersion }' });
  const r = await (await getStore()).saveSnapshot(SNAP_KEY, data, Number(baseVersion) || 0, req.user.username);
  if (!r.ok) return res.status(409).json({ error: 'Data changed elsewhere — reload before saving' });
  res.json({ version: r.version, updatedAt: r.updatedAt });
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
