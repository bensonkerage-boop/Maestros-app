// The Android APK is built self-contained unless LIVE_UPDATES=1, so the start-up wheel needs no network.
const fs = require('fs'), path = require('path');
const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'android.yml'), 'utf8');
test('the APK workflow loads the live site only when LIVE_UPDATES is 1', () => {
  expect(wf).toContain("LIVE_URL: ${{ vars.LIVE_UPDATES == '1' && vars.API_BASE || '' }}"); expect(wf).not.toContain("LIVE_UPDATES != '0'");
});
