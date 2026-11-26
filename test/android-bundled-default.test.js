// The Android APK is online-first: it loads the live site (LIVE_URL = API_BASE) unless LIVE_UPDATES is 0, and falls back to a bundled offline page.
const fs = require('fs'), path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
test('the APK workflows load the live site unless LIVE_UPDATES is 0', () => {
  for (const f of ['android.yml', 'android-release.yml']) {
    const wf = read('.github', 'workflows', f);
    expect(wf).toContain("LIVE_URL: ${{ vars.LIVE_UPDATES != '0' && vars.API_BASE || '' }}");
    expect(wf).not.toContain("LIVE_UPDATES == '1'");
  }
});
test('the live-site app shows the bundled offline page when the site cannot be reached', () => {
  expect(read('capacitor.config.js')).toContain("errorPath: 'offline.html'");
  expect(read('pwa', 'offline.html')).toContain('__LIVE_URL__');
});
