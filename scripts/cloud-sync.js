/* MASMS cloud sync: signs in to the API, loads saved data on start, autosaves changes.
   Uses the app's own globals (collectBackupData, applyPlatformData, loadSchoolData, render). */
(function(){
  var TOKEN_KEY='masmsCloudToken', API=(window.MASMS_API_BASE||'')+'/api';
  var token=null, version=0, lastHash='', ready=false, busy=false, state='off';
  try{ token=localStorage.getItem(TOKEN_KEY); }catch(e){}

  function hash(s){ var h=5381,i=s.length; while(i) h=(h*33)^s.charCodeAt(--i); return String(h>>>0)+':'+s.length; }
  function api(method,path,body){
    return fetch(API+path,{method:method,headers:Object.assign({'Content-Type':'application/json'},token?{Authorization:'Bearer '+token}:{}),body:body?JSON.stringify(body):undefined})
      .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(!r.ok){ var e=new Error(j.error||('HTTP '+r.status)); e.status=r.status; throw e; } return j; }); });
  }
  function apply(data){
    if(Array.isArray(data.schools)) schools=data.schools;
    if(data.schoolProfiles && typeof data.schoolProfiles==='object') schoolProfiles=data.schoolProfiles;
    schoolData=data.schoolData;
    try{ applyPlatformData(data); }catch(e){ console.warn('platform data',e); }
    currentSchool=(typeof data.currentSchool==='string' && schools.indexOf(data.currentSchool)>-1)?data.currentSchool:schools[0];
    loadSchoolData(currentSchool);
    try{ render(); }catch(e){ console.warn('render after cloud load',e); }
  }

  var pill=document.createElement('button');
  pill.type='button';
  pill.style.cssText='position:fixed;left:10px;bottom:10px;z-index:2147483000;border:0;border-radius:999px;padding:6px 12px;font:600 12px Inter,sans-serif;cursor:pointer;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  function paint(){
    var m={off:['#6b7a99','Cloud: sign in'],ok:['#1a9b5a','Cloud: saved'],sync:['#e0900b','Cloud: saving…'],err:['#d63a3a','Cloud: error — retry']}[state];
    pill.style.background=m[0]; pill.textContent='☁ '+m[1].replace('Cloud: ','');
  }
  function setState(s){ state=s; paint(); }
  pill.onclick=function(){ if(!token||state==='err') openDialog(); else if(confirm('Sign out of cloud sync?')){ token=null; ready=false; try{localStorage.removeItem(TOKEN_KEY);}catch(e){} setState('off'); } };

  function openDialog(){
    api('GET','/auth/status').catch(function(){return {};}).then(function(st){
      var d=document.createElement('div');
      d.style.cssText='position:fixed;inset:0;background:rgba(10,20,40,.55);z-index:2147483001;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif';
      d.innerHTML='<form style="background:#fff;border-radius:14px;padding:22px;width:320px;max-width:92vw;display:grid;gap:10px"><b style="font-size:16px">'+(st.needsSetup?'Create cloud admin account':'Cloud sync sign-in')+'</b><input name="u" placeholder="Username" autocomplete="username" style="padding:10px;border:1px solid #cfd8ea;border-radius:8px"><input name="p" type="password" placeholder="Password (8+ chars)" autocomplete="current-password" style="padding:10px;border:1px solid #cfd8ea;border-radius:8px"><div class="e" style="color:#d63a3a;font-size:12px;min-height:14px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="c" style="padding:8px 14px;border:1px solid #cfd8ea;background:#fff;border-radius:8px;cursor:pointer">Cancel</button><button style="padding:8px 16px;border:0;background:#1a1aff;color:#fff;border-radius:8px;font-weight:600;cursor:pointer">'+(st.needsSetup?'Create':'Sign in')+'</button></div></form>';
      document.body.appendChild(d);
      var f=d.firstChild; d.querySelector('.c').onclick=function(){ d.remove(); };
      f.onsubmit=function(ev){ ev.preventDefault();
        api('POST',st.needsSetup?'/auth/register':'/auth/login',{username:f.u.value,password:f.p.value}).then(function(r){
          token=r.token; try{localStorage.setItem(TOKEN_KEY,token);}catch(e){} d.remove(); start();
        }).catch(function(e){ d.querySelector('.e').textContent=e.message; });
      };
    });
  }

  function localReady(){ return (window.MASMS_LOCAL&&MASMS_LOCAL.ready)?MASMS_LOCAL.ready:Promise.resolve(); }
  function markSynced(h){ try{ if(window.MASMS_LOCAL) MASMS_LOCAL.markSynced(h); }catch(e){} }
  function snapHash(){ return hash(JSON.stringify(collectBackupData(),function(k,v){return k==='exportedAt'?undefined:v;})); }

  function start(){
    if(!token) return setState('off');
    setState('sync');
    localReady().then(function(){ return api('GET','/data'); }).then(function(r){
      version=r.version||0;
      // data restored from this device that the cloud never received (e.g. entered offline): let the user choose
      var keepLocal=!!(window.MASMS_LOCAL&&MASMS_LOCAL.takeUnsynced())&&r.data&&
        confirm('This device has changes that were never uploaded to the cloud.\n\nOK = keep this device\'s data and upload it\nCancel = replace it with the cloud copy');
      if(r.data&&!keepLocal){ apply(r.data); lastHash=snapHash(); markSynced(lastHash); ready=true; setState('ok'); }
      else { ready=true; lastHash=''; save(); }
    }).catch(function(e){ if(e.status===401){ token=null; try{localStorage.removeItem(TOKEN_KEY);}catch(_){} setState('off'); } else setState('err'); });
  }

  function save(){
    if(!ready||!token||busy) return;
    var snap; try{ snap=collectBackupData(); }catch(e){ return; }
    var h=hash(JSON.stringify(snap,function(k,v){return k==='exportedAt'?undefined:v;}));
    if(h===lastHash) return;
    busy=true; setState('sync');
    api('PUT','/data',{data:snap,baseVersion:version}).then(function(r){ version=r.version; lastHash=h; markSynced(h); setState('ok'); })
      .catch(function(e){
        if(e.status===409){ alert('Cloud data was changed from another device. Reloading the latest version.'); ready=false; start(); }
        else if(e.status===401){ token=null; setState('off'); } else setState('err');
      }).then(function(){ busy=false; });
  }

  document.addEventListener('DOMContentLoaded',function(){ document.body.appendChild(pill); paint(); start(); });
  setInterval(function(){ if(!document.hidden) save(); },20000);
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(); });
})();
