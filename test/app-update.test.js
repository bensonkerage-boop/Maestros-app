const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'app-update.js'), 'utf8');

function boot({ plugins, server, platform = 'android' }) {
  const listeners = {}, calls = [], store = {};
  const body = { children: [], appendChild(e) { this.children.push(e); } };
  const mkEl = () => ({ style: {}, childNodes: [], appendChild(c) { this.childNodes.push(c); }, setAttribute() {}, set textContent(v) { this.t = v; }, get textContent() { return this.t; }, parentNode: null });
  const win = {
    Capacitor: { isNativePlatform: () => platform === 'android', getPlatform: () => platform, Plugins: plugins },
    MASMS_API_BASE: 'https://x.test', addEventListener() {}, open: u => { calls.push(['open', u]); return {}; },
    MASMS_LOCAL: { saveNow: () => { calls.push(['saved']); return Promise.resolve(); } }
  };
  const ctx = {
    window: win, document: { body, createElement: mkEl, addEventListener() {}, hidden: false },
    navigator: { onLine: true }, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    fetch: async () => ({ ok: true, json: async () => server }), setTimeout: fn => { ctx._t = fn; return 1; }, clearTimeout() {}, setInterval() {},
    AbortController, Promise, parseInt, JSON, Date, location: {}
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { win, body, calls, store };
}
const flat = e => [e.textContent, ...(e.childNodes || []).flatMap(flat)];
const texts = body => body.children.flatMap(flat);

test('script parses and exposes MASMS_UPDATE', () => {
  const { win } = boot({ plugins: {} }); expect(typeof win.MASMS_UPDATE.check).toBe('function');
});

test('Play install: offers a flexible update, and urgent updates run the immediate flow after saving', async () => {
  let immediate = 0;
  const AU = { getAppUpdateInfo: async () => ({ updateAvailability: 2, flexibleUpdateAllowed: true, immediateUpdateAllowed: true, availableVersionCode: '9', updatePriority: 0 }), startFlexibleUpdate: async () => ({ code: 0 }), performImmediateUpdate: async () => { immediate++; }, addListener() {} };
  let t = boot({ plugins: { AppUpdate: AU } });
  await t.win.MASMS_UPDATE.check();
  expect(texts(t.body)).toContain('Update available');
  expect(texts(t.body)).toContain('Update now');
  AU.getAppUpdateInfo = async () => ({ updateAvailability: 2, flexibleUpdateAllowed: true, immediateUpdateAllowed: true, availableVersionCode: '9', updatePriority: 5 });
  t = boot({ plugins: { AppUpdate: AU } });
  await t.win.MASMS_UPDATE.check(); await new Promise(r => setTimeout(r, 10));
  expect(immediate).toBe(1); expect(t.calls).toContainEqual(['saved']);
});

test('Play says up to date: no banner', async () => {
  const AU = { getAppUpdateInfo: async () => ({ updateAvailability: 1 }), addListener() {} };
  const t = boot({ plugins: { AppUpdate: AU } });
  await t.win.MASMS_UPDATE.check(); expect(t.body.children.length).toBe(0);
});

test('APK install (Play check fails): compares build number with /api/app-version', async () => {
  const AU = { getAppUpdateInfo: async () => { throw new Error('not from Play'); } };
  const App = { getInfo: async () => ({ build: '3' }) };
  let t = boot({ plugins: { AppUpdate: AU, App }, server: { latestVersionCode: 5, minVersionCode: 4, latestVersionName: '1.5', downloadUrl: 'https://x.test/a.apk' } });
  await t.win.MASMS_UPDATE.check();
  expect(texts(t.body)).toContain('Update required');           // 3 < min 4: no "Later" button
  expect(texts(t.body)).not.toContain('Later');
  t = boot({ plugins: { AppUpdate: AU, App }, server: { latestVersionCode: 5, minVersionCode: 0, downloadUrl: 'https://x.test/a.apk' } });
  await t.win.MASMS_UPDATE.check();
  expect(texts(t.body)).toContain('Later');
  t = boot({ plugins: { AppUpdate: AU, App: { getInfo: async () => ({ build: '5' }) } }, server: { latestVersionCode: 5 } });
  await t.win.MASMS_UPDATE.check(); expect(t.body.children.length).toBe(0);
});

test('server not configured (latest 0) or unreachable: silent', async () => {
  const AU = { getAppUpdateInfo: async () => { throw new Error('x'); } }, App = { getInfo: async () => ({ build: '1' }) };
  const t = boot({ plugins: { AppUpdate: AU, App }, server: { latestVersionCode: 0 } });
  await t.win.MASMS_UPDATE.check(); expect(t.body.children.length).toBe(0);
});

test('the build injects the module into index.html', () => {
  const out = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  expect(out).toContain('window.MASMS_UPDATE');
});
