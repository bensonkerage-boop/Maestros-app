// The landing page (first screen in the website AND the Android app): self-contained, wired to the real login, real contacts.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), page = fs.readFileSync(path.join(root, 'pwa', 'landing.html'), 'utf8');
const { injectLanding } = require('../scripts/landing');

test('the page loads nothing from Tailwind\'s CDN, Google Fonts or a placeholder-image service', () => {
  expect(page).not.toMatch(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|placehold\.co/);
  expect(page).not.toContain('tailwind.config');
  expect(page).toMatch(/<style id="tw">[^<]*\.grid\{/);   // compiled styles are written into the page
});
test('every Log in button reaches the real sign-in page; there is no pretend login form', () => {
  expect(page).not.toMatch(/submitPortalLogin|id="login-modal"|Authenticated as/);
  expect(page).toContain("postMessage('masms-login'");
  expect(page).toMatch(/openLoginModal\(\)/);
});
test('the demo form does not claim to have scheduled anything', () => {
  expect(page).not.toMatch(/Demo scheduled/);
  expect(page).toContain('mailto:');
});
test('the real contacts and the Download Android app link are on the page', () => {
  expect(page).toContain('tel:0724743019'); expect(page).toContain('wa.me/254724743019'); expect(page).toContain('bensonkerage@gmail.com');
  expect(page).toMatch(/id="dlApk"[^>]*href="\/api\/android-apk"/);
});
test('the System Developer\'s Web Page tab still reaches the page', () => {
  for (const id of ['hero-heading', 'hero-text', 'contact-phone', 'contact-wa', 'contact-email', 'contact-fb', 'footer-contact']) expect(page).toContain('id="' + id + '"');
  expect(page).toContain('window.MASMS_WEBPAGE_APPLY');
});
test('the landing page is built into the app for the Android build too, and is not removed when running natively', () => {
  const out = injectLanding('<html><body><p>app</p></body></html>', root);
  expect(out).toContain('id="masms-landing"');
  const build = fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8'), land = fs.readFileSync(path.join(root, 'scripts', 'landing.js'), 'utf8');
  expect(build).not.toMatch(/if \(!androidBuild\) html = injectLanding/);
  expect(land).not.toMatch(/removeChild\(f\)/);
});
test('every card can be edited from the Web Page tab and carries a true-blue View more link', () => {
  for (const k of ['hero1', 'hero2', 'academics', 'nemis', 'timetable', 'fees', 'portal', 'communication']) expect(page).toContain('data-card="' + k + '"');
  expect((page.match(/data-f="more"/g) || []).length).toBeGreaterThanOrEqual(8);
  expect(page).toMatch(/\.more-link\{color:#0000FF/);
  expect(page).toContain('function applyCards');
  const app = fs.readFileSync(path.join(root, 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
  for (const f of ['swpCardPhoto', 'swpSetCard', 'swpFixLink', 'Cards on the web page']) expect(app).toContain(f);
});
