/** @jest-environment jsdom */
const lp = require('../scripts/list-pdf.js');
const table = html => { document.body.innerHTML = '<div class="panel"><div class="panel-header"><h3>Teachers</h3></div>' + html + '</div>'; return document.querySelector('table'); };

test('extract drops Action/Photo/blank columns and empty rows', () => {
  const t = table(`<table><thead><tr><th>S/No</th><th>Photo</th><th>Name</th><th></th><th>Action</th></tr></thead>
    <tbody><tr><td>1</td><td><img></td><td>Peter  Mwangi</td><td></td><td><button>Edit</button></td></tr>
           <tr><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>`);
  expect(lp.extract(t)).toEqual({ head: ['S/No', 'Name'], body: [['1', 'Peter Mwangi']] });
});
test('inputs and selects contribute their values', () => {
  const t = table(`<table><thead><tr><th>Name</th><th>Mark</th><th>Grade</th></tr></thead><tbody><tr><td>Amina</td><td><input value="78"></td><td><select><option>A</option><option selected>B</option></select></td></tr></tbody></table>`);
  expect(lp.extract(t).body).toEqual([['Amina', '78', 'B']]);
});
test('only tables with 2+ columns and data are eligible', () => {
  expect(lp.eligible(table('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'))).toBe(true);
  expect(lp.eligible(table('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody></tbody></table>'))).toBe(false);
  expect(lp.eligible(table('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'))).toBe(false);
});
test('tables inside previews/timetables are skipped; scan adds one button once', () => {
  document.body.innerHTML = '<div class="preview-modal"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>' +
    '<div class="panel"><table id="t"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>';
  lp.scan(); lp.scan();
  expect(document.querySelectorAll('.pdf-bar')).toHaveLength(1);
  expect(document.querySelector('#t').previousElementSibling.className).toMatch(/pdf-bar/);
});
test('title comes from the panel heading', () => {
  expect(lp.titleFor(table('<table></table>'))).toBe('Teachers');
});
