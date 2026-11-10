// Fee statement: every payment from day 1 with date AND time, plus a running "total paid to date".
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
function ledgerFor(payments, extra = {}) {
  const ctx = {
    FEE_TERM_START_DATES: { 'Term 1': '05 Jan', 'Term 2': '05 May', 'Term 3': '05 Sep' },
    FEE_TERM_OPTIONS: ['Term 1', 'Term 2', 'Term 3'],
    feeStructureItems: [{ grade: 'Grade 10', term: 'Term 1', amount: '10000' }, { grade: 'Grade 10', term: 'Term 2', amount: '10000' }],
    feeItemBills: () => true, parseAmountKsh: v => Number(String(v).replace(/,/g, '')) || 0,
    getSchoolProfile: () => ({ academicYear: 2026 }), currentSchool: 'X',
    buildPaymentIndex: () => ({ for: () => payments }),
    feeAdjustments: extra.adjustments || [], libraryFines: [], labFines: [],
  };
  vm.createContext(ctx);
  vm.runInContext(['formatPaymentDateTime', 'buildStudentFeeLedger'].map(fnSrc).join('\n'), ctx);
  return ctx.buildStudentFeeLedger({ admissionNumber: '1', grade: 'Grade 10', boardingStatus: 'Day' });
}
const pay = (iso, time, amount, extra = {}) => ({ date: new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), isoDate: iso, payTime: time, amount, method: 'M-Pesa', receiptNo: 'RCPT-' + amount, ...extra });

test('payments show date and 12-hour time, in order, with cumulative total paid', () => {
  const rows = ledgerFor([pay('2026-02-10', '14:35', 4000), pay('2026-01-20', '09:05', 3000), pay('2026-02-10', '08:00', 500)]);
  const paid = rows.filter(r => r.credit);
  expect(paid.map(r => r.date)).toEqual(['20 Jan 2026, 9:05 AM', '10 Feb 2026, 8:00 AM', '10 Feb 2026, 2:35 PM']);
  expect(paid.map(r => r.paidToDate)).toEqual([3000, 3500, 7500]);
  expect(paid[2].description).toBe('M-Pesa – RCPT-4000');
  expect(rows[rows.length - 1].balance).toBe(20000 - 7500);
});
test('older payments without a time still show their date; midnight/noon read correctly', () => {
  const rows = ledgerFor([pay('2026-01-20', undefined, 1000), pay('2026-01-21', '00:10', 1, { receiptNo: '' }), pay('2026-01-22', '12:00', 1, { receiptNo: '' })]);
  const dates = rows.filter(r => r.credit).map(r => r.date);
  expect(dates).toEqual(['20 Jan 2026', '21 Jan 2026, 12:10 AM', '22 Jan 2026, 12:00 PM']);
});
test('discounts/scholarships reduce the balance but are not counted as paid', () => {
  const rows = ledgerFor([pay('2026-02-01', '10:00', 2000)], { adjustments: [{ admissionNumber: '1', date: '2026-02-05', type: 'Scholarship', amount: 5000 }] });
  const last = rows[rows.length - 1];
  expect(last.paidToDate).toBe(2000);
  expect(last.balance).toBe(20000 - 2000 - 5000);
});
test('statement and bulk PDF show the new columns, and every payment is time-stamped', () => {
  expect(src.match(/\["Date & Time", "Description", "Debit", "Credit", "Total Paid to Date", "Balance"\]/g)).toHaveLength(1);
  expect(src.match(/\['Date & Time','Description','Debit','Credit','Total Paid to Date','Balance'\]/g)).toHaveLength(1);
  expect(src.match(/\.\.\.paymentTimeStamp\(/g)).toHaveLength(4);   // receive payment, M-Pesa, 2x library fine
});

test('class/stream fee statements PDF is Times 12, never bold', () => {
  const a = src.indexOf('function downloadClassFeeStatementsPdf(){');
  const f = src.slice(a, src.indexOf('\n}\n', a));
  expect(f).not.toMatch(/helvetica|'bold'|fontStyle:\s*'bold'/);
  expect([...f.matchAll(/setFontSize\((\d+)\)/g)].every(m => m[1] === '12')).toBe(true);
  expect(f).toMatch(/styles: \{ font: 'times', fontStyle: 'normal', fontSize: 12/);
});

test('statement exports have no grade/form + year row, and the parent statement still names the learner', () => {
  for (const fn of ['openParentFeeStatement', 'openFeeStatementPreview']) {
    const a = src.indexOf('function ' + fn + '(');
    const body = src.slice(a, src.indexOf('\n}\n', a));
    expect(body).toMatch(/hideGradeYear:\s*true/);
  }
  const a = src.indexOf('function openParentFeeStatement(');
  expect(src.slice(a, src.indexOf('\n}\n', a))).toMatch(/teacherLine: `Student: \$\{fullName\(student\)\}\s+\|\s+Admission No:/);
});

test('Class & Stream Fee Collection export: S/No first column and a TOTAL row last', () => {
  const a = src.indexOf('case "classStreamCollection": {');
  const body = src.slice(a, src.indexOf('filename = "class-stream-fee-collection"', a));
  expect(body).toMatch(/\[\["S\/No","Class","Stream","Students"/);
  expect(body).toMatch(/csc\.forEach\(\(r, idx\) => \{\s*rows\.push\(\[idx \+ 1, r\.grade, r\.stream,/);
  expect(body).toMatch(/rows\.push\(\["", "TOTAL", "", totals\.students,/);
  // header, every data row and the TOTAL row all have 11 cells
  expect((body.match(/"Collection %"/g) || [])).toHaveLength(1);
});

test('Fee Arrears: on-screen table and exports have S/No first and a TOTAL row last', () => {
  const a = src.indexOf('function renderFinanceArrearsTab(');
  const fn = src.slice(a, src.indexOf('\n}\n', a));
  expect(fn).toMatch(/<th style="text-align:center;">S\/No<\/th><th>Admission<\/th>/);
  expect(fn).toMatch(/list\.map\(\(r, idx\) =>/);
  expect(fn).toMatch(/<tbody>\$\{rows\}\$\{arrearsTotalRow\}<\/tbody>/);
  expect(fn).toMatch(/arrearsSum\('expected'\)[\s\S]*arrearsSum\('paid'\)[\s\S]*arrearsSum\('balance'\)/);
  const e = src.indexOf('case "arrears": {');
  const exp = src.slice(e, src.indexOf('filename = "fee-arrears"', e));
  expect(exp).toMatch(/\["S\/No","Admission"/);
  expect(exp).toMatch(/rows\.push\(\["", "TOTAL", "", "", "", sum\('expected'\), sum\('paid'\), sum\('balance'\)\]\)/);
});

test('Fee Arrears TOTAL cells sit under Expected / Paid / Balance (on screen and in the export)', () => {
  // on screen: S/No, Admission, Student, Class, [Boarding], Expected, Paid, Balance, Action
  const a = src.indexOf('const arrearsTotalRow');
  const tr = src.slice(a, src.indexOf('</tr>`', a));
  expect(tr).toMatch(/<td><\/td>\s*<td colspan="\$\{schoolHasBoarding\(\) \? 4 : 3\}">TOTAL<\/td>/);   // S/No + Admission/Student/Class(/Boarding)
  const labels = tr.match(/<td[^>]*>/g).length;                       // S/No, TOTAL, expected, paid, balance, action
  expect(labels).toBe(6);
  // export: header and TOTAL row have the same width, and the three sums are the last three cells
  const e = src.indexOf('case "arrears": {');
  const exp = src.slice(e, src.indexOf('filename = "fee-arrears"', e));
  const head = exp.match(/rows = \[\[(.*?)\],/)[1].split(',');
  const tot = exp.match(/rows\.push\(\[(.*)\]\);/)[1].split(',').map(v => v.trim());
  expect(tot).toHaveLength(head.length);
  expect(head.slice(-3)).toEqual(['"Expected"', '"Paid"', '"Balance"']);
  expect(tot.slice(-3)).toEqual(["sum('expected')", "sum('paid')", "sum('balance')"]);
});

test('Excel finance export: columns of figures are not stretched, so totals sit under their headings', () => {
  const a = src.indexOf('function downloadFinanceReport(');
  const fn = src.slice(a, src.indexOf('\n}\n', a) + 3);
  let cols;
  const ctx = {
    buildFinanceReportData: () => ({ filename: 'x', rows: [
      ['S/No', 'Admission', 'Student', 'Class', 'Boarding/Day', 'Expected', 'Paid', 'Balance'],
      [1, '101', 'A One', 'Form 4 East', 'Boarder', 50000, 20000, 30000],
      ['', 'TOTAL', '', '', '', 90000, 30000, 60000]] }),
    XLSX: { utils: { aoa_to_sheet: () => ({}), book_new: () => ({}), book_append_sheet: (wb, ws) => { cols = ws['!cols']; } }, writeFile: () => {} },
    Math, String, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\ndownloadFinanceReport("arrears")', ctx);
  expect(cols).toHaveLength(8);
  expect(Math.max(...cols.slice(-3).map(c => c.wch))).toBeLessThan(16);   // was forced to 28
  // a blank, hand-written column is still widened
  const ctx2 = { ...ctx, buildFinanceReportData: () => ({ filename: 'x', rows: [['A', 'B', 'Notes'], ['1', '2', ''], ['3', '4', '']] }) };
  vm.createContext(ctx2);
  vm.runInContext(fn + '\ndownloadFinanceReport("x")', ctx2);
  expect(cols[2].wch).toBeGreaterThanOrEqual(28);
});
