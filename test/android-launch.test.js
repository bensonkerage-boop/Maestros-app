// Android start-up: no separate logo/blue first page; the window before the app draws is plain and matches the wheel page.
const fs = require('fs'), path = require('path');
const res = f => fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', f), 'utf8');
test('the launch theme uses no splash image or logo', () => {
  const st = res('values/styles.xml'), launch = st.slice(st.indexOf('AppTheme.NoActionBarLaunch'));
  expect(launch).not.toContain('@drawable/splash"'); expect(launch).toContain('@drawable/launch_background'); expect(launch).toContain('windowSplashScreenAnimatedIcon">@drawable/launch_icon_blank');
  expect(res('drawable/launch_icon_blank.xml')).toContain('transparent'); expect(res('values/launch.xml')).toContain('#152C58');
});
test('the in-app wheel splash is still the first thing drawn', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
  expect(html.indexOf('<div id="appSplash"')).toBeGreaterThan(html.indexOf('<body>'));
  expect(html.slice(html.indexOf('<body>'), html.indexOf('<div id="appSplash"'))).not.toMatch(/<div/);
});
