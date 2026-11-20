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
  expect(t.body.children.length).toBe(0);   // no bottom card any more
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
  expect(t.body.children.length).toBe(0);   // optional update: no bottom card
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

// ---- website / live-URL app: reload by itself when nobody is typing ----
function bootWeb({ focus = null, controller = {} } = {}) {
  const docL = {}, swL = {}, calls = [], timers = [], ss = {};
  let t = 1e6;
  const body = { appendChild(e) { shown.push(e); } }, shown = [];
  const mkEl = () => ({ style: {}, childNodes: [], appendChild(c) { this.childNodes.push(c); }, setAttribute() {}, set textContent(v) { this.t = v; }, get textContent() { return this.t; }, parentNode: null });
  const ctx = {
    window: { addEventListener() {}, MASMS_LOCAL: { saveNow: () => { calls.push('saved'); return Promise.resolve(); } } },
    document: { body, hidden: false, activeElement: focus, createElement: mkEl,
      addEventListener: (n, f) => { (docL[n] = docL[n] || []).push(f); } },
    navigator: { onLine: true, serviceWorker: { controller, addEventListener: (n, f) => { swL[n] = f; }, getRegistration: () => Promise.resolve(null) } },
    sessionStorage: { getItem: k => ss[k] || null, setItem: (k, v) => { ss[k] = v; } },
    localStorage: { getItem: () => null, setItem() {} },
    location: { reload: () => calls.push('reload') },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() {},
    Date: { now: () => t }, Promise, parseInt, JSON, AbortController
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { ctx, shown, calls, ss, docL, swL, timers, flush, advance: ms => { t += ms; }, type: () => docL.input.forEach(f => f()), newVersion: () => swL.controllerchange() };
}
const runPoll = async w => { const x = w.timers.filter(q => q.ms === 5000); w.timers.length = 0; x.forEach(q => q.fn()); await w.flush(); };

test('new version while idle: saves, then reloads by itself (no banner click)', async () => {
  const w = bootWeb(); w.newVersion(); await w.flush();
  expect(w.calls).toEqual(['saved', 'reload']);
});

test('new version while typing: waits, then reloads once typing stops', async () => {
  const w = bootWeb({ focus: { tagName: 'INPUT', type: 'text' } });
  w.type(); w.newVersion(); await w.flush();
  expect(w.calls).toEqual([]);                     // field focused and just edited: do not touch
  w.advance(5000); await runPoll(w); expect(w.calls).toEqual([]);
  w.advance(20000); await runPoll(w);              // 25 s since last keystroke
  expect(w.calls).toEqual(['saved', 'reload']);
});

test('a focused field that is not being edited does not block the reload', async () => {
  const w = bootWeb({ focus: { tagName: 'TEXTAREA' } }); w.newVersion(); await w.flush();
  expect(w.calls).toEqual(['saved', 'reload']);
});

test('buttons and checkboxes never count as typing', async () => {
  const w = bootWeb({ focus: { tagName: 'INPUT', type: 'checkbox' } }); w.type(); w.newVersion(); await w.flush();
  expect(w.calls).toEqual(['saved', 'reload']);
});

test('reload-loop guard: a second update right after an automatic reload is not applied automatically', async () => {
  const w = bootWeb(); w.ss.masmsAutoReload = String(1e6 - 1000);
  w.newVersion(); await w.flush();
  expect(w.calls).toEqual([]);
  expect(w.shown.length).toBe(0);   // and no banner
});

test('the first service-worker install is not treated as an update', async () => {
  const w = bootWeb({ controller: null });
  w.newVersion(); await w.flush(); expect(w.calls).toEqual([]);
});

test('the website landing page has the Download Android app button wired to the stable link', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'landing.html'), 'utf8');
  expect(html).toMatch(/id="dlApk"[^>]*href="\/api\/android-apk"/);
  expect(html).toContain('Download Android app');
});
