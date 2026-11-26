// The start-up wheel plays once per start; a reload in the same session (for example the app switching to a new version) skips it.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const i = html.indexOf('<div id="appSplash"'), j = html.indexOf('<script>', i), code = html.slice(j + 8, html.indexOf('</script>', j));
const run = store => {
  const sp = { className: '', parentNode: { removeChild() { sp.removed = true; } }, querySelectorAll: () => [], addEventListener() {} }, timers = [];
  const ctx = vm.createContext({ window: {}, document: { getElementById: () => sp, createElement: () => ({ style: { setProperty() {} }, setAttribute() {} }) }, sessionStorage: store,
    setTimeout: (f, t) => timers.push(t), Array });
  vm.runInContext(code, ctx); return { sp, timers };
};
test('the first load of a session plays the wheel; a reload in the same session does not', () => {
  const data = {}, store = { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
  const first = run(store); expect(first.sp.className).toBe('show'); expect(first.timers).toContain(4200); expect(data.masms_splash_played).toBe('1');
  const again = run(store); expect(again.sp.removed).toBe(true); expect(again.sp.className).toBe(''); expect(again.timers).toHaveLength(0);
});
test('where session storage is unavailable the wheel still plays (never blocks the app)', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  expect(run(bad).sp.className).toBe('show');
});
