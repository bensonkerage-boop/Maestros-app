// Landing page shown before login in the WEB BROWSER only. In the Android app (bundled or live-URL) there is no landing page:
// the app opens straight on the sign-in card.
// injectLanding(html) puts pwa/landing.html (embedded as an iframe srcdoc, so it also works offline, in the APK and as a
// single file) at the start of <body>. Its "Log in" button hides it and reveals the app's own login page.
// It is skipped when someone is already signed in (saved session), when the address ends in #app, and for the rest of the
// tab/app session once Log in was pressed. Logging out shows it again.
const fs = require('fs'), path = require('path');

const RUNTIME = `(function(){
  var f=document.getElementById('masms-landing');
  if(!f) return;
  // Android app (Capacitor): no landing page at all, go straight to the sign-in card. window.MASMS_LANDING stays undefined, so the
  // sign-in card shows no Home/close buttons either.
  // Detected two ways, so it can never depend on timing: the Capacitor bridge, or the "MASMSApp" tag the Android app adds to its user agent
  // (capacitor.config.js android.appendUserAgent). The browser version has neither and keeps the landing page, its Log in button and Home arrow.
  var isApp=false;
  try{var C0=window.Capacitor;isApp=!!(C0&&C0.isNativePlatform&&C0.isNativePlatform())}catch(e){}
  if(!isApp){try{isApp=/MASMSApp/.test(navigator.userAgent)}catch(e){}}
  // Browser-installed app (Chrome/Edge "Install app" / "Add to Home screen"): it runs in its own window (display-mode standalone, iOS navigator.standalone), so it behaves like the APK: no landing page, straight to sign-in.
  if(!isApp){try{isApp=!!(window.matchMedia&&(matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: fullscreen)').matches||matchMedia('(display-mode: minimal-ui)').matches))||navigator.standalone===true||/android-app:\/\//.test(document.referrer)}catch(e){}}
  if(isApp){f.parentNode.removeChild(f);return}
  var root=document.documentElement, prev=root.style.overflow, loaded=false;
  function ss(){try{return window.sessionStorage}catch(e){return null}}
  function ls(){try{return window.localStorage}catch(e){return null}}
  function ok(raw,idleMs){try{var o=JSON.parse(raw||'null');return !!(o&&o.name&&o.role&&(!idleMs||(o.ts&&Date.now()-o.ts<idleMs)))}catch(e){return false}}
  // same two places keep-session.js saves "who is signed in" (tab copy, and on-device copy with an 8 hour idle limit)
  function signedIn(){var s=ss(),l=ls();return !!((s&&ok(s.getItem('masmsSession')))||(l&&ok(l.getItem('masmsSessionL'),8*3600*1000)))}
  function seen(v){var s=ss();if(!s)return false;try{if(v===undefined)return s.getItem('masms_landing_seen')==='1';if(v)s.setItem('masms_landing_seen','1');else s.removeItem('masms_landing_seen')}catch(e){}return false}
  function show(){
    if(!loaded){f.srcdoc=window.__MASMS_LANDING_HTML__;loaded=true}
    prev=root.style.overflow;root.style.overflow='hidden';f.hidden=false;
  }
  function hide(){root.style.overflow=prev;f.hidden=true}
  // back arrow on the login page: return to the landing page's Home view
  function home(){
    seen(false);show();
    try{var w=f.contentWindow;if(w&&w.location.hash&&w.location.hash!=='#home')w.location.hash='#home';else if(w)w.scrollTo(0,0)}catch(e){}
    try{window.scrollTo(0,0)}catch(e){}
  }
  window.MASMS_LANDING={show:show,hide:hide,home:home,refresh:function(){if(loaded)try{f.contentWindow.MASMS_WEBPAGE_APPLY()}catch(e){}},visible:function(){return !f.hidden}};
  if(!(seen()||/(^|[#&])app$/.test(location.hash)||signedIn())) show();
  window.addEventListener('message',function(e){
    if(e.source!==f.contentWindow||e.data!=='masms-login')return;
    seen(true);hide();window.scrollTo(0,0);
    setTimeout(function(){var u=document.getElementById('login_username');try{if(u&&u.offsetParent)u.focus()}catch(x){}},50);
  });
  // Android back button: landing sub-page -> landing Home -> leave the app; login page -> landing Home
  function plug(){try{var C=window.Capacitor;return C&&C.isNativePlatform&&C.isNativePlatform()&&C.Plugins&&C.Plugins.App||null}catch(e){return null}}
  var App=plug();
  if(App&&App.addListener)App.addListener('backButton',function(){
    try{
      if(!f.hidden){
        var w=f.contentWindow,h=w&&w.location.hash;
        if(h&&h!=='#home'&&h!=='#top'&&h!=='#'){w.location.hash='#home';return}
        App.exitApp();return;
      }
      if(typeof isLoggedIn!=='undefined'&&!isLoggedIn){home();return}
      if(window.history.length>1&&(window.Capacitor&&window.Capacitor.getPlatform)){window.history.back();return}
      App.exitApp();
    }catch(e){try{App.exitApp()}catch(x){}}
  });
  // after logging out, start from the landing page again
  document.addEventListener('DOMContentLoaded',function(){
    var w=window.logout;
    if(typeof w==='function')window.logout=function(){var r=w.apply(this,arguments);seen(false);show();return r};
  });
})();`;

// Gallery: pwa/gallery.json lists the photos ([{ "file": "school-open-day.jpg", "title": "...", "caption": "..." }]);
// the image files sit in pwa/gallery/. They are embedded into the page, so they work offline, in the APK and in the single file.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function galleryItems(base) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(base, 'pwa', 'gallery.json'), 'utf8')); } catch (e) { return []; }
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    const f = path.join(base, 'pwa', 'gallery', String(it.file || ''));
    const type = MIME[path.extname(f).toLowerCase()];
    if (!type || !fs.existsSync(f)) { console.warn('gallery: skipped "' + it.file + '" (missing file or not jpg/png/webp/gif)'); continue; }
    const buf = fs.readFileSync(f);
    if (buf.length > 700 * 1024) console.warn('gallery: "' + it.file + '" is ' + Math.round(buf.length / 1024) + 'KB; resize photos to about 1200px wide to keep the app light');
    out.push({ src: 'data:' + type + ';base64,' + buf.toString('base64'), title: it.title || '', caption: it.caption || '' });
  }
  return out;
}
// Home page circle photo: put one picture at pwa/hero.jpg (or .jpeg/.png/.webp); it is embedded like the gallery photos.
function heroPhoto(base) {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const f = path.join(base, 'pwa', 'hero' + ext);
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    if (buf.length > 500 * 1024) console.warn('hero: "hero' + ext + '" is ' + Math.round(buf.length / 1024) + 'KB; use a square-ish photo about 900px wide');
    return 'data:' + MIME[ext] + ';base64,' + buf.toString('base64');
  }
  return '';
}
// Address of the APK the GitHub workflow publishes (releases/download/android-latest/MASMS.apk). Order: APK_URL variable, "apkUrl" in
// server.config.json, then the GitHub repository this build came from (Vercel: VERCEL_GIT_REPO_OWNER/SLUG, Actions: GITHUB_REPOSITORY).
// Empty when none is known: the landing page then shows no download button.
function apkUrl(base) {
  let cfg = ''; try { cfg = String(JSON.parse(fs.readFileSync(path.join(base, 'server.config.json'), 'utf8')).apkUrl || ''); } catch (e) {}
  const e = process.env;
  const repo = e.GITHUB_REPOSITORY || (e.VERCEL_GIT_REPO_OWNER && e.VERCEL_GIT_REPO_SLUG ? e.VERCEL_GIT_REPO_OWNER + '/' + e.VERCEL_GIT_REPO_SLUG : '');
  const u = (e.APK_URL || cfg || (repo ? 'https://github.com/' + repo + '/releases/download/android-latest/MASMS.apk' : '')).trim();
  return /^https:\/\//.test(u) ? u : '';
}
// landing page HTML with the gallery photos filled in (also written to public/landing.html by build.js)
function landingHtml(root) {
  const base = root || path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(base, 'pwa', 'landing.html'), 'utf8');
  return html
    .replace('/*__GALLERY__*/[]', () => JSON.stringify(galleryItems(base)).replace(/<\//g, '<\\/'))
    .replace('/*__HERO__*/""', () => JSON.stringify(heroPhoto(base)))
    .replace('/*__APK_URL__*/""', () => JSON.stringify(apkUrl(base)));
}
// JSON string safe to sit inside an inline <script>
const js = s => JSON.stringify(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));

function injectLanding(html, root) {
  if (html.includes('id="masms-landing"')) return html;   // already there
  const block = '<!-- ===== LANDING PAGE (shown first; its Log in button reveals the app login) ===== -->\n' +
    '<style>#masms-landing{position:fixed;top:0;left:0;width:100%;height:100%;border:0;z-index:2147482000;background:#7ba4fb}#masms-landing[hidden]{display:none}</style>\n' +
    '<iframe id="masms-landing" title="Maestro Advanced School Management System" allowfullscreen hidden></iframe>\n' +
    '<script>window.__MASMS_LANDING_HTML__=' + js(landingHtml(root)) + ';\n' + RUNTIME + '</script>\n' +
    '<!-- ===== END LANDING PAGE ===== -->\n';
  const m = /<body[^>]*>/.exec(html);
  if (!m) throw new Error('no <body> to put the landing page in');
  const i = m.index + m[0].length;
  return html.slice(0, i) + '\n' + block + html.slice(i);
}
module.exports = { injectLanding, landingHtml };
