// Builds public/ from source/MAESTRO_MASMS_FINAL.html:
//  - moves big base64 images out to cacheable files under assets/
//  - minifies the inline JS (whitespace/comments only, no renaming, so globals stay intact)
//  - copies vendor libraries + fonts from node_modules, adds cloud sync
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { minify } = require('terser');
const root = path.join(__dirname, '..'), pub = path.join(root, 'public');
let LAZY_LIBS = '';
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
  const js = ['local-store.js', 'keep-session.js', 'app-update.js'].map(f => '<script>' + fs.readFileSync(path.join(__dirname, f), 'utf8') + '</script>').join('\n');
  return html.slice(0, i) + js + '\n' + html.slice(i);
}
const { injectLanding, landingHtml } = require('./landing');
module.exports = { injectDark, injectLocal, injectLanding };
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

  // 2b) Trim what the web build does not need to ship inside the HTML
  //  - Font Awesome is inlined in the source (1MB of base64 fonts, repeated per font-family alias) for the
  //    single-file standalone. The web build already links the identical vendor/fa/all.min.css, so drop the copy.
  {
    const m = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].find(x => x[1].length > 500000 && /Font Awesome Free/.test(x[1].slice(0, 300)) && /base64/.test(x[1]));
    if (m && html.includes('<link href="vendor/fa/all.min.css" rel="stylesheet">')) html = html.replace(m[0], '');
  }
  //  - vendor/qrcode.min.js has no browser build on npm and is never shipped: the tag only produced a 404 on every load
  html = html.replace('<script src="vendor/qrcode.min.js" onerror="this.remove()"></script>', '');
  //  - xlsx (0.9MB) and exceljs (0.9MB) were parser-blocking scripts ahead of the 3MB app script, yet they are only
  //    used when a user imports/exports Excel. Load them right after the page has loaded instead (same order as before).
  const XLSX_TAG = '<script src="vendor/xlsx.full.min.js"></script>', EXCELJS_TAG = '<script src="vendor/exceljs.min.js" onerror="this.remove()"></script>';
  if (html.includes(XLSX_TAG) && html.includes(EXCELJS_TAG)) {
    html = html.replace(XLSX_TAG, '').replace(EXCELJS_TAG, '');
    LAZY_LIBS = '<script>(function(){function L(s,o){var e=document.createElement("script");e.src=s;e.async=false;if(o)e.onerror=function(){e.remove()};document.head.appendChild(e)}' +
      'function go(){L("vendor/xlsx.full.min.js");L("vendor/exceljs.min.js",1)}' +
      'if(document.readyState==="complete")setTimeout(go,0);else addEventListener("load",function(){setTimeout(go,0)})})()</script>\n';
  }

  // 3) Vendor libs, fonts, cloud sync
  const v = (src, dst) => cp(nm(src), path.join(pub, 'vendor', dst));
  v('xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js');
  v('exceljs/dist/exceljs.min.js', 'exceljs.min.js');
  v('pdfjs-dist/build/pdf.min.js', 'pdf.min.js');
  v('pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js');
  // (jspdf, jspdf-autotable and html2canvas are inlined in the page; nothing references separate copies, so none are shipped)
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
  cp(path.join(__dirname, 'online-login.js'), path.join(pub, 'assets/online-login.js'));
  cp(path.join(__dirname, 'marks-merge.js'), path.join(pub, 'assets/marks-merge.js'));
  html = injectLocal(html);   // before cloud sync so MASMS_LOCAL exists when it starts
  // These three files keep fixed names but vercel.json caches /assets/* as immutable for a year, so each address carries a hash
  // of the file: a redeploy with changed code gives a new address and browsers fetch it instead of keeping the old script.
  const ver = f => require('crypto').createHash('md5').update(fs.readFileSync(path.join(pub, 'assets', f))).digest('hex').slice(0, 10);
  { const i = html.lastIndexOf('</body>'); html = html.slice(0, i) + `<script src="/assets/marks-merge.js?v=${ver('marks-merge.js')}"></script>\n<script src="/assets/cloud-sync.js?v=${ver('cloud-sync.js')}"></script>\n<script src="/assets/online-login.js?v=${ver('online-login.js')}"></script>\n` + LAZY_LIBS + html.slice(i); }
  // flat file name vendor/fa/all.min.css has webfonts at ../webfonts relative to css/ — repoint
  fs.writeFileSync(path.join(pub, 'vendor/fa/all.min.css'), fs.readFileSync(path.join(pub, 'vendor/fa/all.min.css'), 'utf8').replace(/\.\.\/webfonts\//g, 'webfonts/'));

  html = injectDark(html);
  // The landing page is first in the web browser only; its Log in button reveals the app login. The Android app (NATIVE_APP=1) has no
  // landing page and opens straight on the sign-in card (scripts/landing.js also hides it at run time when a live-URL app loads the site).
  const androidBuild = process.env.NATIVE_APP === '1';
  if (!androidBuild) html = injectLanding(html, root);
  // PWA: manifest, icons, service worker; optional API base for the Android app (API_BASE=https://your-site)
  fs.cpSync(path.join(root, 'pwa', 'icons'), path.join(pub, 'icons'), { recursive: true });
  cp(path.join(root, 'pwa', 'manifest.webmanifest'), path.join(pub, 'manifest.webmanifest'));
  cp(path.join(root, 'pwa', 'privacy.html'), path.join(pub, 'privacy.html'));   // public privacy policy (Play Store requires a URL)
  if (!androidBuild) fs.writeFileSync(path.join(pub, 'landing.html'), landingHtml(root));   // landing page; its Log in link goes to /#app
  else fs.rmSync(path.join(pub, 'landing.html'), { force: true });
  // The server address is set once in server.config.json ({"apiBase":"https://your-site.vercel.app"}) and every build (web, Android) uses it;
  // the API_BASE environment variable, when present, wins. This is how the Android app is linked to the server with no sign-in step.
  let cfgBase = ''; try{ cfgBase = String(JSON.parse(fs.readFileSync(path.join(root, 'server.config.json'), 'utf8')).apiBase || ''); }catch(e){}
  const apiBase = (process.env.API_BASE || cfgBase).trim().replace(/\/$/, '');
  // online-first Android app (default): it loads the live site, unless LIVE_UPDATES=0
  const LIVE = process.env.LIVE_URL || (process.env.NATIVE_APP === '1' && process.env.LIVE_UPDATES !== '0' ? apiBase : '');
  if (process.env.NATIVE_APP === '1' && !apiBase) throw new Error('Android build needs the server address: set "apiBase" in server.config.json or the API_BASE variable (your site address, e.g. https://your-project.vercel.app). Without it the app has no server to sign in to. Set it as a repository variable (Settings > Secrets and variables > Actions > Variables).');
  // Bundled Android app: no service worker. Live-URL Android app (LIVE_URL set): it is the website, so keep the service worker for offline use.
  const native = process.env.NATIVE_APP === '1' && !LIVE;
  const head = '<link rel="preload" as="font" type="font/woff2" crossorigin href="vendor/fa/webfonts/fa-solid-900.woff2">\n' +
    '<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="#152c58">\n<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">\n' +
    '<script>window.MASMS_API_BASE=' + JSON.stringify(apiBase) + ';window.MASMS_ONLINE_ONLY=true;</script>\n' +
    '<script>' + fs.readFileSync(path.join(__dirname, 'server-link.js'), 'utf8') + '</script>\n' +
    (native ? '' : '<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})</script>\n');
  { const i = html.indexOf('</head>'); html = html.slice(0, i) + head + html.slice(i); }

  // 4) SPEED: move every big inline <script>/<style> out of index.html into content-hashed files under /assets/.
  //    Before, the page was one 3.7MB document that every phone re-downloaded on every visit. Now index.html is a small shell that is
  //    revalidated each time (so a new deploy is seen at once) while the heavy code is fetched once and then served from the browser /
  //    service-worker cache (vercel.json: /assets/* is immutable). Execution order is unchanged: external classic scripts run in
  //    document order exactly like the inline ones did, and top-level declarations stay global.
  const BIG = 20000, shell = [];
  const putAsset = (prefix, ext, text) => {
    const buf = Buffer.from(text, 'utf8');
    const name = 'assets/' + prefix + '-' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 10) + '.' + ext;
    fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(pub, name), buf);
    shell.push('/' + name);
    return '/' + name;
  };
  let nScripts = 0, nStyles = 0;
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, body) => {
    if (body.length < BIG || /\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["']?(?!text\/javascript|application\/javascript)/i.test(attrs)) return m;
    nScripts++;
    return '<script' + attrs + ' src="' + putAsset('js', 'js', body) + '"></script>';
  });
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, attrs, body) => {
    if (body.length < BIG || /\bmedia\s*=|\bid\s*=/.test(attrs) || /url\(\s*(?!['"]?(?:data:|https?:|#|\/))/.test(body)) return m;   // keep ones whose relative url() would resolve differently from /assets/
    nStyles++;
    return '<link rel="stylesheet" href="' + putAsset('css', 'css', body) + '">';
  });

  // 5) Build id = hash of everything that ships in the page, so an unchanged redeploy never triggers a reload on phones and a changed one always does.
  const assetsDir = path.join(pub, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const idHash = crypto.createHash('md5').update(html);
  for (const f of fs.readdirSync(assetsDir).sort()) idHash.update(f).update(fs.readFileSync(path.join(assetsDir, f)));
  const buildId = idHash.digest('hex').slice(0, 12);
  { const i = html.indexOf('<script>window.MASMS_API_BASE='); html = html.slice(0, i) + '<script>window.MASMS_BUILD="' + buildId + '";</script>\n' + html.slice(i); }
  fs.writeFileSync(path.join(pub, 'index.html'), html);
  fs.writeFileSync(path.join(pub, 'version.json'), JSON.stringify({ build: buildId, builtAt: new Date().toISOString() }));

  // 6) Service worker and the offline page (also the Android app's fallback when the live site cannot be reached)
  const liveBase = (LIVE || apiBase || '').replace(/\/$/, '');
  const precache = ['/', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/vendor/fa/all.min.css', '/vendor/fonts.css', '/vendor/fa/webfonts/fa-solid-900.woff2']
    .concat(shell, [...html.matchAll(/src="(\/assets\/[^"]+)"/g)].map(m => m[1])).filter((u, i, a) => a.indexOf(u) === i);
  fs.writeFileSync(path.join(pub, 'sw.js'), fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8').replace('__BUILD_ID__', buildId).replace('__PRECACHE__', JSON.stringify(precache)));
  fs.writeFileSync(path.join(pub, 'offline.html'), fs.readFileSync(path.join(root, 'pwa', 'offline.html'), 'utf8').replace('__LIVE_URL__', JSON.stringify(liveBase || '/')));
  console.log(`index.html ${(before / 1048576).toFixed(2)}MB -> ${(Buffer.byteLength(html) / 1024).toFixed(0)}KB shell + ${nScripts} scripts + ${nStyles} styles in /assets (build ${buildId}); ${seen.size} images extracted`);
})().catch(e => { console.error(e); process.exit(1); });
