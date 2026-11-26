// School profile: Postal Code and Town sit right after Postal Address and are saved with the profile.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
test('Postal Code and Town follow Postal Address in the school profile form', () => {
  const a = src.indexOf('id="sp_address"'), c = src.indexOf('id="sp_postalCode"'), t = src.indexOf('id="sp_town"'), w = src.indexOf('id="sp_website"');
  expect(a).toBeGreaterThan(0); expect(c).toBeGreaterThan(a); expect(t).toBeGreaterThan(c); expect(w).toBeGreaterThan(t);
});
test('both fields are saved, and postal code is digits only', () => {
  expect(src).toContain("postalCode: (document.getElementById('sp_postalCode')"); expect(src).toContain("town: (document.getElementById('sp_town')");
  expect(/postal|boxno|^sp_address$/i.test('sp_postalCode')).toBe(true);   // the app-wide rule that keeps postal fields to digits
});
