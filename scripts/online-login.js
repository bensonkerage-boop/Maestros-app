/* MASMS online-only sign-in ("lenient" mode).
   - Signing in (password or fingerprint) needs a working internet connection and a connection to the person's school. Nobody is
     asked to sign in to the cloud: the first time on a device the server finds the school that holds the typed staff details and
     connects the device to it by itself (POST /api/staff/login); the device then stays connected. (The System Developer's device is linked the same way, by the server, via POST /api/sysdev/connect.) So the
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
    // navigator.onLine is NOT trusted: Firefox and Edge report false on VPNs, some Wi-Fi/proxy set-ups and Windows "limited
    // connectivity" even when the server is reachable, which used to block every sign-in. The real request below decides.
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
        if(real && token && typeof j.token === 'string'){   // the server renewed this device's cloud sign-in: keep it
          lsSet(TOKEN_KEY, j.token);
          try{ if(window.MASMS_CLOUD && MASMS_CLOUD.setToken) MASMS_CLOUD.setToken(j.token); }catch(e){}
        }
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
  var lastLearnerStatus = 0;   // what the server answered to the learner/parent check (0 = no answer), shown in the failure message
  function learnerAccepted(){
    var u = document.getElementById('login_username'), p = document.getElementById('login_password');
    var user = u && u.value.trim(), pass = p && p.value.trim();
    if(!user || !pass) return Promise.resolve(false);
    return fetch(API + '/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })
      .then(function(r){
        lastLearnerStatus = r.status;
        if(r.status !== 200 && r.status !== 409) return false;
        return r.json().then(function(j){ return !!j && typeof j === 'object' && (r.status === 200 ? typeof j.token === 'string' : typeof j.error === 'string'); }, function(){ return false; });
      }, function(){ lastLearnerStatus = 0; return false; });
  }

  // Ask the server whether the typed details are a staff account in some school. 200 gives this device that school's token.
  function staffConnect(){
    var u = document.getElementById('login_username'), p = document.getElementById('login_password');
    var user = u && u.value.trim(), pass = p && p.value.trim();
    if(!user || !pass) return Promise.resolve({ status: 400 });
    return fetch(API + '/staff/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })
      .then(function(r){
        return r.json().then(function(j){
          j = (j && typeof j === 'object') ? j : {};
          return { status: r.status, token: (r.status === 200 && typeof j.token === 'string') ? j.token : null, error: typeof j.error === 'string' ? j.error : '' };
        }, function(){ return { status: r.status }; });
      });
  }

  // System Developer: the server checks the typed details and connects this device to the platform account by itself (POST /api/sysdev/connect).
  function sysdevConnect(user, pass){
    return fetch(API + '/sysdev/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })
      .then(function(r){
        return r.json().then(function(j){
          j = (j && typeof j === 'object') ? j : {};
          return { status: r.status, token: (r.status === 200 && typeof j.token === 'string') ? j.token : null, error: typeof j.error === 'string' ? j.error : '' };
        }, function(){ return { status: r.status }; });
      });
  }

  function typedSysDev(){
    try{
      var u = document.getElementById('login_username'), p = document.getElementById('login_password');
      return !!u && !!p && u.value.trim().toLowerCase() === SYSDEV_USERNAME.toLowerCase() && p.value.trim() === SYSDEV_PASSWORD;
    }catch(e){ return false; }
  }

  // Run `go` only when the server can be reached and the cloud sign-in is valid; otherwise explain and stay on the login page.
  var checking = false;
  function gate(go){
    if(!active()) return go();
    if(checking) return;
    checking = true;
    ping().then(function(st){
      if(st === 'offline'){ checking = false; say(unlinked() ? 'This app is not linked to the MASMS server yet. Open the MASMS website on this phone and tap "Open it and connect to this school server", or install the latest app.' : 'No internet connection. Connect to the internet to sign in.'); return; }
      var c = window.MASMS_CLOUD;
      if(st === 'rejected' || !c.signedIn()){
        // This device is not connected to a school yet. Nobody is asked to sign in to the cloud: the server finds the school that
        // holds the typed staff details and connects the device to it by itself, then the normal sign-in carries on. (The System
        // Developer, whose details are not in any school, makes the one-time platform connection instead.)
        var fail = function(msg){ checking = false; say(msg); };
        if(typedSysDev() && c.connect){
          var u0 = document.getElementById('login_username'), p0 = document.getElementById('login_password'), tu0 = u0.value, tp0 = p0.value;
          // The System Developer's device links itself: the server checks the typed details (no cloud username/password is asked for).
          return sysdevConnect(tu0.trim(), tp0.trim()).then(function(r){
            if(r.token){
              return c.connect(r.token).then(function(){
                var u1 = document.getElementById('login_username'), p1 = document.getElementById('login_password');
                if(u1) u1.value = tu0; if(p1) p1.value = tp0;
                checking = false; stamp(); go();
              });
            }
            if(r.status === 429) return fail('Too many sign-in attempts from this network. Wait about 15 minutes and try again.');
            if(r.status === 501) return fail(r.error || 'This server is not set up to connect the System Developer automatically.');
            return fail(r.error || 'Could not connect this device to the MASMS server. Check the connection and try again.');
          }, function(){ fail('No internet connection. Connect to the internet to sign in.'); });
        }
        staffConnect().then(function(r){
          if(r.token && c.connect){
            var tu = document.getElementById('login_username').value, tp = document.getElementById('login_password').value;
            return c.connect(r.token).then(function(){
              var u1 = document.getElementById('login_username'), p1 = document.getElementById('login_password');
              if(u1) u1.value = tu; if(p1) p1.value = tp;
              checking = false; stamp(); go();
            });
          }
          if(r.status === 400) return fail('Enter your username and password. (A fingerprint works once this device has signed in with a password.)');
          if((r.status === 409 || r.status === 403) && r.error) return fail(r.error);
          return learnerAccepted().then(function(ok){
            if(ok){ checking = false; go(); return; }
            if(r.status === 429 || lastLearnerStatus === 429) return fail('Too many sign-in attempts from this network. Wait about 15 minutes and try again.');
            var code = ' [staff ' + (r.status || '?') + ', learner ' + lastLearnerStatus + ']';
            fail('Incorrect username or password. If your details are right, your school\'s records may not have reached the server yet: ask the school to open MASMS online and wait until the cloud shows "saved".' + code); });
        }, function(){ fail('No internet connection. Connect to the internet to sign in.'); });
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
        say('Your sign-in is no longer valid (account removed or school suspended). Sign in again when online.');
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
