/* MASMS server link captured by the device. An Android app installed from the live web page needs no typed address: the page's "Open the
   app and connect" button opens the app with masms://link?server=<the site's address>; the app keeps that address (localStorage) and uses
   it as the server from then on. An app built with a fixed address (server.config.json / API_BASE) ignores this. Only https addresses
   are accepted. Runs in <head>, right after window.MASMS_API_BASE is set, so every later script sees the captured address. */
(function(){
  var KEY = 'masmsServer';
  function clean(u){ try{ var x = new URL(u); return (x.protocol === 'https:' && !x.username && !x.password) ? x.origin : ''; }catch(e){ return ''; } }
  function get(){ try{ return localStorage.getItem(KEY) || ''; }catch(e){ return ''; } }
  if(!window.MASMS_API_BASE){ var s = clean(get()); if(s) window.MASMS_API_BASE = s; }
  function capture(url){
    try{
      var x = new URL(url); if(x.protocol !== 'masms:') return false;
      var s = clean(x.searchParams.get('server')); if(!s) return false;
      var changed = get() !== s || window.MASMS_API_BASE !== s;
      try{ localStorage.setItem(KEY, s); }catch(e){}
      if(changed){ window.MASMS_API_BASE = s; try{ location.reload(); }catch(e){} }
      return true;
    }catch(e){ return false; }
  }
  window.MASMS_SERVER_LINK = { capture: capture };
  function hook(){
    try{
      var A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
      if(!A) return;
      A.addListener('appUrlOpen', function(e){ if(e && e.url) capture(e.url); });
      if(A.getLaunchUrl) A.getLaunchUrl().then(function(r){ if(r && r.url) capture(r.url); }, function(){});
    }catch(e){}
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();
})();
