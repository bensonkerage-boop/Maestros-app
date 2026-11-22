/* MASMS online-only sign-in ("lenient" mode).
   - Signing in (password or fingerprint) needs a working internet connection and a valid cloud sign-in, so the
     user list is current (removed/suspended people can't get in) and this device is set up to upload its work.
   - Once signed in, the person keeps working even if the signal drops. Marks and everything else are saved on the
     phone and uploaded automatically (cloud-sync.js) when the connection returns, so a DOS elsewhere sees them.
   - Every minute the app checks in with the server. A successful check renews the session. If the phone stays
     offline for more than OFFLINE_LIMIT_HOURS the person is signed out and must connect to sign in again; their
     saved work stays on the phone and is uploaded the next time it is online. A rejected cloud sign-in
     (user removed / school suspended) signs them out at the next check.
   Only active where cloud-sync.js is present (the hosted site and the Android app), not the single-file offline build. */
(function(){
  var OFFLINE_LIMIT_HOURS = 12, CHECK_MS = 60000, PING_TIMEOUT = 6000, STAMP_KEY = 'masmsOnlineAt', TOKEN_KEY = 'masmsCloudToken';
  var API = (window.MASMS_API_BASE || '') + '/api';
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
  function active(){ return !!window.MASMS_CLOUD; }

  // The app is installed with no server address (built without API_BASE): its own built-in web server would answer every
  // /api request with the app's own page and a 200 "OK", which must never count as the internet.
  function unlinked(){
    try{
      var h = location.hostname;
      return !window.MASMS_API_BASE && !!window.Capacitor && (h === 'localhost' || h === '127.0.0.1');
    }catch(e){ return false; }
  }
  // 'ok' = the real MASMS server answered (and accepted the cloud sign-in, when one exists); 'offline' = no answer, or an answer
  // that is not the MASMS server's (an HTML page, a captive portal, the app's own files); 'rejected' = server says this sign-in is no longer valid
  function ping(){
    if(unlinked()) return Promise.resolve('offline');
    if(typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve('offline');
    var token = lsGet(TOKEN_KEY), ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctl) ctl.abort(); }, PING_TIMEOUT);
    var opts = { cache: 'no-store', headers: token ? { Authorization: 'Bearer ' + token } : {} };
    if(ctl) opts.signal = ctl.signal;
    return fetch(API + (token ? '/auth/me' : '/auth/status'), opts).then(function(r){
      if(r.status === 401 || r.status === 403){ clearTimeout(timer); return 'rejected'; }
      if(!r.ok){ clearTimeout(timer); return 'offline'; }
      return r.json().then(function(j){
        clearTimeout(timer);
        var real = j && typeof j === 'object' && (token ? typeof j.username === 'string' : typeof j.needsSetup === 'boolean');
        return real ? 'ok' : 'offline';
      }, function(){ clearTimeout(timer); return 'offline'; });
    }).catch(function(){ clearTimeout(timer); return 'offline'; });
  }
  function stamp(){ lsSet(STAMP_KEY, String(Date.now())); }

  function say(msg){
    try{ loginError = msg; renderLoginPage(); }catch(e){ alert(msg); }
  }

  // Learners and parents sign in on their own phones, which hold no school data and have no cloud account: the server checks
  // them (POST /api/portal/login) and only ever gives them a token for that one learner. So when this device has no cloud
  // sign-in, let the sign-in through if the server accepts the typed details as a learner or parent. (409 = several schools
  // share the admission number; the login page then shows the server's hint.) Staff details are not accepted there.
  function learnerAccepted(){
    var u = document.getElementById('login_username'), p = document.getElementById('login_password');
    var user = u && u.value.trim(), pass = p && p.value.trim();
    if(!user || !pass) return Promise.resolve(false);
    return fetch(API + '/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })
      .then(function(r){
        if(r.status !== 200 && r.status !== 409) return false;
        return r.json().then(function(j){ return !!j && typeof j === 'object' && (r.status === 200 ? typeof j.token === 'string' : typeof j.error === 'string'); }, function(){ return false; });
      }, function(){ return false; });
  }

  // Run `go` only when the server can be reached and the cloud sign-in is valid; otherwise explain and stay on the login page.
  var checking = false;
  function gate(go){
    if(!active()) return go();
    if(checking) return;
    checking = true;
    ping().then(function(st){
      if(st === 'offline'){ checking = false; say(unlinked() ? 'This app is not linked to the MASMS server. Install the latest version of the app.' : 'No internet connection. Connect to the internet to sign in.'); return; }
      var c = window.MASMS_CLOUD;
      if(st === 'rejected' || !c.signedIn()){
        var needCloud = function(){
          checking = false;
          say('Sign in to the cloud first (cloud button, bottom-left), then sign in here.');
          try{ c.click(); }catch(e){}
        };
        if(st === 'rejected') return needCloud();
        learnerAccepted().then(function(ok){ if(ok){ checking = false; go(); } else needCloud(); });
        return;
      }
      // bring the user list up to date first, so a removed or suspended person cannot get in with an old copy (max ~8s)
      var done = false, proceed = function(){ if(done) return; done = true; checking = false; stamp(); go(); };
      setTimeout(proceed, 8000);
      Promise.resolve().then(function(){ return c.syncNow(); }).then(proceed, proceed);
    });
  }

  function wrap(name){
    var orig = window[name];
    if(typeof orig !== 'function' || orig.__onlineGate) return;
    var fn = function(){
      var self = this, args = arguments;
      if(!active()) return orig.apply(self, args);
      if(args[0] && args[0].preventDefault) args[0].preventDefault();
      gate(function(){ orig.apply(self, args); });
    };
    fn.__onlineGate = true;
    window[name] = fn;
  }

  // ---- "offline" banner while signed in ----
  var bar = null;
  function showBar(on){
    if(!bar){
      bar = document.createElement('div');
      bar.style.cssText = 'display:none;position:fixed;left:0;right:0;top:0;z-index:2147482000;background:#b45309;color:#fff;padding:6px 12px;font:600 12.5px Inter,sans-serif;text-align:center';
      bar.textContent = 'You are offline. Your work is saved on this phone and uploads automatically when you reconnect. Reconnect within ' + OFFLINE_LIMIT_HOURS + ' hours to stay signed in.';
      document.body.appendChild(bar);
    }
    bar.style.display = on ? 'block' : 'none';
  }

  function signedInStaff(){ try{ return !!isLoggedIn; }catch(e){ return false; } }

  function check(){
    if(!active() || !signedInStaff()) { showBar(false); return; }
    ping().then(function(st){
      if(!signedInStaff()) return;
      if(st === 'ok'){ stamp(); showBar(false); return; }
      if(st === 'rejected'){
        showBar(false);
        try{ logout(); }catch(e){}
        say('Your cloud sign-in is no longer valid (account removed or school suspended). Sign in again when online.');
        return;
      }
      showBar(true);   // offline: keep working, saved locally
      var last = parseInt(lsGet(STAMP_KEY) || '0', 10);
      if(!last){ stamp(); return; }
      if(Date.now() - last > OFFLINE_LIMIT_HOURS * 3600 * 1000){
        try{ if(window.MASMS_LOCAL) MASMS_LOCAL.saveNow(); }catch(e){}   // make sure everything entered is on the phone
        showBar(false);
        try{ logout(); }catch(e){}
        say('You were offline for more than ' + OFFLINE_LIMIT_HOURS + ' hours, so you were signed out. Your saved work will upload when you reconnect. Connect to the internet to sign in again.');
      }
    });
  }

  function init(){
    if(!active()) return;
    wrap('submitLogin');
    wrap('fpSignIn');
    setInterval(check, CHECK_MS);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    setTimeout(check, 4000);
  }
  window.MASMS_ONLINE_LOGIN = { ping: ping, gate: gate, check: check, OFFLINE_LIMIT_HOURS: OFFLINE_LIMIT_HOURS };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 0); });
  else setTimeout(init, 0);
})();
