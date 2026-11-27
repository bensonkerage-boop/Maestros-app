/** @jest-environment jsdom */
const fs = require('fs'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'server-link.js'), 'utf8');
const run = () => { window.eval(code); };
beforeEach(() => { localStorage.clear(); delete window.MASMS_API_BASE; delete window.MASMS_SERVER_LINK; });
test('an https address from the live page is captured and used', () => {
  run(); window.MASMS_API_BASE = undefined;
  window.MASMS_SERVER_LINK.capture('masms://link?server=' + encodeURIComponent('https://school.example.com/path?x=1'));
  expect(localStorage.getItem('masmsServer')).toBe('https://school.example.com');
});
test('a captured address is used on the next start', () => {
  localStorage.setItem('masmsServer', 'https://school.example.com'); run();
  expect(window.MASMS_API_BASE).toBe('https://school.example.com');
});
test('non-https, credentials and other schemes are refused; a built-in address wins', () => {
  run();
  for (const u of ['masms://link?server=http://x.com', 'masms://link?server=https://u:p@x.com', 'https://evil.com/?server=https://x.com', 'masms://link']) {
    expect(window.MASMS_SERVER_LINK.capture(u)).toBe(false);
  }
  expect(localStorage.getItem('masmsServer')).toBeNull();
  localStorage.setItem('masmsServer', 'https://other.example.com'); window.MASMS_API_BASE = 'https://fixed.example.com'; run();
  expect(window.MASMS_API_BASE).toBe('https://fixed.example.com');
});
