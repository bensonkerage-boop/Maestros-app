/* MASMS on-device storage: keeps a full snapshot of the app's data on the phone/browser itself
   (IndexedDB, falling back to localStorage), restores it on start, and keeps one older copy.
   Works with no internet or server. Cloud sync (cloud-sync.js) still runs on top when signed in.
   Uses the app's own globals (collectBackupData, applyPlatformData, loadSchoolData, render). */
(function(){
  var DB='masmsLocal', STORE='kv', KEY='snapshot', PREV='snapshotPrev', SYNCED='masmsLocalSyncedHash';
  var PREV_EVERY=30*60*1000, TICK=5000;
  var ready=false, readFailed=false, busy=false, state='load', errMsg='';
  var lastHash='', lastObj=null, prevAt=0, hadUnsynced=false, resolveReady;
  var readyP=new Promise(function(r){ resolveReady=r; });

  // same hash + replacer as cloud-sync.js so both sides can compare snapshots
  function hash(s){ var h=5381,i=s.length; while(i) h=(h*33)^s.charCodeAt(--i); return String(h>>>0)+':'+s.length; }
  function skipExported(k,v){ return k==='exportedAt'?undefined:v; }

  function idb(){
    return new Promise(function(res,rej){
      if(!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
      var q; try{ q=indexedDB.open(DB,1); }catch(e){ return rej(e); }
      q.onupgradeneeded=function(){ q.result.createObjectStore(STORE); };
      q.onsuccess=function(){ res(q.result); };
      q.onerror=function(){ rej(q.error); };
      q.onblocked=function(){ rej(new Error('IndexedDB blocked')); };
    });
  }
  function lsKey(k){ return 'masmsLocal:'+k; }
  function get(k){
    return idb().then(function(db){ return new Promise(function(res,rej){
      var r=db.transaction(STORE,'readonly').objectStore(STORE).get(k);
      r.onsuccess=function(){ res(r.result||null); }; r.onerror=function(){ rej(r.error); };
    }); }).catch(function(){
      var s=localStorage.getItem(lsKey(k)); return s?JSON.parse(s):null;   // throws -> caller treats as a read failure
    });
  }
  function put(k,obj){
    return idb().then(function(db){ return new Promise(function(res,rej){
      var t=db.transaction(STORE,'readwrite'); t.objectStore(STORE).put(obj,k);
      t.oncomplete=function(){ res(); }; t.onerror=function(){ rej(t.error); }; t.onabort=function(){ rej(t.error||new Error('write aborted')); };
    }); }).catch(function(){ localStorage.setItem(lsKey(k),JSON.stringify(obj)); });
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

  function save(force){
    if(!ready||readFailed||busy) return Promise.resolve();
    var s; try{ s=snapshot(); }catch(e){ return Promise.resolve(); }
    if(!force&&s.h===lastHash) return Promise.resolve();
    busy=true; state='saving';
    var now=Date.now(), obj={ savedAt:new Date(now).toISOString(), hash:s.h, json:s.json };   // serialized: the live app objects keep changing
    var rotate=(lastObj&&now-prevAt>PREV_EVERY)?put(PREV,lastObj).then(function(){ prevAt=now; }).catch(function(){}):Promise.resolve();
    return rotate.then(function(){ return put(KEY,obj); }).then(function(){
      lastHash=s.h; lastObj=obj; state='ok'; errMsg='';
    }).catch(function(e){
      state='err'; errMsg=(e&&e.message)||'could not write to phone storage';
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

  function init(){
    try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist(); }catch(e){}
    get(KEY).then(function(o){
      if(o&&o.json&&apply(parse(o))){
        lastObj=o; lastHash=o.hash||'';
        hadUnsynced=!!o.hash&&o.hash!==syncedHash();
      }
    }).catch(function(e){ readFailed=true; errMsg=(e&&e.message)||''; })
      .then(function(){ ready=true; state=readFailed?'err':'ok'; paint(); resolveReady(); });
  }

  window.MASMS_LOCAL={
    ready:readyP,
    saveNow:function(){ return save(true); },
    status:savedLabel,
    restorePrevious:restorePrevious,
    // cloud-sync tells us which snapshot hash the server holds, so we can tell if this device has un-uploaded changes
    markSynced:function(h){ try{ localStorage.setItem(SYNCED,h||''); }catch(e){} },
    // true once, right after start-up, if the restored data had changes the cloud never received
    takeUnsynced:function(){ var v=hadUnsynced; hadUnsynced=false; return v; }
  };

  document.addEventListener('DOMContentLoaded',init);
  setInterval(function(){ save(false); paint(); },TICK);
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(false); });
  window.addEventListener('pagehide',function(){ save(false); });
})();
