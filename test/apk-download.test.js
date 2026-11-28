// The Download Android app button must hand the browser a real APK file, from the website's own address when it is bundled.
const fs = require('fs'), path = require('path');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
test('the button is a file download of MASMS.apk', () => {
  for (const f of ['pwa/landing.src.html', 'pwa/landing.html']) expect(rd(f)).toMatch(/id="dlApk" href="\/api\/android-apk" download="MASMS\.apk"/);
});
test('Vercel serves /downloads/*.apk as an Android package attachment, and ships it with the API function', () => {
  const v = JSON.parse(rd('vercel.json')), h = v.headers.find(x => /downloads/.test(x.source));
  const get = k => h.headers.find(x => x.key === k).value;
  expect(get('Content-Type')).toBe('application/vnd.android.package-archive');
  expect(get('Content-Disposition')).toBe('attachment; filename="MASMS.apk"');
  expect(v.functions['api/index.js'].includeFiles).toBe('public/downloads/**');
});
test('the service worker never caches or intercepts the APK', () => { expect(rd('pwa/sw.js')).toMatch(/p\.startsWith\('\/downloads\/'\)/); });
test('the build copies a committed or published APK in, and refuses anything that is not a real APK', () => {
  const b = rd('scripts/build.js');
  expect(b).toMatch(/public|pub, 'downloads', 'MASMS\.apk'/); expect(b).toMatch(/0x504b0304/); expect(b).toMatch(/if \(!androidBuild\) await bundleApk\(\)/);
});
