// Sign-in directory: a small copy of "who can sign in" for one school, kept by the server next to (not inside) the school's big data
// snapshot. The snapshot can be too large to upload (4 MB request limit, 16 MB document limit) or may simply not have been uploaded yet,
// and sign-in used to depend on it. The directory only holds the fields the sign-in rules read (staff users, teachers, staff list,
// learners' admission numbers and guardian phones), with photos and other long values dropped, so it always fits.
// It has the same shape as the snapshot where it matters, so findStaffLogin() and matchPortalStudent() work on it unchanged.
const arr = v => (Array.isArray(v) ? v : []);
const MAX_STR = 200, MAX_ITEMS = 20, MAX_RECORDS = 20000;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// keep a record's short primitive fields (and short lists of them); long strings (photos, notes) and nested objects are dropped
function slim(rec) {
  if (!isObj(rec)) return null;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if ((k === 'pw' || k === 'parentPw') && isObj(v)) { if (typeof v.s === 'string' && typeof v.h === 'string' && v.s.length < 100 && v.h.length < 200) out[k] = { s: v.s, h: v.h }; continue; }
    if (typeof v === 'string') { if (v.length <= MAX_STR) out[k] = v; }
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= MAX_ITEMS && v.every(x => (typeof x === 'string' && x.length <= MAX_STR) || typeof x === 'number')) out[k] = v;
  }
  return out;
}
const slimList = (list) => arr(list).slice(0, MAX_RECORDS).map(slim).filter(Boolean);

// data: a MASMS backup object ({schools, schoolData, platform}). Returns the directory object, or null if it is not one.
function buildDirectory(data) {
  if (!isObj(data) || !isObj(data.schoolData)) return null;
  const out = { schools: arr(data.schools).filter(s => typeof s === 'string').slice(0, 50), schoolData: {}, platform: { sdSchools: slimList(data.platform && data.platform.sdSchools), saAgents: slimList(data.platform && data.platform.saAgents) } };
  for (const school of Object.keys(data.schoolData).slice(0, 50)) {
    const ds = isObj(data.schoolData[school]) ? data.schoolData[school] : {};
    out.schoolData[school] = { systemUsers: slimList(ds.systemUsers), teachersList: slimList(ds.teachersList), staffList: slimList(ds.staffList), students: slimList(ds.students) };
  }
  return out;
}
const dirKey = code => 'dir:' + String(code).toLowerCase();
async function saveDirectory(store, code, data) {
  const d = buildDirectory(data);
  if (!d) return false;
  await store.saveTx(dirKey(code), { savedAt: new Date().toISOString(), data: d });
  return true;
}
async function getDirectory(store, code) { const r = await store.getTx(dirKey(code)); return r && r.data ? r.data : null; }
module.exports = { buildDirectory, saveDirectory, getDirectory };
