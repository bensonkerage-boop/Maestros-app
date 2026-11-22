/* MASMS merge: lets several people work at the same time without overwriting each other.
   The whole school is saved as one snapshot, so two devices that both changed it used to be asked "which copy do you keep?".
   Now the changes are combined by a three-way merge of three copies:
     base   = the data as this device last synced it with the cloud (the common starting point)
     mine   = the data on this device now
     theirs = the newest cloud copy (it holds what the other devices saved)
   Anything only one side changed is simply kept. Where both sides changed the same thing, the rules are:
     - Cells (marks, remarks, comments, max marks, tasks, attendance, photos, roll calls): the later save wins.
     - Lists of records (learners by admission number, receipts by receipt number, library, stores, lab, boarding, discipline,
       payroll, budget, users, teachers, staff ... and any other list whose records have an `id`): new records from both sides
       are kept, edits are merged field by field, deletions are applied.
     - Running totals (copies issued, stock quantity, budget spent, ...): both sides' changes are added together.
     - Receipt / voucher / store-movement / exeat numbers issued on two devices at once: this device's record gets the next free
       number and the counters move on, so no two records share a number (the caller shows a message).
     - Counters (next number to issue) only ever move forward.
     - Marks audit log: both people's entries are kept.
   Only a true clash is left to the person: e.g. one device deleted a learner the other edited, two different learners got the
   same admission number, or both changed the same setting to different values. apply() then returns null and the app asks
   which copy to keep, as before. */
(function(root, factory){
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MASMS_MERGE = api;
})(typeof window !== 'undefined' ? window : this, function(){
  // maps whose cells are merged one by one (later save wins on the same cell)
  var MAP_KEYS = ['marksData', 'marksRemarks', 'marksTeacherComments', 'marksMaxMarks', 'marksTasks', 'marksTaskData',
                  'attendanceRecords', 'attendanceNotes', 'attendanceDayMeta', 'studentPhotos', 'boardingRollCalls', 'kcseResults'];
  var LOG_KEY = 'marksAuditLog';
  var byNames = function(a, b){ return function(r){ var x = r[a], y = r[b]; return (x || y) ? String(x || '') + '|' + String(y || '') : ''; }; };
  // Lists merged record by record. `key` = field(s) or a function giving the record's identity (without one, the whole content
  // is the identity). `deltas` = running totals added together. `renumber` = numbered documents that must never share a number.
  var LIST_SPECS = {
    students:       { key: 'admissionNumber' },
    paymentsLog:    { key: 'receiptNo', renumber: { prefix: 'RCPT-', width: 6, meta: 'nextReceiptNo' } },
    feeAdjustments: { key: 'id' },
    incomeEntries:  {},
    expenseEntries: { key: 'voucherNo', renumber: { prefix: 'PV-', width: 3, meta: 'nextVoucherNo' } },
    feeStructureItems: {},
    libraryBooks:   { key: 'regPrefix', deltas: ['issued', 'copies'] },
    libraryLoans:   { key: ['regNumber', 'issueDate', 'borrower'] },
    libraryLostDamaged: {},
    libraryFines:   { key: 'id' },
    storeItems:     { key: 'code', deltas: ['qty'] },
    storeMovements: { key: 'id', renumber: { prefix: '', width: 0, numeric: true } },
    storeRequisitions: { key: 'id' },
    storeSuppliers: { key: 'name' },
    labItems:       { key: ['name', 'room'], deltas: ['qty'] },
    labUsageLog:    {},
    labIncidents:   {},
    labRequisitions: {},
    labFines:       { key: 'id' },
    boardingDorms:  { key: 'id' },
    boardingAllocations: { key: 'admissionNumber' },
    boardingExeats: { key: 'id', renumber: { prefix: 'EX-', width: 0 } },
    disciplineCases: { key: 'id' },
    disciplineCommittee: { key: 'id' },
    medicalAlerts:  { key: 'id' },
    savedRegisters: {},
    payrollEntries: { key: 'id' },
    budgetItems:    { key: 'category', deltas: ['spent'] },
    transportRoutes: { key: 'id' },
    assignments:    { key: 'id' },
    calendarEvents: {},
    announcementsList: {},
    sentMessages:   {},
    inboxMessages:  {},
    messages:       {},
    parentPortalNotifications: {},
    deletedStudentsLog: {},
    teachersList:   { key: function(r){ return r.tscNumber ? 'tsc:' + r.tscNumber : byNames('surname', 'firstName')(r); } },
    staffList:      { key: function(r){ return r.employeeNumber ? 'emp:' + r.employeeNumber : byNames('name', 'role')(r); } },
    systemUsers:    { key: byNames('name', 'role') },
    bomMembers:     { key: byNames('name', 'role') },
  };
  var LIST_KEYS = Object.keys(LIST_SPECS);
  var MERGE_KEYS = MAP_KEYS.concat([LOG_KEY, 'financeMeta']).concat(LIST_KEYS);
  var IGNORE_TOP = { _meta: 1, exportedAt: 1, currentSchool: 1 };   // per-device noise, not data
  var CLASH = { clash: true };                                       // thrown when the two sides truly disagree

  function isObj(v){ return v !== null && typeof v === 'object' && !Array.isArray(v); }
  // key-order independent text of a value, so two copies of the same data always compare equal
  function canon(v){
    if (v === undefined) return 'u';
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function(k){ return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function union(){ var o = {}; for (var i = 0; i < arguments.length; i++) if (isObj(arguments[i])) Object.keys(arguments[i]).forEach(function(k){ o[k] = 1; }); return Object.keys(o); }

  // ---- cells: write into `t` every cell that `m` changed relative to `b` (the later save wins on the same cell) ----
  function applyMap(b, m, t){
    b = isObj(b) ? b : {}; m = isObj(m) ? m : {};
    union(b, m).forEach(function(k){
      if (canon(b[k]) === canon(m[k])) return;                // I did not touch this cell
      if (m[k] === undefined) { delete t[k]; return; }        // I cleared it
      if (isObj(m[k]) && isObj(t[k])) applyMap(b[k], m[k], t[k]);
      else t[k] = clone(m[k]);
    });
  }

  // add to `t` the audit entries that `m` has and `b` did not (both people's history is kept, newest first)
  function applyLog(b, m, t){
    var had = {}; (Array.isArray(b) ? b : []).forEach(function(e){ had[canon(e)] = 1; });
    var have = {}; (Array.isArray(t) ? t : []).forEach(function(e){ have[canon(e)] = 1; });
    var out = Array.isArray(t) ? t.slice() : [];
    (Array.isArray(m) ? m : []).forEach(function(e){ var c = canon(e); if (!had[c] && !have[c]) { out.push(clone(e)); have[c] = 1; } });
    out.sort(function(x, y){ return String((y && y.ts) || '').localeCompare(String((x && x.ts) || '')); });
    return out;
  }

  // ---- lists of records ----
  function recKey(spec, rec, seen){
    if (spec.key && isObj(rec)) {
      if (typeof spec.key === 'function') { var fk = spec.key(rec); if (fk) return 'k:' + fk; }
      else {
        var fields = Array.isArray(spec.key) ? spec.key : [spec.key], vals = [];
        for (var i = 0; i < fields.length; i++) { var v = rec[fields[i]]; if (v === undefined || v === null || v === '') { vals = null; break; } vals.push(v); }
        if (vals) return 'k:' + vals.join('\u0001');
      }
    }
    var c = canon(rec); seen[c] = (seen[c] || 0) + 1;       // no id: identical records are told apart by how many came before
    return 'c:' + c + '#' + seen[c];
  }
  function index(spec, list){
    var map = {}, order = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function(rec){
      var k = recKey(spec, rec, seen);
      if (k in map) throw CLASH;                              // two records with the same id in one copy: do not guess
      map[k] = rec; order.push(k);
    });
    return { map: map, order: order };
  }
  function numOf(v){ return parseInt(String(v === undefined || v === null ? '' : v).replace(/\D/g, ''), 10) || 0; }
  function pad(n, w){ var x = String(n); while (x.length < w) x = '0' + x; return x; }

  function applyList(b, m, t, spec, ctx){
    var B = index(spec, b), M = index(spec, m), T = index(spec, t);
    var out = Array.isArray(t) ? t.slice() : [];
    var pos = function(k){ return out.indexOf(T.map[k]); };
    var added = [];
    M.order.forEach(function(k){
      var mine = M.map[k];
      if (!(k in B.map)) {                                    // new on this device
        if (k in T.map) {
          if (canon(T.map[k]) === canon(mine)) return;        // the same record already reached the cloud
          if (!spec.renumber || typeof spec.key !== 'string') throw CLASH;   // e.g. two different learners with one admission number
          // both devices issued this number: give this device's document the next free one
          var r = spec.renumber, top = 0;
          out.concat(m, added).forEach(function(x){ top = Math.max(top, numOf(x && x[spec.key])); });
          if (r.meta) top = Math.max(top, numOf(ctx.tMeta[r.meta]) - 1, numOf(ctx.mMeta[r.meta]) - 1);
          var old = mine[spec.key], fresh = r.numeric ? top + 1 : r.prefix + pad(top + 1, r.width);
          mine = clone(mine); mine[spec.key] = fresh;
          if (r.meta) ctx.bump[r.meta] = Math.max(ctx.bump[r.meta] || 0, top + 2);
          if (r.meta === 'nextVoucherNo') ctx.issued.push(fresh);
          ctx.notes.push(old + ' had also been issued on another device, so this one is now ' + fresh + '.');
        }
        added.push(clone(mine)); return;
      }
      if (canon(mine) === canon(B.map[k])) return;            // not touched here
      if (!(k in T.map)) throw CLASH;                         // edited here, deleted elsewhere
      if (canon(T.map[k]) === canon(B.map[k])) out[pos(k)] = clone(mine);          // edited only here
      else if (isObj(mine) && isObj(T.map[k])) {                                  // edited on both: field by field
        var bb = B.map[k], tt = T.map[k], skip = {};
        (spec.deltas || []).forEach(function(f){
          if (typeof bb[f] === 'number' && typeof mine[f] === 'number' && typeof tt[f] === 'number' && mine[f] !== bb[f]) { tt[f] = tt[f] + (mine[f] - bb[f]); skip[f] = 1; }
        });
        var mm2 = clone(mine), bb2 = clone(bb);
        Object.keys(skip).forEach(function(f){ delete mm2[f]; delete bb2[f]; });
        generic(bb2, mm2, tt, '');                            // fields changed by both to different values are a true clash
      }
      else throw CLASH;
    });
    B.order.forEach(function(k){
      if (k in M.map) return;                                 // still here
      if (!(k in T.map)) return;                              // already gone from the cloud copy
      if (canon(T.map[k]) !== canon(B.map[k])) throw CLASH;   // deleted here, edited elsewhere
      out.splice(pos(k), 1);
    });
    return added.concat(out);
  }

  // ---- everything else: a plain three-way merge. Returns the merged value; throws CLASH on a true clash. ----
  function allHaveId(list){
    return Array.isArray(list) && list.every(function(r){ return isObj(r) && r.id !== undefined && r.id !== null && r.id !== ''; });
  }
  function generic(b, m, t, name){
    var cb = canon(b), cm = canon(m), ct = canon(t);
    if (cm === cb) return t;                                  // not changed here
    if (ct === cb) return clone(m);                           // not changed elsewhere
    if (cm === ct) return t;                                  // both made the same change
    if (typeof m === 'number' && typeof t === 'number' && /next|counter/i.test(name || '')) return Math.max(m, t);   // counters only move forward
    if (isObj(m) && isObj(t) && (b === undefined || isObj(b))) {
      var bo = isObj(b) ? b : {};
      union(bo, m, t).forEach(function(k){
        var r = generic(bo[k], m[k], t[k], k);
        if (r === undefined) delete t[k]; else t[k] = r;
      });
      return t;
    }
    if (Array.isArray(m) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      var bl = Array.isArray(b) ? b : [];
      if (allHaveId(m) && allHaveId(t) && allHaveId(bl)) return applyList(bl, m, t, { key: 'id' }, { notes: [], bump: {}, issued: [], tMeta: {}, mMeta: {} });
    }
    throw CLASH;
  }

  // Returns `theirs` with this device's changes added, or null if the two sides truly clash.
  // `theirs` is changed in place; pass a copy if you still need the original. Messages for the user are left in apply.notes.
  function apply(base, mine, theirs){
    apply.notes = [];
    if (!isObj(base) || !isObj(mine) || !isObj(theirs) || !isObj(base.schoolData) || !isObj(mine.schoolData) || !isObj(theirs.schoolData)) return null;
    try {
      union(base, mine, theirs).forEach(function(k){
        if (IGNORE_TOP[k] || k === 'schoolData') return;
        var r = generic(base[k], mine[k], theirs[k], k);
        if (r === undefined) delete theirs[k]; else theirs[k] = r;
      });
      union(base.schoolData, mine.schoolData, theirs.schoolData).forEach(function(s){
        var b = base.schoolData[s], m = mine.schoolData[s], t = theirs.schoolData[s];
        if (!isObj(b) || !isObj(m) || !isObj(t)) {            // a whole school added/removed: plain rules
          var r = generic(b, m, t, s); if (r === undefined) delete theirs.schoolData[s]; else theirs.schoolData[s] = r;
          return;
        }
        MAP_KEYS.forEach(function(k){
          if (canon(b[k]) === canon(m[k])) return;
          if (!isObj(t[k])) t[k] = {};
          applyMap(b[k], m[k], t[k]);
        });
        if (canon(b[LOG_KEY]) !== canon(m[LOG_KEY])) t[LOG_KEY] = applyLog(b[LOG_KEY], m[LOG_KEY], t[LOG_KEY]);
        var ctx = { notes: apply.notes, bump: {}, issued: [], tMeta: isObj(t.financeMeta) ? t.financeMeta : {}, mMeta: isObj(m.financeMeta) ? m.financeMeta : {} };
        LIST_KEYS.forEach(function(k){
          if (canon(b[k]) === canon(m[k])) return;
          t[k] = applyList(b[k], m[k], t[k], LIST_SPECS[k], ctx);
        });
        // counters only ever move forward; the cash-book opening balance follows whoever changed it
        var bm = isObj(b.financeMeta) ? b.financeMeta : {};
        if (canon(bm) !== canon(m.financeMeta) || ctx.issued.length || Object.keys(ctx.bump).length) {
          var tm = isObj(t.financeMeta) ? t.financeMeta : (t.financeMeta = {}), mm = ctx.mMeta;
          ['nextReceiptNo', 'nextVoucherNo'].forEach(function(c){ tm[c] = Math.max(Number(tm[c]) || 1, Number(mm[c]) || 1, ctx.bump[c] || 0); });
          var seen = {}, all = [];
          [tm.issuedVoucherNumbers, mm.issuedVoucherNumbers, ctx.issued].forEach(function(l){ (Array.isArray(l) ? l : []).forEach(function(v){ if (!seen[v]) { seen[v] = 1; all.push(v); } }); });
          tm.issuedVoucherNumbers = all;
          if (canon(bm.cashOpeningBalance) !== canon(mm.cashOpeningBalance)) tm.cashOpeningBalance = mm.cashOpeningBalance;
        }
        // every other setting/list (timetable, classes, grading, terms, portal features ...): plain three-way merge
        union(b, m, t).forEach(function(k){
          if (MERGE_KEYS.indexOf(k) > -1) return;
          var r = generic(b[k], m[k], t[k], k); if (r === undefined) delete t[k]; else t[k] = r;
        });
      });
    } catch (e) {
      if (e === CLASH) return null;
      throw e;
    }
    return theirs;
  }
  apply.notes = [];

  // kept for callers that asked "is it safe to try?": a merge is always attempted now; apply() returns null on a true clash
  function canMerge(base, mine){ return isObj(base) && isObj(mine) && isObj(base.schoolData) && isObj(mine.schoolData); }

  return { canMerge: canMerge, apply: apply, canon: canon, MERGE_KEYS: MERGE_KEYS, LIST_KEYS: LIST_KEYS };
});
