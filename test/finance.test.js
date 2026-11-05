// Runs the REAL finance functions out of the app source (no copies) in a vm sandbox.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');

function fnSrc(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const end = src.indexOf('\n}\n', i);
  return src.slice(i + 1, end + 3);
}
// a function written on a single line: `function name(...){ ... }`
const lineFn = name => { const m = src.match(new RegExp('\\nfunction ' + name + '\\([^\\n]*\\}\\n')); if (!m) throw new Error('line function not found: ' + name); return m[0]; };
// one-line or multi-line `const NAME = ...;` (no semicolons inside the value)
const constSrc = name => { const m = src.match(new RegExp('\\nconst ' + name + ' = [^;]*;')); if (!m) throw new Error('const not found: ' + name); return m[0]; };

const FIXED_NOW = new Date('2026-03-01T09:00:00Z').getTime();
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(FIXED_NOW); else super(...a); }
  static now() { return FIXED_NOW; }
}

function sandbox(extra = '') {
  const code = [
    'let students = [], paymentsLog = [], expenseEntries = [], incomeEntries = [], payrollEntries = [], feeStructureItems = [], feeAdjustments = [];',
    'let cashOpeningBalance = 0, nextReceiptNo = 1, nextVoucherNo = 1, issuedVoucherNumbers = new Set();',
    'let financeReportFrom = "", financeReportTo = "", arrearsTermFilter = "";',
    'let currentSchool = "Test", termDates = { "2026": { "Term 1": { start:"2026-01-06" }, "Term 2": { start:"2026-05-04" }, "Term 3": { start:"2026-09-01" } } };',
    'const FEE_TERM_OPTIONS = ["Term 1","Term 2","Term 3"]; const FEE_TERM_START_DATES = { "Term 1":"05 Jan", "Term 2":"05 May", "Term 3":"05 Sep" };',
    'const getSchoolProfile = () => ({ academicYear: "2026" });',
    'const fullName = s => s.first + " " + s.last;',
    'const studentTotalLibraryFines = () => 0, studentTotalLabFines = () => 0;',
    'const studentTotalAdjustments = adm => feeAdjustments.filter(a => a.admissionNumber === adm).reduce((t, a) => t + a.amount, 0);',
    'const formatKsh = n => "Ksh " + Number(n).toFixed(2);',
    fnSrc('parseAmountKsh'), lineFn('activePayments'), lineFn('activeExpenses'),
    fnSrc('inFinanceReportRange'),
    fnSrc('collectFinanceMeta'), fnSrc('applyFinanceMeta'),
    constSrc('NSSF_TIER_I_LIMIT'), constSrc('NSSF_TIER_II_LIMIT'), constSrc('NSSF_RATE'),
    constSrc('SHIF_RATE'), constSrc('SHIF_MIN'), constSrc('AHL_RATE'), constSrc('PAYE_PERSONAL_RELIEF'),
    constSrc('PAYE_BANDS'), constSrc('payR2'),
    fnSrc('calcNssf'), fnSrc('calcShif'), fnSrc('calcPaye'), fnSrc('calcPayslip'),
    'let payrollPeriod = "2026-02";',
    fnSrc('normalizePayroll'), fnSrc('payrollSlip'), fnSrc('payrollPeriodEnd'), fnSrc('payrollPeriodLabel'), fnSrc('paidPayrollLines'),
    fnSrc('financeJournalEntries'),
    constSrc('BUDGET_EXPENSE_MAP'), fnSrc('budgetActual'),
    'let invoices = []; let invoicesDirty = true;',
    fnSrc('buildPaymentIndex'), 'const sumPaymentAmounts = list => list.reduce((t, p) => t + parseAmountKsh(p.amount), 0);',
    fnSrc('studentAccountSummary'), fnSrc('feeTermStartDate'), fnSrc('studentOverdueSince'), fnSrc('refreshInvoices'),
    fnSrc('arrearsOutstandingBucket'), fnSrc('computeFeeArrears'),
    extra,
  ].join('\n');
  const ctx = vm.createContext({ Date: FakeDate, console });
  vm.runInContext(code, ctx);
  return ctx;
}
const run = (ctx, expr) => vm.runInContext(expr, ctx);

describe('Kenyan statutory payroll (2026 rates)', () => {
  const ctx = sandbox();
  const slip = (b, a = 0) => run(ctx, `calcPayslip(${b}, ${a})`);

  test('Ksh 85,000 basic: NSSF tiers, SHIF, housing levy, PAYE after relief, net pay', () => {
    const s = slip(85000);
    expect(s.nssf.employee).toBe(5100);       // 540 tier I + 4,560 tier II
    expect(s.shif).toBe(2337.5);
    expect(s.ahlEmployee).toBe(1275);
    expect(s.taxable).toBe(76287.5);          // gross less NSSF, SHIF, levy
    expect(s.paye).toBe(15269.6);             // 17,669.60 less 2,400 relief
    expect(s.net).toBe(61017.9);
    expect(s.employerCosts).toBe(6375);       // NSSF 5,100 + levy 1,275
  });
  test('allowances are part of gross pay', () => {
    expect(slip(70000, 15000).gross).toBe(85000);
    expect(slip(70000, 15000).net).toBe(slip(85000).net);
  });
  test('low earner pays no PAYE (relief wipes it out) but still pays SHIF and levy', () => {
    const s = slip(20000);
    expect(s.paye).toBe(0);
    expect(s.shif).toBe(550);
    expect(s.ahlEmployee).toBe(300);
  });
  test('SHIF has a Ksh 300 minimum; NSSF stops at the upper earnings limit (6,480)', () => {
    expect(slip(5000).shif).toBe(300);
    expect(slip(200000).nssf.employee).toBe(6480);
  });
  test('net + deductions = gross, and statutory total covers both employee and employer shares', () => {
    const s = slip(123456.78, 4321.09);
    expect(Math.abs(s.net + s.totalDeductions - s.gross)).toBeLessThan(0.005);
    expect(Math.abs(s.statutoryTotal - (s.totalDeductions + s.employerCosts))).toBeLessThan(0.005);
  });
});

describe('ledger: cancelled records out, payroll balanced', () => {
  test('cancelled receipts and vouchers never reach the ledger; payroll + remittance keep it balanced', () => {
    const ctx = sandbox();
    run(ctx, `
      paymentsLog = [
        { receiptNo:'RCPT-000001', student:'A', amount:'Ksh 10,000', date:'2026-02-10' },
        { receiptNo:'RCPT-000002', student:'B', amount:'Ksh 99,999', date:'2026-02-11', status:'Cancelled' },
      ];
      expenseEntries = [
        { voucherNo:'PV-001', category:'Food', amount:'Ksh 4,000', date:'2026-02-12' },
        { voucherNo:'PV-002', category:'Food', amount:'Ksh 77,777', date:'2026-02-13', status:'Cancelled' },
      ];
      payrollEntries = [
        { name:'T1', role:'Teacher', salary:'Ksh 85,000', allowances:0, period:'2026-02', status:'Paid', paidDate:'2026-02-28', remitted:true, remittedDate:'2026-03-09' },
        { name:'T2', role:'Teacher', salary:'Ksh 50,000', allowances:5000, period:'2026-02', status:'Pending' },
      ];`);
    const entries = run(ctx, 'financeJournalEntries()');
    const dr = entries.reduce((t, e) => t + e.debit, 0), cr = entries.reduce((t, e) => t + e.credit, 0);
    expect(Math.abs(dr - cr)).toBeLessThan(0.01);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('99999');
    expect(text).not.toContain('77777');
    // pending salary (T2) is not posted; remitted T1 clears the payable
    expect(text).not.toContain('T2');
    const payable = entries.filter(e => e.account === 'Statutory Deductions Payable');
    expect(payable.reduce((t, e) => t + e.credit - e.debit, 0)).toBe(0);
    const cash = entries.filter(e => e.account === 'Cash / Bank').reduce((t, e) => t + e.debit - e.credit, 0);
    const slip = run(ctx, 'calcPayslip(85000, 0)');
    expect(Math.round((cash - (10000 - 4000 - slip.net - slip.statutoryTotal)) * 100)).toBe(0);
  });
});

describe('receipt and voucher numbers survive a reload', () => {
  test('counters are re-derived from existing records even when none were saved', () => {
    const ctx = sandbox();
    run(ctx, `
      paymentsLog = [{ receiptNo:'RCPT-001010' }, { receiptNo:'RCPT-000007', status:'Cancelled' }];
      expenseEntries = [{ voucherNo:'PV-012' }, { voucherNo:'PV-020', status:'Cancelled' }];
      applyFinanceMeta(undefined);`);
    expect(run(ctx, 'nextReceiptNo')).toBe(1011);
    expect(run(ctx, 'nextVoucherNo')).toBe(21);
    expect(run(ctx, 'issuedVoucherNumbers.has("PV-020")')).toBe(true);
  });
  test('saved counters and opening balance round-trip, and a deleted top number is never reissued', () => {
    const ctx = sandbox();
    run(ctx, `
      nextReceiptNo = 50; nextVoucherNo = 9; issuedVoucherNumbers = new Set(['PV-008']); cashOpeningBalance = 12345;
      const saved = JSON.parse(JSON.stringify(collectFinanceMeta()));
      nextReceiptNo = 1; nextVoucherNo = 1; issuedVoucherNumbers = new Set(); cashOpeningBalance = 0;
      applyFinanceMeta(saved);`);
    expect(run(ctx, 'nextReceiptNo')).toBe(50);
    expect(run(ctx, 'nextVoucherNo')).toBe(9);
    expect(run(ctx, 'cashOpeningBalance')).toBe(12345);
  });
});

describe('budget actuals come from logged expenses', () => {
  test('matching categories are summed, cancelled ones ignored, a typed actual overrides', () => {
    const ctx = sandbox();
    run(ctx, `
      expenseEntries = [
        { category:'Electricity', amount:'Ksh 10,000', date:'2026-02-01' },
        { category:'Electricity', amount:'Ksh 5,000', date:'2026-02-02' },
        { category:'Electricity', amount:'Ksh 999,000', date:'2026-02-03', status:'Cancelled' },
        { category:'Water', amount:'Ksh 2,000', date:'2026-02-04' },
        { category:'School Bus', amount:'Ksh 3,000', date:'2026-02-05' },
      ];`);
    expect(run(ctx, `budgetActual({ category:'Electricity', allocated:20000, spent:0 })`)).toEqual({ amount: 15000, manual: false });
    expect(run(ctx, `budgetActual({ category:'Transport', allocated:1, spent:0 })`).amount).toBe(3000);
    expect(run(ctx, `budgetActual({ category:'Water', allocated:1, spent:500 })`)).toEqual({ amount: 500, manual: true });
  });
});

describe('student fee accounts and arrears use real data', () => {
  const setup = () => {
    const ctx = sandbox();
    run(ctx, `
      students = [
        { admissionNumber:'101', first:'Peter', last:'Otieno', grade:'Grade 10', boardingStatus:'Boarder' },
        { admissionNumber:'102', first:'Peter', last:'Otieno', grade:'Grade 10', boardingStatus:'Boarder' },
        { admissionNumber:'103', first:'Mary', last:'Achieng', grade:'Grade 10', boardingStatus:'Boarder' },
      ];
      feeStructureItems = [
        { grade:'Grade 10', term:'Term 1', category:'Boarding', amount:'Ksh 10,000', studentType:'Boarders' },
        { grade:'Grade 10', term:'Term 2', category:'Boarding', amount:'Ksh 10,000', studentType:'Boarders' },
      ];
      paymentsLog = [
        { receiptNo:'R1', admissionNo:'101', student:'Peter Otieno', term:'Term 1', amount:'Ksh 10,000' },
        { receiptNo:'R2', admissionNo:'103', student:'Mary Achieng', term:'Term 1', amount:'Ksh 4,000' },
        { receiptNo:'R3', admissionNo:'103', student:'Mary Achieng', term:'Term 1', amount:'Ksh 50,000', status:'Cancelled' },
      ];`);
    return ctx;
  };
  test('same-named learners are told apart by admission number', () => {
    const ctx = setup();
    const rows = run(ctx, 'computeFeeArrears()');
    const p101 = rows.find(r => r.admissionNumber === '101'), p102 = rows.find(r => r.admissionNumber === '102');
    expect(p101.paid).toBe(10000);
    expect(p102.paid).toBe(0);              // must not inherit 101's payment
    expect(rows.find(r => r.admissionNumber === '103').paid).toBe(4000); // cancelled receipt ignored
  });
  test('ageing is counted from the start of the oldest unpaid term, not the admission number', () => {
    const ctx = setup();
    const rows = run(ctx, 'computeFeeArrears()');
    // "today" is 1 Mar 2026. 102 owes Term 1 (started 6 Jan) -> 54 days; 101 only owes Term 2 (not started) -> 0.
    expect(rows.find(r => r.admissionNumber === '102').daysOverdue).toBe(54);
    expect(rows.find(r => r.admissionNumber === '103').daysOverdue).toBe(54);
    expect(rows.find(r => r.admissionNumber === '101').daysOverdue).toBe(0);
    expect(rows.find(r => r.admissionNumber === '102').periodBucket).toBe('31-60 days');
  });
  test('invoices are built from the data: billed / paid / balance and status', () => {
    const ctx = setup();
    const inv = run(ctx, 'refreshInvoices().map(i => ({ a:i.admissionNumber, billed:i.billed, paid:i.paid, balance:i.balance, status:i.status }))');
    expect(inv.find(i => i.a === '101')).toEqual({ a: '101', billed: 20000, paid: 10000, balance: 10000, status: 'Pending' });
    expect(inv.find(i => i.a === '102').status).toBe('Overdue');
    expect(inv.find(i => i.a === '103')).toMatchObject({ billed: 20000, paid: 4000, balance: 16000, status: 'Overdue' });
  });
  test('a fully paid learner is Paid and an overpayment shows as a credit', () => {
    const ctx = setup();
    run(ctx, `paymentsLog.push({ receiptNo:'R9', admissionNo:'101', student:'Peter Otieno', term:'Term 2', amount:'Ksh 12,000' }); invoicesDirty = true;`);
    const i = run(ctx, `refreshInvoices().find(i => i.admissionNumber === '101')`);
    expect(i.status).toBe('Paid');
    expect(i.balance).toBe(-2000);
  });
});

describe('source-level guards', () => {
  test('hard-coded demo figures are gone from Student Fee Accounts', () => {
    expect(src).not.toContain('Ksh 8,420,000');
    expect(src).not.toContain('Ksh 675,000');
  });
  test('arrears ageing no longer derives from the admission number', () => {
    expect(src).not.toMatch(/\(n \* 37\) % 120/);
  });
  test('finance counters are saved with each school and restored on load', () => {
    expect(src).toMatch(/financeMeta: collectFinanceMeta\(\)/);
    expect(src).toMatch(/applyFinanceMeta\(d\.financeMeta\)/);
  });
  test('receipt and voucher deletion is only offered for cancelled records', () => {
    expect(src).toMatch(/p\.status==='Cancelled' \? `<button class="link-btn danger" onclick="removePaymentRecord/);
    expect(src).toMatch(/exp\.status==='Cancelled' \? `<button class="link-btn danger" onclick="removeExpenseEntry/);
  });
});
