// Writes dist/MASMS_standalone.html: the patched source with dark mode inlined, for the desktop wrapper
// (keeps the original relative vendor/ links and embedded images).
const fs = require('fs'), path = require('path');
const { injectDark, injectLocal } = require('./build');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
let out = injectLocal(injectDark(fs.readFileSync(path.join(root, 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8')));
// Inline the Excel libraries so the single file works without a vendor/ folder next to it.
const inl = (tag, file) => { const f = path.join(root, 'public', 'vendor', file); if (out.includes(tag) && fs.existsSync(f)) out = out.replace(tag, () => '<script>' + fs.readFileSync(f, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>'); };
inl('<script src="vendor/xlsx.full.min.js"></script>', 'xlsx.full.min.js');
inl('<script src="vendor/exceljs.min.js" onerror="this.remove()"></script>', 'exceljs.min.js');
fs.writeFileSync(path.join(root, 'dist', 'MASMS_standalone.html'), out);
console.log('dist/MASMS_standalone.html', (out.length / 1048576).toFixed(2) + 'MB');
