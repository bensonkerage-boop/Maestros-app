// Builds public/ from source/MAESTRO_MASMS_FINAL.html:
//  - moves big base64 images out to cacheable files under assets/
//  - minifies the inline JS (whitespace/comments only, no renaming, so globals stay intact)
//  - copies vendor libraries + fonts from node_modules, adds cloud sync
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { minify } = require('terser');
const root = path.join(__dirname, '..'), pub = path.join(root, 'public');
const nm = p => path.join(root, 'node_modules', p);
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

function injectDark(html) {
  const js = ['dark-mode.js', 'list-pdf.js'].map(f => '<script>' + fs.readFileSync(path.join(__dirname, f), 'utf8') + '</script>').join('\n');
  const i = html.indexOf('</head>');
  return html.slice(0, i) + js + '\n' + html.slice(i);
}
// on-device storage module, appended to the end of <body> (needs the app's globals)
function injectLocal(html) {
  const i = html.lastIndexOf('</body>');
  return html.slice(0, i) + '<script>' + fs.readFileSync(path.join(__dirname, 'local-store.js'), 'utf8') + '</script>\n' + html.slice(i);
}
module.exports = { injectDark, injectLocal };
if (require.main !== module) return;
(async () => {
  fs.rmSync(pub, { recursive: true, force: true });
  let html = fs.readFileSync(path.join(root, 'source', 'MAESTRO_MASMS_FINAL.html'), 'utf8');
  const before = Buffer.byteLength(html);

  // 1) Extract embedded images (>20KB) to hashed files
  const seen = new Map();
  html = html.replace(/data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]{20000,})/g, (m, ext, b64) => {
    if (!seen.has(m)) {
      const buf = Buffer.from(b64, 'base64');
      const name = 'assets/img-' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 10) + '.' + (ext === 'jpeg' ? 'jpg' : ext);
      fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(pub, name), buf);
      seen.set(m, name);
    }
    return '/' + seen.get(m);
  });

  // 2) Minify inline scripts without renaming anything
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const m of scripts) {
    if (m[1].length < 2000) continue;
    const r = await minify(m[1], { compress: false, mangle: false, format: { comments: false } });
    if (r.code) html = html.replace(m[0], () => '<script>' + r.code.replace(/<\/(script|!--)/gi, '<\\/$1') + '</script>');
  }

  // 3) Vendor libs, fonts, cloud sync
  const v = (src, dst) => cp(nm(src), path.join(pub, 'vendor', dst));
  v('xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js');
  v('exceljs/dist/exceljs.min.js', 'exceljs.min.js');
  v('jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js');
  v('jspdf-autotable/dist/jspdf.plugin.autotable.min.js', 'jspdf.plugin.autotable.min.js');
  v('html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js');
  const fa = nm('@fortawesome/fontawesome-free');
  cp(path.join(fa, 'css/all.min.css'), path.join(pub, 'vendor/fa/css/all.min.css'));
  for (const f of fs.readdirSync(path.join(fa, 'webfonts'))) cp(path.join(fa, 'webfonts', f), path.join(pub, 'vendor/fa/webfonts', f));
  // all.min.css references ../webfonts; the app links vendor/fa/all.min.css, so flatten
  fs.writeFileSync(path.join(pub, 'vendor/fa/all.min.css'), fs.readFileSync(path.join(pub, 'vendor/fa/css/all.min.css'), 'utf8'));
  fs.rmSync(path.join(pub, 'vendor/fa/css'), { recursive: true });
  let css = '';
  for (const [fam, pkg, ws] of [['Inter', 'inter', [400, 500, 600, 700, 800]], ['Poppins', 'poppins', [400, 500, 600, 700, 800]]])
    for (const w of ws) {
      const file = `${pkg}-latin-${w}-normal.woff2`;
      cp(nm(`@fontsource/${pkg}/files/${file}`), path.join(pub, 'vendor/fonts', file));
      css += `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${file}) format('woff2')}\n`;
    }
  fs.writeFileSync(path.join(pub, 'vendor/fonts.css'), css);

  cp(path.join(__dirname, 'cloud-sync.js'), path.join(pub, 'assets/cloud-sync.js'));
  html = injectLocal(html);   // before cloud sync so MASMS_LOCAL exists when it starts
  { const i = html.lastIndexOf('</body>'); html = html.slice(0, i) + '<script src="/assets/cloud-sync.js"></script>\n' + html.slice(i); }
  // flat file name vendor/fa/all.min.css has webfonts at ../webfonts relative to css/ — repoint
  fs.writeFileSync(path.join(pub, 'vendor/fa/all.min.css'), fs.readFileSync(path.join(pub, 'vendor/fa/all.min.css'), 'utf8').replace(/\.\.\/webfonts\//g, 'webfonts/'));

  html = injectDark(html);
  // PWA: manifest, icons, service worker; optional API base for the Android app (API_BASE=https://your-site)
  fs.cpSync(path.join(root, 'pwa', 'icons'), path.join(pub, 'icons'), { recursive: true });
  cp(path.join(root, 'pwa', 'manifest.webmanifest'), path.join(pub, 'manifest.webmanifest'));
  fs.writeFileSync(path.join(pub, 'sw.js'), fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8').replace('__BUILD_ID__', Date.now().toString(36)));
  const apiBase = (process.env.API_BASE || '').replace(/\/$/, '');
  const native = process.env.NATIVE_APP === '1';
  const head = '<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="#152c58">\n<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">\n' +
    '<script>window.MASMS_API_BASE=' + JSON.stringify(apiBase) + ';</script>\n' +
    (native ? '' : '<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})</script>\n');
  { const i = html.indexOf('</head>'); html = html.slice(0, i) + head + html.slice(i); }
  fs.writeFileSync(path.join(pub, 'index.html'), html);
  console.log(`index.html ${(before / 1048576).toFixed(2)}MB -> ${(Buffer.byteLength(html) / 1048576).toFixed(2)}MB; ${seen.size} images extracted`);
})().catch(e => { console.error(e); process.exit(1); });
