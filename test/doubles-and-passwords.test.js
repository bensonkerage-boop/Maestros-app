// Runs the REAL functions out of the app source (no copies) in a small vm sandbox.
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');

// top-level `function name(` ... closing `}` at column 0
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const end = src.indexOf('\n}\n', i);
  return src.slice(i + 1, end + 3);
}
const constSrc = name => { const m = src.match(new RegExp('\\nconst ' + name + ' = [^;]*;')); if (!m) throw new Error('const not found: ' + name); return m[0]; };

// ---------------------------------------------------------------------------
describe('no back-to-back doubles', () => {
  const DAY = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const mkPeriods = () => [
    ...[1, 2, 3, 4, 5].map(n => ({ id: 'p' + n, isBreak: false })),
    { id: 'break1', isBreak: true },
    ...[6, 7].map(n => ({ id: 'p' + n, isBreak: false })),
    { id: 'tea', isBreak: true },
    ...[8, 9].map(n => ({ id: 'p' + n, isBreak: false })),
    { id: 'lunch', isBreak: true },
    ...[10, 11, 12, 13].map(n => ({ id: 'p' + n, isBreak: false })),
  ];

  // Only the doubles pass of autoFillClassTimetable: cut the real function at
  // the next pass so later single-lesson fill can't blur what we measure.
  function doublesPassOnly() {
    const full = fnSrc('autoFillClassTimetable');
    const cut = full.indexOf('  // ---- Daily-coverage pass');
    expect(cut).toBeGreaterThan(0);
    return full.slice(0, cut) + '  return { placed, skipped };\n}\n';
  }
  function sandbox({ days = DAY, periods = mkPeriods(), classOff = () => '' } = {}) {
    const code = [
      'let TIMETABLE_DAYS = ' + JSON.stringify(days) + ';',
      'let timetablePeriods = ' + JSON.stringify(periods) + ';',
      'let timetableData = {}; let teachersList = [];',
      constSrc('CBC_SCIENCE_SUBJECTS'),
      'const EIGHT44_LESSON_TABLE = [];',
      'const CBC_SS_CORE = [];',
      'const classOff = ' + classOff.toString() + ';',
      'function teacherFullName(t){ return t.name; }',
      'function timetableClassKey(c){ return c.grade + "||" + c.stream; }',
      'function ttDivisionGroupSubjects(){ return new Set(); }',
      'function ttPlaceSupportivePrograms(){ return 0; }',
      'function timetableSubjectTimeOffAt(){ return ""; }',
      'function timetableClassTimeOffAt(day, pid){ return classOff(day, pid); }',
      'function timetableTeacherConflict(){ return false; }',
      'function timetableTeacherTimeOffAt(){ return ""; }',
      ...['ttShuffle', 'ttNoFollowGroup', 'ttNoFollowClash', 'timetableAdjacentPeriodPairs', 'subjectDoublesPerWeek', 'ttIsPESubject', 'ttBreakAdjacentPeriodIds', 'ttPEAllowedAt', 'ttDailyCoverageSubjects']
        .map(fnSrc),
      doublesPassOnly(),
      'this.run = classObj => { timetableData = {}; const r = autoFillClassTimetable(classObj); return { r, data: timetableData[timetableClassKey(classObj)] }; };',
      'this.periods = timetablePeriods;',
    ].join('\n');
    const ctx = {};
    vm.runInNewContext(code, ctx);
    return ctx;
  }
  // Runs of the same science subject in adjacent lesson periods = a double.
  function doublesOf(data, periods) {
    const out = []; // {day, i} first period index of each double
    Object.keys(data).forEach(day => {
      for (let i = 0; i < periods.length - 1; i++) {
        const a = data[day][periods[i].id], b = data[day][periods[i + 1].id];
        if (!periods[i].isBreak && !periods[i + 1].isBreak && a && b && a.subject === b.subject) out.push({ day, i, subject: a.subject });
      }
    });
    return out;
  }
  const touching = (d, periods) => d.some((x, xi) => d.some((y, yi) => xi !== yi && x.day === y.day && y.i === x.i + 2));

  test('4 science doubles in a normal week: never touching, 300 runs, always all placed', () => {
    const sb = sandbox();
    const cls = { grade: 'Form 3', stream: 'A', subjects: ['Biology', 'Chemistry', 'Physics', 'General Science', 'English'] };
    let touch = 0, missing = 0;
    for (let n = 0; n < 300; n++) {
      const { data } = sb.run(cls);
      const d = doublesOf(data, sb.periods);
      if (d.length !== 4) missing++;
      if (touching(d, sb.periods)) touch++;
    }
    expect(missing).toBe(0);
    expect(touch).toBe(0);
  });

  test('retries so a valid spread is found even when a first pick would box it in (window p1-p5, two doubles)', () => {
    // Only p1..p5 usable on Monday: p1p2 + p4p5 is the one non-touching layout.
    const sb = sandbox({ days: ['MONDAY'], classOff: (day, pid) => (['p1', 'p2', 'p3', 'p4', 'p5'].includes(pid) ? '' : 'unavailable') });
    const cls = { grade: 'F', stream: 'B', subjects: ['Biology', 'Chemistry'] };
    let touch = 0, missing = 0;
    for (let n = 0; n < 300; n++) {
      const { data } = sb.run(cls);
      const d = doublesOf(data, sb.periods);
      if (d.length !== 2) missing++;
      if (touching(d, sb.periods)) touch++;
    }
    expect(missing).toBe(0);
    expect(touch).toBe(0);
  });

  test('relaxed only when no other slot exists: a 4-period window forces two doubles to touch, both still placed', () => {
    const sb = sandbox({ days: ['MONDAY'], classOff: (day, pid) => (['p1', 'p2', 'p3', 'p4'].includes(pid) ? '' : 'unavailable') });
    const cls = { grade: 'F', stream: 'C', subjects: ['Biology', 'Chemistry'] };
    for (let n = 0; n < 50; n++) {
      const { data } = sb.run(cls);
      const d = doublesOf(data, sb.periods);
      expect(d.length).toBe(2);
      expect(touching(d, sb.periods)).toBe(true);   // unavoidable here, and tolerated
    }
  });

  test('a break between two doubles counts as a gap (not "touching")', () => {
    // p5 | break | p6: doubles p4p5 and p6p7 are separated by the short break.
    const sb = sandbox({ days: ['MONDAY'], classOff: (day, pid) => (['p4', 'p5', 'p6', 'p7'].includes(pid) ? '' : 'unavailable') });
    const cls = { grade: 'F', stream: 'D', subjects: ['Biology', 'Chemistry'] };
    for (let n = 0; n < 50; n++) {
      const { data } = sb.run(cls);
      const d = doublesOf(data, sb.periods);
      expect(d.map(x => x.i).sort()).toEqual([3, 6]);   // p4p5 (index 3) and p6p7 (index 6)
    }
  });
});

// ---------------------------------------------------------------------------
describe('welcome password + forced change', () => {
  const ctx = {};
  beforeAll(() => {
    const code = [
      constSrc('WELCOME_PASSWORD'), constSrc('PW_MIN_LENGTH'), constSrc('PW_HASH_ROUNDS'),
      'let systemUsers = []; let teachersList = []; let staffList = [];',
      'function teacherFullName(t){ return t.name; }',
      ...['userFirstName', 'userLastName', 'loginPhoneKey', 'staffPhoneForUser', 'pwSha256Hex', 'pwHashWithSalt', 'pwNewSalt', 'userNeedsPasswordChange', 'userPasswordOk', 'passwordProblems', 'setUserPassword'].map(fnSrc),
      'this.api = { WELCOME_PASSWORD, pwSha256Hex, pwHashWithSalt, userNeedsPasswordChange, userPasswordOk, passwordProblems, setUserPassword, setUsers: u => { systemUsers = u; }, getUsers: () => systemUsers, setStaff: s => { staffList = s; } };',
    ].join('\n');
    vm.runInNewContext(code, Object.assign(ctx, { TextEncoder, crypto: crypto.webcrypto }));
  });

  test('the in-page SHA-256 matches node crypto (ascii, unicode, block boundaries)', () => {
    ['', 'abc', 'welcome', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(200), 'Mwalimu ñandú 🔑'].forEach(m =>
      expect(ctx.api.pwSha256Hex(m)).toBe(crypto.createHash('sha256').update(m, 'utf8').digest('hex')));
  });

  test('an account with no password of its own accepts only the welcome password and must change it', () => {
    const u = { name: 'Jane Wanjiku', email: 'j@x.ke', role: 'Teacher', status: 'Active' };
    expect(ctx.api.userNeedsPasswordChange(u)).toBe(true);
    expect(ctx.api.userPasswordOk(u, ctx.api.WELCOME_PASSWORD)).toBe(true);
    expect(ctx.api.userPasswordOk(u, 'wanjiku')).toBe(false);          // old surname password no longer works
    expect(ctx.api.userPasswordOk(u, 'Welcome')).toBe(true);            // welcome password ignores case
    expect(ctx.api.userPasswordOk(u, 'welcome1')).toBe(false);
  });

  test('after choosing a password: stored hashed, welcome password stops working, own one works', () => {
    const u = { name: 'Jane Wanjiku', email: 'j@x.ke', role: 'Teacher', status: 'Active' };
    ctx.api.setUsers([u]);
    const upd = ctx.api.setUserPassword(u, 'Sunrise#2026');
    expect(JSON.stringify(upd)).not.toContain('Sunrise#2026');          // never stored in clear
    expect(ctx.api.getUsers()[0]).toBe(upd);
    expect(upd.mustChange).toBe(false);
    expect(ctx.api.userNeedsPasswordChange(upd)).toBe(false);
    expect(ctx.api.userPasswordOk(upd, 'Sunrise#2026')).toBe(true);
    expect(ctx.api.userPasswordOk(upd, ctx.api.WELCOME_PASSWORD)).toBe(false);
    expect(ctx.api.userPasswordOk(upd, 'sunrise#2026')).toBe(false);
  });

  test('two users choosing the same password get different salts and hashes', () => {
    const a = ctx.api.setUserPassword({ name: 'A One', email: 'a' }, 'Same#Pass1');
    const b = ctx.api.setUserPassword({ name: 'B Two', email: 'b' }, 'Same#Pass1');
    expect(a.pw.s).not.toBe(b.pw.s);
    expect(a.pw.h).not.toBe(b.pw.h);
  });

  test('an admin reset (mustChange) puts the account back on the welcome password', () => {
    const own = ctx.api.setUserPassword({ name: 'Jane Wanjiku', email: 'j' }, 'Sunrise#2026');
    const reset = { ...own, mustChange: true }; delete reset.pw;
    expect(ctx.api.userNeedsPasswordChange(reset)).toBe(true);
    expect(ctx.api.userPasswordOk(reset, ctx.api.WELCOME_PASSWORD)).toBe(true);
  });

  test('password rules', () => {
    const u = { name: 'Jane Wanjiku', email: 'j' };
    expect(ctx.api.passwordProblems('Sunrise#2026', u)).toEqual([]);
    expect(ctx.api.passwordProblems('short1', u).length).toBeGreaterThan(0);
    expect(ctx.api.passwordProblems('onlyletters', u).length).toBeGreaterThan(0);
    expect(ctx.api.passwordProblems('12345678', u).length).toBeGreaterThan(0);
    expect(ctx.api.passwordProblems('WELCOME', u)).toContain('Different from the welcome password');
    expect(ctx.api.passwordProblems('Wanjiku', u)).toContain('Not just your name or phone number');
  });
});

describe('login wiring (source checks)', () => {
  test('staff login uses the welcome/own-password check and stops at the change screen before entering the app', () => {
    expect(src).toMatch(/userPasswordOk\(u, passwordRaw\)/);
    expect(src).not.toMatch(/userLastName\(u\.name\)\.toLowerCase\(\) === password/);
    const fn = src.slice(src.indexOf('function submitLoginCore0'), src.indexOf('function logout'));
    const iChange = fn.indexOf('openForcedPasswordChange(matchedUser');
    const iEnter = fn.indexOf('completeStaffLogin(matchedUser)');
    expect(iChange).toBeGreaterThan(0);
    expect(iChange).toBeLessThan(iEnter);                         // change screen is checked first
    expect(fn.slice(iChange, iEnter)).toMatch(/return;/);          // and returns without logging in
  });
  test('a pending password change is not logged as a failed login', () => {
    expect(src).toMatch(/else if\(!isLoggedIn && !pwChangePending\)/);
  });
  test('Users & Roles can reset a password back to the welcome password', () => {
    expect(src).toMatch(/onclick="resetUserPassword\(\$\{systemUsers\.indexOf\(u\)\}\)"/);
  });
  test('the welcome password is shown to admins in Users & Roles, not on the public login page', () => {
    const login = src.slice(src.indexOf('function renderLoginPage'), src.indexOf('function openCreateAccount'));
    expect(login).not.toContain('WELCOME_PASSWORD');
    expect(login).not.toContain('Welcome@');
  });
});

describe('teachers without an account can sign in with the welcome password', () => {
  const run = (users, teachers, uname, pw) => {
    const ctx = {};
    vm.runInNewContext([
      constSrc('WELCOME_PASSWORD'),
      'let systemUsers = ' + JSON.stringify(users) + '; let teachersList = ' + JSON.stringify(teachers) + '; let staffList = [];',
      'const SUPER_ADMIN_RESPONSIBILITIES = ["Principal"];',
      'function teacherFullName(t){ return t.name; }',
      'function teacherHasSuperAdminResponsibility(n){ return teachersList.some(t => t.name === n && SUPER_ADMIN_RESPONSIBILITIES.includes(t.responsibility)); }',
      ...['userFirstName', 'loginPhoneKey', 'teacherWelcomeCandidate'].map(fnSrc),
      'this.out = teacherWelcomeCandidate(' + JSON.stringify(uname) + ', ' + JSON.stringify(pw) + ');',
    ].join('\n'), ctx);
    return ctx.out;
  };
  const jane = { name: 'Jane Wanjiku', phone: '0700000001' };
  test('phone number + welcome creates a Teacher candidate (last 9 digits, any format)', () => {
    ['0700000001', '+254700000001', '700 000 001'].forEach(u => expect(run([], [jane], u, 'welcome')).toMatchObject({ name: 'Jane Wanjiku', role: 'Teacher' }));
    expect(run([], [jane], '0700000001', 'WELCOME')).not.toBeNull();
  });
  test('wrong password, unknown phone, or existing account gives no candidate', () => {
    expect(run([], [jane], '0700000001', 'wanjiku')).toBeNull();
    expect(run([], [jane], '0711111111', 'welcome')).toBeNull();
    expect(run([{ name: 'Jane Wanjiku', email: 'j' }], [jane], '0700000001', 'welcome')).toBeNull();
  });
  test('first name works only when exactly one teacher has it; Principal becomes Super Admin', () => {
    expect(run([], [jane], 'Jane', 'welcome')).not.toBeNull();
    expect(run([], [jane, { name: 'Jane Otieno', phone: '0722222222' }], 'Jane', 'welcome')).toBeNull();
    expect(run([], [{ name: 'Paul Kamau', phone: '0733333333', responsibility: 'Principal' }], '0733333333', 'welcome').role).toBe('Super Admin');
  });
});
