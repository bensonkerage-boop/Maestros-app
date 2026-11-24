// Staff sign-in that needs no cloud sign-in on the device. A person types the same details they use on the login page (phone number
// or their generated user name such as janekamau@alphasenior, plus password); the server finds the school that holds that staff
// account, checks the password against the school's saved data, and returns a token for THAT school only. The device then loads
// the school's data by itself and the app's normal login carries on. This file is the server's copy of the app's login rules
// (loginSchoolSuffix, userLoginName, userPasswordOk, teacherWelcomeCandidate in the app) so both agree on who is who.
const { pwHash } = require('./recover');

const arr = v => (Array.isArray(v) ? v : []);
const WELCOME = 'welcome';
const words = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
const phoneKey = v => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const teacherFull = t => [t.firstName, t.otherNames, t.surname].filter(Boolean).join(' ');
const lc = v => String(v == null ? '' : v).trim().toLowerCase();

// "Alpha Senior School" at level Senior -> "alphasenior"; a school not in the registry counts as senior (same as the app)
function schoolSuffix(schoolName, level) {
  const w = words(schoolName);
  while (w.length > 1 && /^(school|schools)$/.test(w[w.length - 1])) w.pop();
  let base = w.join('');
  const lv = level ? String(level).toLowerCase() : '';
  if (lv && !base.endsWith(lv)) base += lv;
  return base;
}
const levelOf = (data, school) => {
  const rec = arr(data && data.platform && data.platform.sdSchools).find(x => x && x.name === school);
  return rec ? (rec.level ? String(rec.level).toLowerCase() : '') : 'senior';
};
const loginName = (fullName, school, level) => { const w = words(fullName).slice(0, 2).join(''); return w ? w + '@' + schoolSuffix(school, level) : ''; };
const needsChange = u => !!u && (!u.pw || !u.pw.h || u.mustChange === true);
const passwordOk = (u, raw) => !!u && (needsChange(u) ? lc(raw) === WELCOME : !!u.pw.s && pwHash(u.pw.s, raw) === u.pw.h);
const staffPhone = (u, ds) => {
  const nm = lc(u && u.name); if (!nm) return '';
  const t = arr(ds.teachersList).find(x => x && lc(teacherFull(x)) === nm); if (t && t.phone) return t.phone;
  const st = arr(ds.staffList).find(x => x && lc(x.name) === nm);
  return (st && st.phone) || (u && u.phone) || '';
};

// One tenant's saved data: the school and staff member that these details sign in, or null.
function findStaffLogin(data, typedRaw, passwordRaw) {
  const typed = lc(typedRaw), pw = String(passwordRaw == null ? '' : passwordRaw).trim(), key = phoneKey(typedRaw);
  if (!typed || !pw || !data || !data.schoolData) return null;
  // A tenant that holds several schools is the platform owner's own working copy, never a school's cloud space: nobody signs in to it this way.
  if (Object.keys(data.schoolData).length > 1) return null;
  for (const school of Object.keys(data.schoolData)) {
    const level = levelOf(data, school), ds = data.schoolData[school] || {}, users = arr(ds.systemUsers);
    if (typed.includes('@') && schoolSuffix(school, level) !== typed.split('@').pop()) continue;
    const u = users.find(x => x && x.role !== 'System Developer' && x.role !== 'Sales Agent' && x.status !== 'Inactive' &&
      (loginName(x.name, school, level) === typed || (key && phoneKey(staffPhone(x, ds)) === key)) && passwordOk(x, pw));
    if (u) return { school, name: u.name };
    if (lc(pw) === WELCOME) {   // a teacher added to the Teachers list who has no login yet signs in with the welcome password
      const free = arr(ds.teachersList).filter(t => { const f = lc(teacherFull(t)); return f && !users.some(x => x && lc(x.name) === f); });
      const byPhone = key ? free.filter(t => phoneKey(t.phone) === key) : [];
      const byFirst = free.filter(t => loginName(teacherFull(t), school, level) === typed);
      const t = byPhone.length === 1 ? byPhone[0] : (!byPhone.length && byFirst.length === 1 ? byFirst[0] : null);
      if (t) return { school, name: teacherFull(t) };
    }
  }
  return null;
}
module.exports = { findStaffLogin, schoolSuffix, loginName };
