// Writes dist/MASMS_standalone.html: the patched source with dark mode inlined, for the desktop wrapper
// (keeps the original relative vendor/ links and embedded images).
const fs = require('fs'), path = require('path');
const { injectDark, injectLocal } = require('./build');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = injectLocal(injectDark(fs.readFileSync(path.join(root, 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8')));
fs.writeFileSync(path.join(root, 'dist', 'MASMS_standalone.html'), out);
console.log('dist/MASMS_standalone.html', (out.length / 1048576).toFixed(2) + 'MB');
