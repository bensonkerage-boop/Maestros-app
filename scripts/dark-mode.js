/* MASMS dark mode: toggle button + smooth transition, remembers choice, follows the system by default.
   Works by inverting the page's colours (images/video re-inverted) so every hard-coded colour is covered. */
(function(root, factory){
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.init();
})(typeof window !== 'undefined' ? window : this, function(win){
  var KEY = 'masmsTheme';
  var CSS = [
    'html{color-scheme:light}',
    'html.theme-anim,html.theme-anim *{transition:background-color .35s ease,color .35s ease,border-color .35s ease,filter .45s ease!important}',
    'html[data-theme="dark"]{filter:invert(.92) hue-rotate(180deg);background:#fff;color-scheme:dark}',
    'html[data-theme="dark"] img,html[data-theme="dark"] video,html[data-theme="dark"] canvas,html[data-theme="dark"] iframe,html[data-theme="dark"] .no-dark-invert{filter:invert(1) hue-rotate(180deg)}',
    // Surfaces that are already dark in light mode keep their navy look (their own colours are re-inverted)
    'html[data-theme="dark"] .login-page,html[data-theme="dark"] .sidebar,html[data-theme="dark"] .login-cert-frame{filter:invert(.92) hue-rotate(180deg)}',
    'html[data-theme="dark"] .sidebar img{filter:none}',
    '#masmsThemeBtn{position:fixed;left:10px;bottom:46px;z-index:2147483000;width:34px;height:34px;border:0;border-radius:50%;cursor:pointer;background:#152c58;color:#fff;font-size:16px;line-height:34px;padding:0;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:transform .3s ease}',
    '#masmsThemeBtn:hover{transform:rotate(25deg) scale(1.08)}',
    '@media print{html[data-theme="dark"],html[data-theme="dark"] img,html[data-theme="dark"] canvas{filter:none!important}#masmsThemeBtn{display:none}}'
  ].join('\n');

  function read(){ try{ return win.localStorage.getItem(KEY); }catch(e){ return null; } }
  function write(v){ try{ win.localStorage.setItem(KEY, v); }catch(e){} }
  function systemPrefersDark(){ try{ return !!(win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches); }catch(e){ return false; } }
  function resolve(){ var s = read(); return (s === 'dark' || s === 'light') ? s : (systemPrefersDark() ? 'dark' : 'light'); }

  function apply(theme, animate){
    var el = win.document.documentElement;
    if (animate){ el.classList.add('theme-anim'); win.setTimeout(function(){ el.classList.remove('theme-anim'); }, 600); }
    el.setAttribute('data-theme', theme);
    var b = win.document.getElementById('masmsThemeBtn');
    if (b){ b.textContent = theme === 'dark' ? '☀' : '☾'; b.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(theme === 'dark')); }
    return theme;
  }
  function toggle(){ var next = win.document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; write(next); return apply(next, true); }

  function init(){
    var d = win.document;
    if (!d.getElementById('masmsThemeCss')){ var st = d.createElement('style'); st.id = 'masmsThemeCss'; st.textContent = CSS; (d.head || d.documentElement).appendChild(st); }
    apply(resolve(), false);                       // before first paint: no flash
    function mount(){
      if (d.getElementById('masmsThemeBtn')) return;
      var b = d.createElement('button'); b.id = 'masmsThemeBtn'; b.type = 'button'; b.onclick = toggle;
      d.body.appendChild(b); apply(d.documentElement.getAttribute('data-theme'), false);
    }
    if (d.body) mount(); else d.addEventListener('DOMContentLoaded', mount);
  }
  return { init: init, toggle: toggle, apply: apply, resolve: resolve, KEY: KEY };
});
