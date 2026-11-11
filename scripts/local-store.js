/* MASMS on-device storage: keeps a full snapshot of the app's data on the phone/browser itself
   (IndexedDB, falling back to localStorage), restores it on start, and keeps one older copy.
   Works with no internet or server. Cloud sync (cloud-sync.js) still runs on top when signed in.
   Uses the app's own globals (collectBackupData, applyPlatformData, loadSchoolData, render). */
(function(){
  // Change tracker shared with cloud-sync.js. The autosave timers used to serialize and hash the whole dataset
  // every few seconds even when nothing had changed; now they skip that while this epoch has not moved.
  // The epoch moves on every render() and on any user input/click/key, which covers every way data is edited.
  // A full check still happens at least every RECHECK ms, and always when the app is hidden or closed.
  var D=window.MASMS_DIRTY;
  if(!D){
    D=window.MASMS_DIRTY={ epoch:1, RECHECK:60*1000, bump:function(){ D.epoch++; } };
    ['input','change','click','keydown','paste','drop'].forEach(function(t){ document.addEventListener(t,D.bump,true); });
  }
  (function wrapRender(){
    var r=window.render;
    if(typeof r==='function'&&!r.__dirtyWrapped){
      var w=function(){ D.epoch++; return r.apply(this,arguments); };
      w.__dirtyWrapped=true; window.render=w;
    }
  })();

  var DB='masmsLocal', STORE='kv', KEY='snapshot', PREV='snapshotPrev', SYNCED='masmsLocalSyncedHash';
  var PREV_EVERY=30*60*1000, TICK=5000;
  var ready=false, readFailed=false, busy=false, state='load', errMsg='';
  var lastHash='', lastObj=null, prevAt=0, hadUnsynced=false, resolveReady;
  var seenEpoch=-1, seenAt=0;   // change-tracker state at the last full serialization
  var readyP=new Promise(function(r){ resolveReady=r; });

  // same hash + replacer as cloud-sync.js so both sides can compare snapshots
  function hash(s){ var h=5381,i=s.length; while(i) h=(h*33)^s.charCodeAt(--i); return String(h>>>0)+':'+s.length; }
  function skipExported(k,v){ return k==='exportedAt'?undefined:v; }

  // Every storage call is time-limited: a database that never answers (some desktop webviews do this)
  // must not leave autosave stuck in "busy" forever.
  function withTimeout(p,ms,what){
    return new Promise(function(res,rej){
      var t=setTimeout(function(){ rej(new Error(what+' timed out')); },ms);
      p.then(function(v){ clearTimeout(t); res(v); },function(e){ clearTimeout(t); rej(e); });
    });
  }
  var dbP=null, idbDeadUntil=0;   // after a failed open, skip IndexedDB for a minute and use the fallback straight away
  function idb(){
    if(dbP) return dbP;
    if(Date.now()<idbDeadUntil) return Promise.reject(new Error('IndexedDB unavailable'));
    dbP=withTimeout(new Promise(function(res,rej){
      if(!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
      var q; try{ q=indexedDB.open(DB,1); }catch(e){ return rej(e); }
      q.onupgradeneeded=function(){ q.result.createObjectStore(STORE); };
      q.onsuccess=function(){ var db=q.result; db.onclose=function(){ dbP=null; }; db.onversionchange=function(){ try{ db.close(); }catch(e){} dbP=null; }; res(db); };
      q.onerror=function(){ rej(q.error); };
      q.onblocked=function(){ rej(new Error('IndexedDB blocked')); };
    }),6000,'IndexedDB open').catch(function(e){ dbP=null; idbDeadUntil=Date.now()+60000; throw e; });
    return dbP;
  }
  function lsKey(k){ return 'masmsLocal:'+k; }

  // localStorage fallback (used when IndexedDB is unavailable, e.g. some desktop webviews on file://).
  // It holds only ~5MB, so large data is gzip-compressed first when the browser supports it.
  function b64FromBytes(u8){ var s='',i,CH=0x8000; for(i=0;i<u8.length;i+=CH) s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH)); return btoa(s); }
  function bytesFromB64(b){ var s=atob(b),u=new Uint8Array(s.length),i; for(i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u; }
  function streamBytes(stream,input){
    var w=stream.writable.getWriter(); w.write(input); w.close();
    return new Response(stream.readable).arrayBuffer().then(function(b){ return new Uint8Array(b); });
  }
  function lsSet(k,obj){
    var json=JSON.stringify(obj);
    try{ localStorage.setItem(lsKey(k),json); return Promise.resolve(); }catch(e){
      if(typeof CompressionStream==='undefined') return Promise.reject(e);
      return streamBytes(new CompressionStream('gzip'),new TextEncoder().encode(json)).then(function(u8){
        localStorage.setItem(lsKey(k),'gz:'+b64FromBytes(u8));
      });
    }
  }
  function lsGet(k){
    var s=localStorage.getItem(lsKey(k)); if(!s) return Promise.resolve(null);
    if(s.slice(0,3)!=='gz:') return Promise.resolve(JSON.parse(s));
    return streamBytes(new DecompressionStream('gzip'),bytesFromB64(s.slice(3))).then(function(u8){ return JSON.parse(new TextDecoder().decode(u8)); });
  }
  function get(k){
    return idb().then(function(db){ return withTimeout(new Promise(function(res,rej){
      var r=db.transaction(STORE,'readonly').objectStore(STORE).get(k);
      r.onsuccess=function(){ res(r.result||null); }; r.onerror=function(){ rej(r.error); };
    }),10000,'IndexedDB read'); }).catch(function(){
      return lsGet(k);   // throws -> caller treats as a read failure
    });
  }
  function put(k,obj){
    return idb().then(function(db){ return withTimeout(new Promise(function(res,rej){
      var t=db.transaction(STORE,'readwrite'); t.objectStore(STORE).put(obj,k);
      t.oncomplete=function(){ res(); }; t.onerror=function(){ rej(t.error); }; t.onabort=function(){ rej(t.error||new Error('write aborted')); };
    }),15000,'IndexedDB write'); }).catch(function(){ return lsSet(k,obj); });
  }

  function syncedHash(){ try{ return localStorage.getItem(SYNCED)||''; }catch(e){ return ''; } }

  function parse(o){ try{ return o&&o.json?JSON.parse(o.json):null; }catch(e){ return null; } }
  function apply(data){
    if(!data||typeof data!=='object'||!data.schoolData||typeof data.schoolData!=='object') return false;
    if(Array.isArray(data.schools)&&data.schools.length) schools=data.schools;
    if(data.schoolProfiles&&typeof data.schoolProfiles==='object') schoolProfiles=data.schoolProfiles;
    schoolData=data.schoolData;
    try{ applyPlatformData(data); }catch(e){ console.warn('platform data',e); }
    currentSchool=(typeof data.currentSchool==='string'&&schools.indexOf(data.currentSchool)>-1)?data.currentSchool:schools[0];
    loadSchoolData(currentSchool);
    try{ render(); }catch(e){ console.warn('render after local restore',e); }
    return true;
  }

  function snapshot(){
    var snap=collectBackupData();
    var json=JSON.stringify(snap,skipExported);
    return { snap:snap, json:json, h:hash(json) };
  }

  // idle=true is the timer path: skip the expensive serialize+hash while nothing has changed.
  function save(force,idle){
    if(!ready||readFailed||busy) return Promise.resolve();
    if(idle&&!force&&D.epoch===seenEpoch&&Date.now()-seenAt<D.RECHECK) return Promise.resolve();
    var ep=D.epoch, s; try{ s=snapshot(); }catch(e){ return Promise.resolve(); }
    seenEpoch=ep; seenAt=Date.now();
    if(!force&&s.h===lastHash) return Promise.resolve();
    busy=true; state='saving';
    var now=Date.now(), obj={ savedAt:new Date(now).toISOString(), hash:s.h, json:s.json };   // serialized: the live app objects keep changing
    var rotate=(lastObj&&now-prevAt>PREV_EVERY)?put(PREV,lastObj).then(function(){ prevAt=now; }).catch(function(){}):Promise.resolve();
    return rotate.then(function(){ return put(KEY,obj); }).then(function(){
      lastHash=s.h; lastObj=obj; state='ok'; errMsg='';
    }).catch(function(e){
      state='err'; errMsg=(e&&e.message)||'could not write to phone storage';
      seenEpoch=-1;   // a failed write must be retried on the next tick even if nothing else changes
    }).then(function(){ busy=false; paint(); });
  }

  function savedLabel(){
    if(state==='err') return '⚠ Phone storage problem: '+errMsg+' — download a backup now';
    if(state==='load') return 'Checking phone storage…';
    if(readFailed) return '⚠ Could not read phone storage — autosave paused. Download a backup.';
    if(!lastObj) return 'Not saved on this device yet';
    var d=new Date(lastObj.savedAt);
    return 'Saved on this device · '+d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  }
  function paint(){ var el=document.getElementById('masmsLocalStatus'); if(el) el.textContent=savedLabel(); }

  function restorePrevious(){
    return get(PREV).then(function(o){
      if(!o||!o.json){ alert('There is no earlier copy on this device yet.'); return false; }
      var when=new Date(o.savedAt).toLocaleString();
      if(!confirm('Replace the current data with the earlier copy from '+when+'?\n\nAnything entered since then will be lost. Download a backup first if unsure.')) return false;
      if(!apply(parse(o))){ alert('The earlier copy could not be read.'); return false; }
      return save(true).then(function(){ return true; });
    }).catch(function(e){ alert('Could not read the earlier copy: '+((e&&e.message)||e)); return false; });
  }

  var firstLoad=true;
  function init(){
    if(firstLoad){ try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist(); }catch(e){} }
    return get(KEY).then(function(o){
      readFailed=false; errMsg='';
      if(firstLoad){
        if(o&&o.json&&apply(parse(o))){
          lastObj=o; lastHash=o.hash||'';
          hadUnsynced=!!o.hash&&o.hash!==syncedHash();
        }
      } else if(o&&o.json){
        // The first read failed, so this copy was never loaded. Saving now would overwrite it with
        // whatever is on screen, so autosave stays paused until the app is restarted and loads it.
        readFailed=true; errMsg='an earlier copy exists on this device; restart the app to load it';
      }
    }).catch(function(e){ readFailed=true; errMsg=(e&&e.message)||''; })
      .then(function(){ firstLoad=false; ready=true; state=readFailed?'err':'ok'; paint(); resolveReady(); });
  }
  // A read problem used to pause autosave until the app was restarted. Now it is retried every half minute,
  // and saving resumes as soon as the stored copy can be read (or is confirmed empty).
  var retryAt=0;
  function retryRead(){
    if(!readFailed||busy||Date.now()<retryAt) return;
    retryAt=Date.now()+30000; dbP=null; init();
  }

  window.MASMS_LOCAL={
    ready:readyP,
    saveNow:function(){ return save(true); },
    tick:function(){ retryRead(); save(false,true); paint(); },   // what the autosave timer runs
    status:savedLabel,
    restorePrevious:restorePrevious,
    // cloud-sync tells us which snapshot hash the server holds, so we can tell if this device has un-uploaded changes
    markSynced:function(h){ try{ localStorage.setItem(SYNCED,h||''); }catch(e){} },
    // true once, right after start-up, if the restored data had changes the cloud never received
    takeUnsynced:function(){ var v=hadUnsynced; hadUnsynced=false; return v; }
  };

  document.addEventListener('DOMContentLoaded',init);
  setInterval(function(){ window.MASMS_LOCAL.tick(); },TICK);
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(false); });
  window.addEventListener('pagehide',function(){ save(false); });
})();
