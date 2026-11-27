// The timetable teachers see is exactly the one posted from the print preview: break direction (horizontal/vertical), fonts, etc.
// travel with the posted copy and are applied only while a teacher's view is built.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const grab = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('missing ' + from); return src.slice(a, b); };
function make() {
  const code = grab('function ttPrintSnapshot()', 'function ttEntryIsDirty') + grab('function tpWithTimetable(', 'let tpPreviewUrl') + `
    return { ttPrintSnapshot, ttPrintApply, tpWithTimetable,
      state: () => ({ brk: ttBreakPrintSetup, periods: timetablePeriods }),
      setBrk: d => { ttBreakPrintSetup = { ...ttBreakPrintSetup, direction: d }; },
      setEntries: e => { savedTimetables = e; },
      seen: () => seen };`;
  return new Function(`
    let ttDaysPrintSetup={}, ttClassPrintSetup={}, ttBreakPrintSetup={direction:'auto',fontSize:'12'}, ttTimePrintSetup={}, ttHeaderPrintSetup={},
        ttLessonPrintSetup={}, ttLessonFieldLabels={}, ttGroupPrintSetup={}, timetableWholeStyle='compact', timetablePeriods=[{id:'p1'}],
        TIMETABLE_DAYS=['MONDAY'], timetableDayMeta={}, timetableWeekend='Sat', timetableData={live:1}, timetableMeta=null, savedTimetables=[];
    let seen=null;
    ${code}`)();
}
test('a posted timetable is shown to teachers with the break direction it was posted with, then the admin setup is restored', () => {
  const t = make();
  t.setBrk('horizontal');
  const snap = t.ttPrintSnapshot();
  t.setBrk('up');                                       // admin later changes the setting but has not re-posted
  t.setEntries([{ id: 'a', name: 'T', type: 'Teaching', term: 'Term 1', status: 'posted', data: { x: 1 }, postedData: { x: 2 }, postedPrintSetup: snap }]);
  let during;
  t.tpWithTimetable('a', () => { during = t.state().brk.direction; });
  expect(during).toBe('horizontal');
  expect(t.state().brk.direction).toBe('up');
});
test('older posted timetables without a saved setup still open', () => {
  const t = make();
  t.setEntries([{ id: 'b', name: 'T', type: 'Teaching', term: 'Term 1', status: 'posted', data: {}, postedData: {} }]);
  expect(() => t.tpWithTimetable('b', () => 1)).not.toThrow();
});
test('the source stores the setup on save and post, and restores it when a saved timetable is reopened', () => {
  expect(src).toMatch(/e\.postedPrintSetup = JSON\.parse\(JSON\.stringify\(e\.printSetup\)\)/);
  expect(src).toMatch(/e\.printSetup = ttPrintSnapshot\(\)/);
  expect(src).toMatch(/ttPrintApply\(entry\.printSetup, false\)/);
});
