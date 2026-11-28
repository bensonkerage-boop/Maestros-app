// The teacher dashboard shows the posted timetable as a real HTML table (not a PDF picture); Download PDF stays.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
test('the teacher timetable page renders HTML and no longer fills a PDF preview', () => {
  expect(src).toMatch(/function tpHtmlBuild\(\)\{ return tpWithTimetable\(tpResolvedId\(\), tpHtmlInner\); \}/);
  expect(src).toMatch(/<div id="tpPdfHost">\$\{ttHtml\}<\/div>/);
  expect(src).not.toMatch(/setTimeout\(tpFillPreview, 0\)/);
  expect(src).toMatch(/onclick="tpDownloadPdf\(\)"/);
});
