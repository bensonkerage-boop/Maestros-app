// Short-answer and structured questions can be uploaded from Word / PDF / pasted text (the same line reader as MCQ, a typed parser on top).
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const ctx = {}; vm.createContext(ctx);
vm.runInContext([cut('function qzUid(', 'function qzGrades'), cut('function qzBlankQuestion(', 'function qzBlankQuiz'),
  cut('function qzPtSum(', 'function qzPtSync'), cut('function qzParseTypedLines(', '// -- DOCX')].join('\n') + ';this.f={qzParseBulkTyped,qzParseTypedLines,qzTypedNote};', ctx);
const { qzParseBulkTyped: P, qzParseTypedLines, qzTypedNote } = ctx.f;

test('short answer: answers under each question, | and ; give other accepted wording, extra Answer lines add more', () => {
  const q = P(`1. Name the process by which plants make food.
Answer: photosynthesis | photo synthesis
2. What is the capital of Kenya?
Answer: Nairobi
Also accept: Nairobi City
3. 1.5 litres is how many millilitres?
Answer: 1500; 1,500`, 'short');
  expect(q.map(x => x.text)).toEqual(['Name the process by which plants make food.', 'What is the capital of Kenya?', '1.5 litres is how many millilitres?']);
  expect(q.map(x => x.accepted)).toEqual([['photosynthesis', 'photo synthesis'], ['Nairobi', 'Nairobi City'], ['1500', '1,500']]);
  expect(q.notes.noAnswer).toBe(0);
});
test('short answer: an answer key at the end fills the answers; a question with none is counted', () => {
  const q = P(`1. Capital of Kenya?
2. Chemical symbol of water?
3. Largest planet?
Answers
1. Nairobi
2. H2O
`, 'short');
  expect(q.map(x => x.accepted)).toEqual([['Nairobi'], ['H2O'], []]);
  expect(q.notes.noAnswer).toBe(1);
  expect(qzTypedNote(q, 'a.docx').type).toBe('error');
});
test('structured: marks, parts, worked answer and marking points; the question\'s marks are the points added up', () => {
  const q = P(`1. Explain two causes of soil erosion. (4 marks)
Answer: Deforestation and overgrazing expose the soil.
Marking scheme:
- Deforestation removes ground cover | clearing of trees (2)
- Overgrazing leaves soil bare (2)
2. (a) Define photosynthesis. (2)
(b) State two raw materials. (2)
Marking scheme: Process by which plants make food using light (2)
- Water | H2O (1)
- Carbon dioxide (1)`, 'structured');
  expect(q).toHaveLength(2);
  expect(q[0].marks).toBe(4);
  expect(q[0].modelAnswer).toBe('Deforestation and overgrazing expose the soil.');
  expect(q[0].points).toEqual([{ text:'Deforestation removes ground cover', alt:['clearing of trees'], marks:2 }, { text:'Overgrazing leaves soil bare', alt:[], marks:2 }]);
  expect(q[1].text).toBe('(a) Define photosynthesis. (2)\n(b) State two raw materials. (2)');
  expect(q[1].points.map(p => p.marks)).toEqual([2, 1, 1]);
  expect(q[1].marks).toBe(4);
  expect(q.notes).toEqual({ noAnswer:0, noScheme:0, marksDiffer:0 });
});
test('structured: a numbered marking scheme at the end of the paper is matched to its questions', () => {
  const q = P(`1. Describe the water cycle. (3 marks)
2. State two uses of copper. (2 marks)
Marking scheme
1. Evaporation from seas (1)
Condensation into clouds (1)
Rain falls as precipitation (1)
2. Electrical wires (1)
- Making coins | coinage (1)`, 'structured');
  expect(q[0].points.map(p => p.text)).toEqual(['Evaporation from seas', 'Condensation into clouds', 'Rain falls as precipitation']);
  expect(q[1].points.map(p => p.text)).toEqual(['Electrical wires', 'Making coins']);
  expect(q[1].points[1].alt).toEqual(['coinage']);
  expect(q.map(x => x.marks)).toEqual([3, 2]);
});
test('structured: no scheme means the question waits for the teacher; differing document marks are reported', () => {
  const a = P('1. Discuss the role of the Senate. (6 marks)\nAnswer: Reviews bills.', 'structured');
  expect(a[0].marks).toBe(6); expect(a.notes.noScheme).toBe(1); expect(a.notes.noAnswer).toBe(0);
  const b = P('1. Explain erosion. (5 marks)\nMarking scheme:\n- Cover removed (2)\n- Bare soil (1)', 'structured');
  expect(b[0].marks).toBe(3); expect(b.notes.marksDiffer).toBe(1);
});
test('Word bullets and a PDF bullet character both count as marking points', () => {
  const q = qzParseTypedLines([{ text:'1. Name two gases. (2)' }, { text:'Marking scheme:' }, { text:'Oxygen (1)', bullet:true }, { text:'• Nitrogen (1)' }], 'structured');
  expect(q[0].points.map(p => p.text)).toEqual(['Oxygen', 'Nitrogen']);
});
test('every question carries the full question shape so the editor and the server can use it', () => {
  const [x] = P('1. Capital of Kenya?\nAnswer: Nairobi', 'short');
  expect(Object.keys(x)).toEqual(expect.arrayContaining(['id', 'text', 'options', 'accepted', 'modelAnswer', 'points', 'marks']));
  expect(x.options).toHaveLength(4);
});
test('the editor offers upload and paste for every quiz type, and the importers pick the parser by type', () => {
  expect(src).not.toMatch(/works for multiple-choice quizzes only/);
  expect(src).toMatch(/qt0 === 'mcq' \? qzParseLines\(lines\) : qzParseTypedLines\(lines, qt0\)/);
  expect(src).toMatch(/qzParseBulkTyped\(quizBulkText, qt0\)/);
});

test('KNEC-style codes: M1 / A1 / B1 give the marks, and B marks (independent) must be shown', () => {
  const q = P(`1. Solve 2x + 3 = 13. (4 marks)
Marking scheme:
- 2x = 10 M1
- x = 5 A1
- Writes the check 2(5) + 3 = 13 (B2)`, 'structured');
  expect(q[0].points).toEqual([{ text:'2x = 10', alt:[], marks:1 }, { text:'x = 5', alt:[], marks:1 }, { text:'Writes the check 2(5) + 3 = 13', alt:[], marks:2, shown:true }]);
  expect(q[0].marks).toBe(4);
});
