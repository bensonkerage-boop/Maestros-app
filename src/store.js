// Data layer. MongoDB (mongoose) in production, in-memory fallback for local dev/tests.
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 80 },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  tenant: { type: String, index: true },            // school code; missing on accounts made before multi-school = 'default'
  platform: { type: Boolean, default: false },       // platform owner: can create/suspend schools
}, { timestamps: true });

const tenantSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, maxlength: 120 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const snapshotSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },   // one snapshot per installation
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  version: { type: Number, default: 1 },
  staffVersion: Number,   // version of the last save made by school staff (portal/learner saves leave it alone)
  updatedBy: String,
}, { timestamps: true });

const txSchema = new mongoose.Schema({ id: { type: String, required: true, unique: true }, data: mongoose.Schema.Types.Mixed }, { timestamps: true });

class MongoStore {
  constructor() { this.User = mongoose.models.User || mongoose.model('User', userSchema); this.Snapshot = mongoose.models.Snapshot || mongoose.model('Snapshot', snapshotSchema); this.Tx = mongoose.models.Tx || mongoose.model('Tx', txSchema); this.Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema); }
  async saveTx(id, data) { await this.Tx.updateOne({ id }, { $set: { data } }, { upsert: true }); }
  async getTx(id) { const t = await this.Tx.findOne({ id }).lean(); return t ? t.data : null; }
  async listTx(limit = 200) { return (await this.Tx.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(t => t.data); }
  async connect(uri) { if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 }); }
  async countUsers() { return this.User.countDocuments(); }
  async findUser(username) { const u = await this.User.findOne({ username: String(username).toLowerCase() }).lean(); return u && { id: String(u._id), ...u }; }
  async createUser({ username, passwordHash, role, tenant, platform }) { const u = await this.User.create({ username, passwordHash, role, tenant, platform: !!platform }); return { id: String(u._id), username: u.username, role: u.role, tenant: u.tenant, platform: u.platform }; }
  async listUsers(tenant) {
    const q = tenant === undefined ? {} : tenant === 'default' ? { $or: [{ tenant: 'default' }, { tenant: { $exists: false } }, { tenant: null }] } : { tenant };
    return (await this.User.find(q).sort({ username: 1 }).lean()).map(u => ({ username: u.username, role: u.role, tenant: u.tenant || 'default', platform: !!u.platform, createdAt: u.createdAt }));
  }
  async deleteUser(username) { return (await this.User.deleteOne({ username: String(username).toLowerCase() })).deletedCount > 0; }
  async setPassword(username, passwordHash) { return (await this.User.updateOne({ username: String(username).toLowerCase() }, { $set: { passwordHash } })).matchedCount > 0; }
  async createTenant({ code, name }) { try { const t = await this.Tenant.create({ code, name }); return { code: t.code, name: t.name, active: t.active }; } catch (e) { if (e.code === 11000) return null; throw e; } }
  async getTenant(code) { const t = await this.Tenant.findOne({ code: String(code).toLowerCase() }).lean(); return t && { code: t.code, name: t.name, active: t.active !== false, createdAt: t.createdAt }; }
  async listTenants() { return (await this.Tenant.find({}).sort({ name: 1 }).lean()).map(t => ({ code: t.code, name: t.name, active: t.active !== false, createdAt: t.createdAt })); }
  async updateTenant(code, patch) { const t = await this.Tenant.findOneAndUpdate({ code: String(code).toLowerCase() }, { $set: patch }, { new: true }).lean(); return t && { code: t.code, name: t.name, active: t.active !== false }; }
  async deleteTenant(code) { return (await this.Tenant.deleteOne({ code: String(code).toLowerCase() })).deletedCount > 0; }
  async deleteUsersOfTenant(code) { return (await this.User.deleteMany({ tenant: String(code).toLowerCase(), platform: { $ne: true } })).deletedCount; }
  async deleteSnapshot(key) { return (await this.Snapshot.deleteOne({ key })).deletedCount > 0; }
  async deleteTx(id) { return (await this.Tx.deleteOne({ id })).deletedCount > 0; }
  async getSnapshot(key) { const s = await this.Snapshot.findOne({ key }).lean(); return s && { data: s.data, version: s.version, staffVersion: s.staffVersion, updatedAt: s.updatedAt, updatedBy: s.updatedBy }; }
  async getSnapshotMeta(key) { const s = await this.Snapshot.findOne({ key }).select('version updatedAt updatedBy').lean(); return s && { version: s.version, updatedAt: s.updatedAt, updatedBy: s.updatedBy }; }
  // portal=true marks a save made by a learner's quiz attempt, so staff devices can tell their own saves from those.
  async saveSnapshot(key, data, baseVersion, by, portal) {
    if (baseVersion == null || baseVersion === 0) {
      try { const s = await this.Snapshot.create({ key, data, version: 1, staffVersion: portal ? 0 : 1, updatedBy: by }); return { ok: true, version: s.version, updatedAt: s.updatedAt }; }
      catch (e) { if (e.code === 11000) return { ok: false }; throw e; }
    }
    const set = portal ? { data, updatedBy: by } : { data, updatedBy: by, staffVersion: baseVersion + 1 };
    const s = await this.Snapshot.findOneAndUpdate({ key, version: baseVersion }, { $set: set, $inc: { version: 1 } }, { new: true }).lean();
    return s ? { ok: true, version: s.version, updatedAt: s.updatedAt } : { ok: false };
  }
}

class MemoryStore {
  constructor() { this.users = new Map(); this.snaps = new Map(); this.txs = new Map(); this.tenants = new Map(); this.n = 0; }
  async saveTx(id, data) { this.txs.set(id, data); }
  async getTx(id) { return this.txs.get(id) || null; }
  async listTx(limit = 200) { return [...this.txs.values()].reverse().slice(0, limit); }
  async connect() {}
  async countUsers() { return this.users.size; }
  async findUser(username) { return this.users.get(String(username).toLowerCase()) || null; }
  async createUser({ username, passwordHash, role, tenant, platform }) { const u = { id: String(++this.n), username, passwordHash, role, tenant, platform: !!platform, createdAt: new Date() }; this.users.set(username, u); return { id: u.id, username, role, tenant, platform: !!platform }; }
  async listUsers(tenant) {
    return [...this.users.values()].filter(u => tenant === undefined || (u.tenant || 'default') === tenant).sort((a, b) => a.username.localeCompare(b.username))
      .map(u => ({ username: u.username, role: u.role, tenant: u.tenant || 'default', platform: !!u.platform, createdAt: u.createdAt }));
  }
  async deleteUser(username) { return this.users.delete(String(username).toLowerCase()); }
  async setPassword(username, passwordHash) { const u = this.users.get(String(username).toLowerCase()); if (!u) return false; u.passwordHash = passwordHash; return true; }
  async createTenant({ code, name }) { if (this.tenants.has(code)) return null; const t = { code, name, active: true, createdAt: new Date() }; this.tenants.set(code, t); return { code, name, active: true }; }
  async getTenant(code) { const t = this.tenants.get(String(code).toLowerCase()); return t ? { ...t } : null; }
  async listTenants() { return [...this.tenants.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({ ...t })); }
  async updateTenant(code, patch) { const t = this.tenants.get(String(code).toLowerCase()); if (!t) return null; Object.assign(t, patch); return { code: t.code, name: t.name, active: t.active }; }
  async deleteTenant(code) { return this.tenants.delete(String(code).toLowerCase()); }
  async deleteUsersOfTenant(code) { let n = 0; for (const [k, u] of [...this.users]) if ((u.tenant || 'default') === String(code).toLowerCase() && !u.platform) { this.users.delete(k); n++; } return n; }
  async deleteSnapshot(key) { return this.snaps.delete(key); }
  async deleteTx(id) { return this.txs.delete(id); }
  async getSnapshot(key) { return this.snaps.get(key) || null; }
  async getSnapshotMeta(key) { const s = this.snaps.get(key); return s && { version: s.version, updatedAt: s.updatedAt, updatedBy: s.updatedBy }; }
  async saveSnapshot(key, data, baseVersion, by, portal) {
    const cur = this.snaps.get(key);
    if (!cur) { if (baseVersion) return { ok: false }; } else if (cur.version !== baseVersion) return { ok: false };
    const version = (cur ? cur.version : 0) + 1, updatedAt = new Date();
    this.snaps.set(key, { data, version, staffVersion: portal ? (cur ? cur.staffVersion : 0) : version, updatedAt, updatedBy: by });
    return { ok: true, version, updatedAt };
  }
}

let store;
async function getStore() {
  if (store) return store;
  const uri = process.env.MONGODB_URI;
  if (uri) { store = new MongoStore(); await store.connect(uri); }
  else if (process.env.NODE_ENV === 'production') throw new Error('MONGODB_URI is required in production');
  else { console.warn('[masms] MONGODB_URI not set — using volatile in-memory store (dev only)'); store = new MemoryStore(); }
  return store;
}
module.exports = { getStore, MemoryStore };
