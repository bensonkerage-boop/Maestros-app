// Library > Books: the Publisher dropdown lets the school add its own publisher, and keeps it.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
test('publisher dropdown offers "Add new publisher" and uses the merged list', () => {
  expect(src).toMatch(/<option value="__add__">\+ Add new publisher\.\.\.<\/option>/);
  expect(src).toMatch(/libraryPublisherList\(\)\.map\(p => `<option/);
});
test('custom publishers are saved with the school data (snapshot, load and empty dataset)', () => {
  expect(src).toMatch(/"attendanceDayMeta", "libraryPublishers",/);
  expect(src).toMatch(/attendanceDayMeta, libraryPublishers,\n/);
  expect(src).toMatch(/libraryPublishers = Array\.isArray\(d\.libraryPublishers\)/);
});
test('a book cannot be saved while "Add new publisher" is still selected', () => {
  expect(src).toMatch(/publisherInput\.value === '__add__'/);
});
