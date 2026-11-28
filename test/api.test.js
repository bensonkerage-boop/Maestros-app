process.env.AUTH_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';
const app = require('../src/app');
let srv, base;
beforeAll(() => new Promise(r => { srv = app.listen(0, () => r()); }));
afterAll(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = async (m, p, b, t) => {
  base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const backup = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: [] } } };
let admin;

describe('auth', () => {
  test('health is public, data needs a token', async () => {
    expect((await call('GET', '/api/health')).s).toBe(200);
    expect((await call('GET', '/api/data')).s).toBe(401);
    expect((await call('GET', '/api/data', null, 'garbage')).s).toBe(401);
  });
  test('setup is needed until the first account exists', async () => {
    expect((await call('GET', '/api/auth/status')).j.needsSetup).toBe(true);
  });
  test('rejects weak credentials', async () => {
    expect((await call('POST', '/api/auth/register', { username: 'a', password: 'short' })).s).toBe(400);
    expect((await call('POST', '/api/auth/register', {})).s).toBe(400);
  });
  test('first account becomes admin', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'Admin', password: 'password123' });
    expect(r.s).toBe(201); expect(r.j.user).toMatchObject({ username: 'admin', role: 'admin', tenant: 'default', platform: true });
    admin = r.j.token;
    expect((await call('GET', '/api/auth/status')).j.needsSetup).toBe(false);
  });
  test('registration is closed to anonymous users after setup', async () => {
    expect((await call('POST', '/api/auth/register', { username: 'intruder', password: 'password123' })).s).toBe(401);
  });
  test('admin can add staff; staff cannot add users', async () => {
    const st = await call('POST', '/api/auth/register', { username: 'teacher1', password: 'password123' }, admin);
    expect(st.s).toBe(201); expect(st.j.user.role).toBe('staff');
    const stTok = (await call('POST', '/api/auth/login', { username: 'teacher1', password: 'password123' })).j.token;
    expect((await call('POST', '/api/auth/register', { username: 'teacher2', password: 'password123' }, stTok)).s).toBe(403);
    expect((await call('POST', '/api/auth/register', { username: 'TEACHER1', password: 'password123' }, admin)).s).toBe(409);
  });
  test('login is case-insensitive on username and rejects wrong passwords', async () => {
    expect((await call('POST', '/api/auth/login', { username: 'ADMIN', password: 'password123' })).j.token).toBeTruthy();
    expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).s).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'ghost', password: 'password123' })).s).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: { $ne: '' }, password: 'x' })).s).toBe(401);
  });
  test('/me returns the signed-in user', async () => {
    expect((await call('GET', '/api/auth/me', null, admin)).j).toMatchObject({ username: 'admin', role: 'admin', tenant: 'default', platform: true });
  });
});

describe('data', () => {
  test('starts empty', async () => {
    expect((await call('GET', '/api/data', null, admin)).j).toEqual({ version: 0, data: null });
  });
  test('validates the body', async () => {
    expect((await call('PUT', '/api/data', { data: { nope: 1 }, baseVersion: 0 }, admin)).s).toBe(400);
    expect((await call('PUT', '/api/data', { data: [], baseVersion: 0 }, admin)).s).toBe(400);
  });
  test('saves, versions and round-trips', async () => {
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 0 }, admin)).j.version).toBe(1);
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 1 }, admin)).j.version).toBe(2);
    const g = await call('GET', '/api/data', null, admin);
    expect(g.j.version).toBe(2); expect(g.j.data).toEqual(backup); expect(g.j.updatedBy).toBe('admin');
  });
  test('version endpoint reports the latest version without the data', async () => {
    const v = await call('GET', '/api/data/version', null, admin);
    expect(v.s).toBe(200); expect(v.j.version).toBe(2); expect(v.j.updatedBy).toBe('admin'); expect(v.j.data).toBeUndefined();
    expect((await call('GET', '/api/data/version')).s).toBe(401);
  });
  test('stale saves are refused with 409', async () => {
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 0 }, admin)).s).toBe(409);
    expect((await call('PUT', '/api/data', { data: backup, baseVersion: 1 }, admin)).s).toBe(409);
  });
  test('oversized and malformed bodies get clean errors', async () => {
    const big = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin }, body: JSON.stringify({ data: { ...backup, pad: 'x'.repeat(5 * 1024 * 1024) }, baseVersion: 2 }) });
    expect(big.status).toBe(413);
    const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
  });
  test('unknown API routes return JSON 404', async () => {
    const r = await call('GET', '/api/nothing'); expect(r.s).toBe(404); expect(r.j.error).toBeDefined();
  });
});

describe('Download Android app link', () => {
  const get = async () => { base = `http://127.0.0.1:${srv.address().port}`; return fetch(base + '/api/android-apk', { redirect: 'manual' }); };
  afterEach(() => { delete process.env.APK_URL; delete process.env.GITHUB_REPOSITORY; });
  test('404 with a plain message until it is configured', async () => { expect((await get()).status).toBe(404); });
  test('GITHUB_REPOSITORY redirects to the stable android-latest APK', async () => {
    process.env.GITHUB_REPOSITORY = 'maestro/masms';
    const r = await get();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://github.com/maestro/masms/releases/download/android-latest/MASMS.apk');
  });
  test('APK_URL wins, and an odd repository value is ignored', async () => {
    process.env.GITHUB_REPOSITORY = 'bad value;x'; expect((await get()).status).toBe(404);
    process.env.APK_URL = 'https://example.test/a.apk';
    expect((await get()).headers.get('location')).toBe('https://example.test/a.apk');
  });
  test('an APK bundled on this site is given directly from the site itself (same address as the website)', async () => {
    const f = require('path').join(require('os').tmpdir(), 'masms-test.apk'); require('fs').writeFileSync(f, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(200 * 1024)]));
    process.env.APK_FILE = f; process.env.GITHUB_REPOSITORY = 'maestro/masms';
    try { const r = await get(); expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/downloads/MASMS.apk'); }
    finally { delete process.env.APK_FILE; require('fs').unlinkSync(f); }
  });
  test('the update feed offers the same link to sideloaded installs', async () => {
    process.env.GITHUB_REPOSITORY = 'maestro/masms';
    expect((await call('GET', '/api/app-version')).j.downloadUrl).toMatch(/releases\/download\/android-latest\/MASMS\.apk$/);
  });
});

describe('app update version feed', () => {
  test('is public and returns the numbers the Android app compares', async () => {
    process.env.APP_LATEST_VERSION_CODE = '7'; process.env.APP_MIN_VERSION_CODE = 'abc';
    const r = await call('GET', '/api/app-version');
    expect(r.s).toBe(200);
    expect(r.j.latestVersionCode).toBe(7);
    expect(r.j.minVersionCode).toBe(0);
    expect(r.j.downloadUrl).toMatch(/play\.google\.com.*com\.maestro\.masms/);
    delete process.env.APP_LATEST_VERSION_CODE; delete process.env.APP_MIN_VERSION_CODE;
  });
});

describe('web page (landing content)', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const content = { hero: { heading: 'Hello', text: 'Intro' }, contacts: { phone: '0700000000', email: 'a@b.co' }, gallery: [{ title: 'Open day', caption: 'c', src: png }, { title: 'bad', src: 'javascript:alert(1)' }] };
  test('anyone can read it; nothing saved yet', async () => {
    const r = await call('GET', '/api/web-page');
    expect(r.s).toBe(200);
    expect(r.j.content).toBeNull();
  });
  test('saving needs a cloud sign-in', async () => {
    expect((await call('PUT', '/api/web-page', { content })).s).toBe(401);
  });
  test('admin saves; the public read returns it with unsafe photos dropped', async () => {
    const put = await call('PUT', '/api/web-page', { content }, admin);
    expect(put.s).toBe(200);
    const got = (await call('GET', '/api/web-page')).j.content;
    expect(got.hero.heading).toBe('Hello');
    expect(got.contacts.phone).toBe('0700000000');
    expect(got.gallery).toHaveLength(1);
    expect(got.gallery[0].src).toBe(png);
  });
  test('card edits are saved; unsafe photos and links are dropped', async () => {
    const cards = { fees: { img: png, title: 'Fees', text: 'T', link: 'https://example.com/x', linkLabel: 'Read more' }, nemis: { img: 'javascript:alert(1)', link: 'javascript:alert(1)', title: 'N' }, bogus: { title: 'x' } };
    expect((await call('PUT', '/api/web-page', { content: { ...content, cards } }, admin)).s).toBe(200);
    const got = (await call('GET', '/api/web-page')).j.content.cards;
    expect(got.fees).toEqual({ img: png, title: 'Fees', text: 'T', link: 'https://example.com/x', linkLabel: 'Read more' });
    expect(got.nemis.img).toBe(''); expect(got.nemis.link).toBe(''); expect(got.nemis.title).toBe('N');
    expect(got.bogus).toBeUndefined();
  });
  test('rejects a body without content', async () => {
    expect((await call('PUT', '/api/web-page', { nope: 1 }, admin)).s).toBe(400);
  });
});


describe('several schools on one server', () => {
  const login = async (username, password = 'password123') => (await call('POST', '/api/auth/login', { username, password })).j.token;
  const bk = name => ({ schools: [name], currentSchool: name, schoolData: { [name]: { students: [{ n: name + ' student' }] } } });
  let greenAdmin, hillAdmin;

  test('only the platform owner can create schools; each gets its own admin', async () => {
    const t1 = await call('POST', '/api/auth/login', { username: 'teacher1', password: 'password123' });
    expect((await call('POST', '/api/schools', { name: 'X School', adminUsername: 'xadmin', adminPassword: 'password123' }, t1.j.token)).s).toBe(403);
    expect((await call('GET', '/api/schools', null, t1.j.token)).s).toBe(403);
    const a = await call('POST', '/api/schools', { name: 'Green Valley Academy', adminUsername: 'green.admin', adminPassword: 'password123' }, admin);
    expect(a.s).toBe(201); expect(a.j.school.code).toBe('green-valley-academy');
    const b = await call('POST', '/api/schools', { name: 'Hill Top School', adminUsername: 'hill.admin', adminPassword: 'password123' }, admin);
    expect(b.s).toBe(201);
    expect((await call('POST', '/api/schools', { name: 'Green Valley Academy', adminUsername: 'other', adminPassword: 'password123' }, admin)).j.school.code).toBe('green-valley-academy-2');
    expect((await call('POST', '/api/schools', { name: 'Dup', adminUsername: 'green.admin', adminPassword: 'password123' }, admin)).s).toBe(409);
    greenAdmin = await login('green.admin'); hillAdmin = await login('hill.admin');
    const me = await call('GET', '/api/auth/me', null, greenAdmin);
    expect(me.j).toMatchObject({ role: 'admin', tenant: 'green-valley-academy', tenantName: 'Green Valley Academy', platform: false });
    const list = await call('GET', '/api/schools', null, admin);
    expect(list.j.schools.map(x => x.code)).toEqual(expect.arrayContaining(['default', 'green-valley-academy', 'hill-top-school']));
  });

  test('every school sees only its own data', async () => {
    expect((await call('GET', '/api/data', null, greenAdmin)).j).toEqual({ version: 0, data: null });   // new school starts empty
    expect((await call('PUT', '/api/data', { data: bk('Green'), baseVersion: 0 }, greenAdmin)).j.version).toBe(1);
    expect((await call('PUT', '/api/data', { data: bk('Hill'), baseVersion: 0 }, hillAdmin)).j.version).toBe(1);   // same baseVersion 0: no clash, separate record
    expect((await call('GET', '/api/data', null, greenAdmin)).j.data).toEqual(bk('Green'));
    expect((await call('GET', '/api/data', null, hillAdmin)).j.data).toEqual(bk('Hill'));
    const main = await call('GET', '/api/data', null, admin);
    expect(main.j.version).toBe(2); expect(JSON.stringify(main.j.data)).not.toMatch(/Green|Hill/);   // the first school is untouched
    expect((await call('GET', '/api/data/version', null, greenAdmin)).j.version).toBe(1);
  });

  test('a school admin cannot reach another school by naming it', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'sneaky', password: 'password123', tenant: 'hill-top-school', role: 'admin' }, greenAdmin);
    expect(r.s).toBe(201); expect(r.j.user.tenant).toBe('green-valley-academy');                      // the tenant field is ignored for non-platform users
    const users = await call('GET', '/api/users?tenant=hill-top-school', null, greenAdmin);
    expect(users.j.tenant).toBe('green-valley-academy');
    expect(users.j.users.map(u => u.username)).toEqual(expect.arrayContaining(['green.admin', 'sneaky']));
    expect(users.j.users.map(u => u.username)).not.toContain('hill.admin');
    expect((await call('DELETE', '/api/users/hill.admin', null, greenAdmin)).s).toBe(403);
    expect((await call('PUT', '/api/users/hill.admin/password', { password: 'newpassword1' }, greenAdmin)).s).toBe(403);
    expect((await call('DELETE', '/api/users/admin', null, greenAdmin)).s).toBe(403);               // nor the platform owner
  });

  test('removing a user, or suspending a school, cuts access straight away', async () => {
    const tok = await login('sneaky');
    expect((await call('GET', '/api/data/version', null, tok)).s).toBe(200);
    expect((await call('DELETE', '/api/users/sneaky', null, greenAdmin)).s).toBe(200);
    expect((await call('GET', '/api/data/version', null, tok)).s).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'sneaky', password: 'password123' })).s).toBe(401);
    expect((await call('DELETE', '/api/users/green.admin', null, greenAdmin)).s).toBe(400);          // cannot remove yourself
    expect((await call('PATCH', '/api/schools/hill-top-school', { active: false }, greenAdmin)).s).toBe(403);
    expect((await call('PATCH', '/api/schools/hill-top-school', { active: false }, admin)).s).toBe(200);
    expect((await call('GET', '/api/data', null, hillAdmin)).s).toBe(403);
    expect((await call('POST', '/api/auth/login', { username: 'hill.admin', password: 'password123' })).s).toBe(403);
    expect((await call('GET', '/api/data', null, greenAdmin)).s).toBe(200);                         // other schools are unaffected
    expect((await call('PATCH', '/api/schools/hill-top-school', { active: true }, admin)).s).toBe(200);
    expect((await call('GET', '/api/data', null, hillAdmin)).s).toBe(200);
    expect((await call('PATCH', '/api/schools/default', { active: false }, admin)).s).toBe(400);     // not your own school
  });

  test('last admin of a school cannot be removed; passwords can be changed and reset', async () => {
    await call('POST', '/api/auth/register', { username: 'green.teacher', password: 'password123' }, greenAdmin);
    expect((await call('PUT', '/api/users/green.teacher/password', { password: 'short' }, greenAdmin)).s).toBe(400);
    expect((await call('PUT', '/api/users/green.teacher/password', { password: 'resetpass99' }, greenAdmin)).s).toBe(200);
    expect((await call('POST', '/api/auth/login', { username: 'green.teacher', password: 'password123' })).s).toBe(401);
    const tt = await login('green.teacher', 'resetpass99');
    expect((await call('GET', '/api/users', null, tt)).s).toBe(403);                                  // staff cannot list/manage users
    expect((await call('POST', '/api/auth/password', { current: 'wrong', password: 'mynewpass88' }, tt)).s).toBe(401);
    expect((await call('POST', '/api/auth/password', { current: 'resetpass99', password: 'mynewpass88' }, tt)).s).toBe(200);
    expect((await login('green.teacher', 'mynewpass88'))).toBeTruthy();
    await call('POST', '/api/auth/register', { username: 'green.admin2', password: 'password123', role: 'admin' }, greenAdmin);
    expect((await call('DELETE', '/api/users/green.admin2', null, admin)).s).toBe(200);             // platform owner may manage any school
    expect((await call('DELETE', '/api/users/green.admin', null, admin)).s).toBe(400);               // would leave the school with no admin
  });

  test('only the platform owner edits the public web page', async () => {
    expect((await call('PUT', '/api/web-page', { content: { hero: {}, contacts: {}, gallery: [] } }, greenAdmin)).s).toBe(403);
  });
});

// Speed: the browser sends big uploads gzip-compressed (Content-Encoding: gzip); the server inflates them before its size check.
describe('gzip-compressed upload', () => {
  test('PUT /api/data accepts a gzip body and stores the same data', async () => {
    const zlib = require('zlib');
    const data = { schools: ['S'], currentSchool: 'S', schoolData: { S: { students: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'Learner ' + i, note: 'x'.repeat(50) })) } } };
    const cur = await call('GET', '/api/data/version', null, admin);
    const raw = JSON.stringify({ data, baseVersion: cur.j.version || 0 });
    const gz = zlib.gzipSync(raw); expect(gz.length).toBeLessThan(raw.length / 3);
    const r = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: 'Bearer ' + admin }, body: gz });
    expect(r.status).toBe(200);
    const get = await call('GET', '/api/data', null, admin);
    expect(get.j.data.schoolData.S.students.length).toBe(400);
  });
});
