/* MASMS app-update: checks for a newer version automatically, with no button to press.
   Android app, installed from Google Play:  Play "in-app update" (downloads in the background, then one tap to restart;
                                              an urgent release is forced with the full-screen Play update flow).
   Android app, installed from an APK file:   asks GET /api/app-version and shows an "Update available" banner that opens the download link.
   Website / installed web app / live-URL app: the service worker is re-checked, and a "Reload" banner appears when a new build was loaded.
   When it checks: shortly after start, every time the app comes back to the foreground (at most once an hour), and every 6 hours while open.
   Failures (offline, server down) are silent and retried on the next trigger. "Later" hides a banner for 24 hours; a release
   below the server's minimum version cannot be dismissed. Data is saved to the device first, so nothing is lost by updating. */
(function () {
  if (window.MASMS_UPDATE) return;
  var START_DELAY = 4000, MIN_GAP = 3600e3, EVERY = 6 * 3600e3, SNOOZE = 24 * 3600e3, KEY = 'masmsUpdateSnooze';
  var lastCheck = 0, running = false, bannerEl = null, flexListener = false;

  function cap() { return window.Capacitor; }
  function isNative() { try { var C = cap(); return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform() && C.getPlatform() === 'android'); } catch (e) { return false; } }
  function plug(n) { try { var C = cap(); return (C && C.Plugins && C.Plugins[n]) || null; } catch (e) { return null; } }
  function now() { return Date.now(); }

  // ---- snooze ("Later") ----
  function snoozed(ver) {
    try { var o = JSON.parse(localStorage.getItem(KEY) || 'null'); return !!(o && o.v === String(ver) && now() - o.t < SNOOZE); } catch (e) { return false; }
  }
  function snooze(ver) { try { localStorage.setItem(KEY, JSON.stringify({ v: String(ver), t: now() })); } catch (e) {} }

  // ---- UI ----
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; }
  function hide() { if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl); bannerEl = null; }
  // opts: {title, text, action:{label,fn}, later:fn|null, force:bool, progress:bool}
  function show(opts) {
    hide();
    if (!document.body) return;
    var wrap;
    if (opts.force) {
      wrap = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(10,20,45,.88);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif');
    } else {
      wrap = el('div', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;padding:0 12px calc(12px + env(safe-area-inset-bottom,0px));pointer-events:none;font-family:Inter,system-ui,sans-serif');
    }
    var card = el('div', 'pointer-events:auto;background:#152c58;color:#fff;border-radius:14px;padding:14px 16px;max-width:440px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.35);' + (opts.force ? 'text-align:center;padding:22px' : ''));
    card.setAttribute('role', 'alert');
    card.appendChild(el('div', 'font-weight:700;font-size:15px;margin-bottom:4px', opts.title));
    if (opts.text) card.appendChild(el('div', 'font-size:13px;line-height:1.4;opacity:.9;margin-bottom:12px', opts.text));
    var row = el('div', 'display:flex;gap:8px;justify-content:' + (opts.force ? 'center' : 'flex-end'));
    if (opts.later) {
      var lb = el('button', 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,.45);border-radius:9px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer', 'Later');
      lb.type = 'button'; lb.onclick = function () { hide(); opts.later(); }; row.appendChild(lb);
    }
    if (opts.action) {
      var ab = el('button', 'background:#f5b400;color:#152c58;border:0;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:800;cursor:pointer', opts.action.label);
      ab.type = 'button'; ab.onclick = function () { opts.action.fn(ab); }; row.appendChild(ab);
    }
    if (row.childNodes.length) card.appendChild(row);
    wrap.appendChild(card); document.body.appendChild(wrap); bannerEl = wrap;
    return card;
  }
  function saveFirst() {
    try { var L = window.MASMS_LOCAL; if (L && L.saveNow) return Promise.resolve(L.saveNow()).catch(function () {}); } catch (e) {}
    return Promise.resolve();
  }

  // ---- Android ----
  function fetchServerVersion() {
    var base = (window.MASMS_API_BASE || '').replace(/\/$/, '');
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctl && setTimeout(function () { ctl.abort(); }, 10000);
    return fetch(base + '/api/app-version', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (t) clearTimeout(t); if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function openUrl(url) { try { if (!window.open(url, '_system')) location.href = url; } catch (e) { location.href = url; } }

  function offerFlexible(AU, info, forced) {
    var ver = info.availableVersionCode || 'play';
    if (!forced && snoozed(ver)) return;
    show({
      title: 'Update available', text: 'A new version of MASMS is ready. It downloads in the background while you keep working.',
      later: forced ? null : function () { snooze(ver); },
      force: forced,
      action: { label: 'Update now', fn: function (btn) {
        btn.disabled = true; btn.textContent = 'Downloading…';
        saveFirst().then(function () { return AU.startFlexibleUpdate(); }).then(function (r) {
          // code 1 = the person said no in Google's own dialog
          if (r && r.code === 1) { hide(); }
        }).catch(function () { hide(); });
      } }
    });
  }
  function offerInstall(AU) {
    show({
      title: 'Update downloaded', text: 'Restart MASMS to finish installing the new version. Your data is saved first.',
      action: { label: 'Restart now', fn: function () { saveFirst().then(function () { return AU.completeFlexibleUpdate(); }).catch(function () {}); } },
      later: function () {}
    });
  }
  function listenFlexible(AU) {
    if (flexListener || !AU.addListener) return;
    flexListener = true;
    try { AU.addListener('onFlexibleUpdateStateChange', function (s) { if (s && s.installStatus === 11) offerInstall(AU); }); } catch (e) {}
  }

  function sideloadFlow(cur, srv) {
    var latest = parseInt(srv.latestVersionCode, 10) || 0, min = parseInt(srv.minVersionCode, 10) || 0;
    var url = srv.downloadUrl || srv.playUrl;
    if (!latest || latest <= cur || !url) return;
    var forced = min > cur;
    if (!forced && snoozed(latest)) return;
    show({
      title: forced ? 'Update required' : 'Update available',
      text: (forced ? 'This version is no longer supported. ' : '') + 'MASMS ' + (srv.latestVersionName || '') + ' is available.' + (srv.notes ? ' ' + srv.notes : ''),
      force: forced, later: forced ? null : function () { snooze(latest); },
      action: { label: 'Download update', fn: function () { openUrl(url); } }
    });
  }

  function checkAndroid() {
    var AU = plug('AppUpdate'), A = plug('App');
    var play = AU && AU.getAppUpdateInfo ? AU.getAppUpdateInfo() : Promise.reject(new Error('no plugin'));
    return play.then(function (info) {
      listenFlexible(AU);
      // 3 = a flexible update was started earlier; 11 (downloaded) is reported by the listener, but it may have been missed while backgrounded
      if (info.updateAvailability === 3) { offerInstall(AU); return; }
      if (info.updateAvailability !== 2) return;
      var urgent = (info.updatePriority || 0) >= 4 && info.immediateUpdateAllowed;
      if (urgent) { saveFirst().then(function () { return AU.performImmediateUpdate(); }).catch(function () { offerFlexible(AU, info, false); }); return; }
      if (info.flexibleUpdateAllowed) offerFlexible(AU, info, false);
      else if (info.immediateUpdateAllowed) offerFlexible({ startFlexibleUpdate: AU.performImmediateUpdate.bind(AU) }, info, false);
    }, function () {
      // Not installed from Google Play (APK file, or Play unavailable): compare with the server's published version
      return Promise.all([A && A.getInfo ? A.getInfo() : Promise.reject(new Error('no app plugin')), fetchServerVersion()])
        .then(function (r) { sideloadFlow(parseInt(r[0].build, 10) || 0, r[1]); });
    });
  }

  // ---- Website / installed web app / live-URL app ----
  var swArmed = false;
  function armSW() {
    if (swArmed || !('serviceWorker' in navigator)) return;
    swArmed = true;
    var had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!had) { had = true; return; }   // first install is not an update
      show({
        title: 'New version ready', text: 'MASMS was updated. Reload to start using it. Your data is saved first.',
        action: { label: 'Reload', fn: function () { saveFirst().then(function () { location.reload(); }); } }, later: function () {}
      });
    });
  }
  function checkWeb() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    armSW();
    return navigator.serviceWorker.getRegistration().then(function (reg) { return reg && reg.update(); }).catch(function () {});
  }

  // ---- scheduling ----
  function check(force) {
    if (running || (!force && now() - lastCheck < MIN_GAP)) return Promise.resolve();
    if (navigator.onLine === false) return Promise.resolve();
    running = true; lastCheck = now();
    var p;
    try { p = isNative() ? checkAndroid() : checkWeb(); } catch (e) { p = Promise.resolve(); }
    if (isNative()) checkWeb();   // live-URL Android app also has a service worker
    return Promise.resolve(p).catch(function () {}).then(function () { running = false; });
  }

  window.MASMS_UPDATE = { check: function () { return check(true); }, version: 1 };
  armSW();
  setTimeout(function () { check(true); }, START_DELAY);
  setInterval(function () { check(true); }, EVERY);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(false); });
  window.addEventListener('online', function () { check(false); });
  // Android: "resume" fires when the app returns from the background (visibilitychange covers most devices, this is the safety net)
  try { var A = plug('App'); if (A && A.addListener) A.addListener('resume', function () { check(false); }); } catch (e) {}
})();
