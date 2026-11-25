// Rebuilds pwa/landing.html from pwa/landing.src.html: compiles the page's Tailwind styles and writes them into the page.
// Run after editing landing.src.html:  npm run landing:css   (needs internet once, for npx to fetch tailwindcss 3.4.17)
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), pwa = path.join(root, 'pwa');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-')), input = path.join(tmp, 'in.css'), output = path.join(tmp, 'out.css');
fs.writeFileSync(input, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
execFileSync('npx', ['--yes', 'tailwindcss@3.4.17', '-c', path.join(pwa, 'landing.tailwind.config.js'), '-i', input, '-o', output, '--minify'], { stdio: 'inherit' });
const src = fs.readFileSync(path.join(pwa, 'landing.src.html'), 'utf8');
if (!src.includes('/*__TAILWIND__*/')) throw new Error('landing.src.html has no /*__TAILWIND__*/ placeholder');
fs.writeFileSync(path.join(pwa, 'landing.html'), src.replace('/*__TAILWIND__*/', () => fs.readFileSync(output, 'utf8').trim()));
console.log('pwa/landing.html rebuilt');
