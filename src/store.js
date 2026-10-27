// Data layer. MongoDB (mongoose) in production, in-memory fallback for local dev/tests.
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 80 },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
}, { timestamps: true });

const snapshotSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },   // one snapshot per installation
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  version: { type: Number, default: 1 },
  updatedBy: String,
}, { timestamps: true });

class MongoStore {
  constructor() { this.User = mongoose.models.User || mongoose.model('User', userSchema); this.Snapshot = mongoose.models.Snapshot || mongoose.model('Snapshot', snapshotSchema); }
  async connect(uri) { if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 }); }
  async countUsers() { return this.User.countDocuments(); }
  async findUser(username) { const u = await this.User.findOne({ username: String(username).toLowerCase() }).lean(); return u && { id: String(u._id), ...u }; }
  async createUser({ username, passwordHash, role }) { const u = await this.User.create({ username, passwordHash, role }); return { id: String(u._id), username: u.username, role: u.role }; }
  async getSnapshot(key) { const s = await this.Snapshot.findOne({ key }).lean(); return s && { data: s.data, version: s.version, updatedAt: s.updatedAt, updatedBy: s.updatedBy }; }
  async saveSnapshot(key, data, baseVersion, by) {
    if (baseVersion == null || baseVersion === 0) {
      try { const s = await this.Snapshot.create({ key, data, version: 1, updatedBy: by }); return { ok: true, version: s.version, updatedAt: s.updatedAt }; }
      catch (e) { if (e.code === 11000) return { ok: false }; throw e; }
    }
    const s = await this.Snapshot.findOneAndUpdate({ key, version: baseVersion }, { $set: { data, updatedBy: by }, $inc: { version: 1 } }, { new: true }).lean();
    return s ? { ok: true, version: s.version, updatedAt: s.updatedAt } : { ok: false };
  }
}

class MemoryStore {
  constructor() { this.users = new Map(); this.snaps = new Map(); this.n = 0; }
  async connect() {}
  async countUsers() { return this.users.size; }
  async findUser(username) { return this.users.get(String(username).toLowerCase()) || null; }
  async createUser({ username, passwordHash, role }) { const u = { id: String(++this.n), username, passwordHash, role }; this.users.set(username, u); return { id: u.id, username, role }; }
  async getSnapshot(key) { return this.snaps.get(key) || null; }
  async saveSnapshot(key, data, baseVersion, by) {
    const cur = this.snaps.get(key);
    if (!cur) { if (baseVersion) return { ok: false }; } else if (cur.version !== baseVersion) return { ok: false };
    const version = (cur ? cur.version : 0) + 1, updatedAt = new Date();
    this.snaps.set(key, { data, version, updatedAt, updatedBy: by });
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
