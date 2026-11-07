const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(cut('function parseAmountKsh(', 'function formatKsh(') + cut('function parseCsvRows(', 'function reconLoadStatementText(') + cut('function computeReconciliation(', 'function reconReceiveLine('), ctx);

test('parses a bank/M-Pesa CSV: quotes, thousands separators, ignores money-out rows', () => {
  const rows = ctx.parseStatementCsv('Date,Receipt No.,Details,Paid In,Withdrawn\n2026-02-10,QWE1,"Fees, Amina","15,000.00",\n2026-02-10,OUT1,Payout,,800\n,,,,\n');
  expect(rows).toEqual([{ date: '2026-02-10', ref: 'QWE1', amount: 15000, description: 'Fees, Amina' }]);
});
test('rejects files without the needed columns', () => {
  expect(() => ctx.parseStatementCsv('Foo,Bar\n1,2')).toThrow(/Reference/);
  expect(() => ctx.parseStatementCsv('Reference,Amount\n')).toThrow(/header/);
});
test('matches by code, flags amount differences, unreceipted lines and phantom receipts', () => {
  const pays = [{ transactionCode: 'abc1', amount: '1,000', method: 'M-Pesa' }, { transactionCode: 'BNK', amount: '2000', method: 'Bank' }, { transactionCode: 'GONE', amount: '5', method: 'Bank' }];
  const r = ctx.computeReconciliation([{ ref: 'ABC1', amount: 1000 }, { ref: 'BNK', amount: 2500 }, { ref: 'NEW', amount: 7 }], pays);
  expect(r.matched).toHaveLength(1); expect(r.mismatched[0].line.ref).toBe('BNK');
  expect(r.unreceipted.map(l => l.ref)).toEqual(['NEW']); expect(r.notOnStatement.map(p => p.transactionCode)).toEqual(['GONE']);
});
