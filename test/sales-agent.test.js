// Runs the REAL sales-agent functions out of the app source in a vm sandbox.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const fnSrc = name => { const i = src.indexOf('\nfunction ' + name + '('); if (i < 0) throw new Error('missing ' + name); return src.slice(i + 1, src.indexOf('\n}\n', i) + 3); };
// a one-line helper (function ... { ... } on a single line)
const lineFn = name => { const m = src.match(new RegExp('\\nfunction ' + name + '\\([^\\n]*\\n')); if (!m) throw new Error('missing ' + name); return m[0]; };

function sandbox() {
  const code = [
    'let currentUserRole = "System Developer", currentAgentId = null;',
    'let saAgents = [{ id: 1, name: "Peter Mwangi", phone: "0712345678", status: "Active" }, { id: 2, name: "Jane Atieno", phone: "0722000111", status: "Active" }];',
    'let sdSchools = [{ id: 1, name: "A", agentId: 1 }, { id: 2, name: "B", agentId: 2 }, { id: 3, name: "C", agentId: null }];',
    'let sdSearch = "", sdRegionFilter = "", sdStatusFilter = "", sdSortKey = "sno", sdSortDir = 1;',
    'let sdInvoicePreview = null, sdReceiptPreview = null, sdInvoiceNextNo = 1001, sdReceiptNextNo = 100001, sdNextId = 11, saNextId = 6;',
    'const MASMS_INVOICE_TAX_RATE = 0.16; function sdSchoolFee(){ return { tier:null, subtotal:100, lines:[{desc:"x"}] }; } function sdDateLabel(){ return "d"; } function renderSdInvoiceModal(){} function renderSdReceiptModal(){} function render(){}',
    lineFn('isSalesAgentRole'), lineFn('sdOwnsSchool'),
    fnSrc('sdFilteredSortedSchools'), fnSrc('sdOpenInvoice'), fnSrc('sdOpenReceipt'), fnSrc('sdChangeStatus'),
    fnSrc('saLoginUser'), fnSrc('collectPlatformData'), fnSrc('applyPlatformData'),
  ].join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(code + '\nthis.api = { setRole:(r,id)=>{currentUserRole=r;currentAgentId=id;}, list:()=>sdFilteredSortedSchools().map(s=>s.name), inv:id=>{sdInvoicePreview=null;sdOpenInvoice(id);return sdInvoicePreview&&sdInvoicePreview.schoolName;}, rec:id=>{sdReceiptPreview=null;sdOpenReceipt(id);return sdReceiptPreview&&sdReceiptPreview.schoolName;}, status:(id,v)=>{sdChangeStatus(id,v);return sdSchools.find(s=>s.id===id).status;}, login:()=>saLoginUser(saAgents[0]), collect:()=>collectPlatformData(), apply:d=>{applyPlatformData(d);return {sdSchools,saAgents,sdNextId};} };', ctx);
  return ctx.api;
}

describe('Sales Agent access', () => {
  test('developer sees every school and can open any invoice or receipt', () => {
    const a = sandbox();
    expect(a.list()).toEqual(['A', 'B', 'C']);
    expect(a.inv(2)).toBe('B');
    expect(a.rec(3)).toBe('C');
  });
  test('agent sees only own schools and can open only their invoices and receipts', () => {
    const a = sandbox(); a.setRole('Sales Agent', 1);
    expect(a.list()).toEqual(['A']);
    expect(a.inv(1)).toBe('A');
    expect(a.rec(1)).toBe('A');
    expect(a.inv(2)).toBeFalsy();
    expect(a.rec(3)).toBeFalsy();
  });
  test('agent with no linked roster entry sees nothing; cannot change school status', () => {
    const a = sandbox(); a.setRole('Sales Agent', null);
    expect(a.list()).toEqual([]);
    a.setRole('Sales Agent', 1);
    expect(a.status(1, 'Inactive')).toBeUndefined();
  });
  test('login user is built from the roster record with the Sales Agent role', () => {
    const u = sandbox().login();
    expect(u).toMatchObject({ name: 'Peter Mwangi', role: 'Sales Agent', agentId: 1, phone: '0712345678' });
  });
  test('registry and roster survive a backup round-trip', () => {
    const a = sandbox();
    const snap = JSON.parse(JSON.stringify({ platform: a.collect() }));
    snap.platform.sdSchools.push({ id: 20, name: 'Z', agentId: 2 }); snap.platform.sdNextId = 21;
    const out = a.apply(snap);
    expect(out.sdSchools.map(s => s.name)).toEqual(['A', 'B', 'C', 'Z']);
    expect(out.sdNextId).toBe(21);
  });
});

describe('Sales Agent wiring in the source', () => {
  test('role is limited to the registry console and hidden from school admins', () => {
    expect(src).toMatch(/ROLE_MODULE_ACCESS\["Sales Agent"\] = \["sysdev"\];/);
    expect(src).toMatch(/u\.role !== "System Developer" && u\.role !== "Sales Agent"\)/);
  });
  test('sales-agent-only restrictions: no delete, no status change, no roster, pricing or switcher', () => {
    expect(fnSrc('sdRemoveSchool')).toMatch(/isSalesAgentRole\(\)\) return;/);
    expect(src).toMatch(/isSalesAgentRole\(\) \? '' : renderSalesAgentsCard\(\)/);
    expect(src).toMatch(/isSalesAgentRole\(\) \? '' : renderPaymentGuideCard\(\)/);
  });
  test('device and cloud restore paths load platform data', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-store.js'), 'utf8')).toMatch(/applyPlatformData\(data\)/);
    expect(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cloud-sync.js'), 'utf8')).toMatch(/applyPlatformData\(data\)/);
  });
});
