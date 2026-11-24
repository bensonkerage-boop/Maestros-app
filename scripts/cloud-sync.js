/* MASMS cloud sync: signs in to the API, loads saved data on start, autosaves changes, and pulls in changes saved by
   other signed-in devices (checked every 15s, when the app is reopened/refocused, and when the connection returns).
   Uses the app's own globals (collectBackupData, applyPlatformData, loadSchoolData, render). */
(function(){
  var TOKEN_KEY='masmsCloudToken', TENANT_KEY='masmsCloudTenant', API=(window.MASMS_API_BASE||'')+'/api';
  var me=null, token=null, version=0, lastHash='', ready=false, busy=false, pulling=false, state='off';
  var seenEpoch=-1, seenAt=0;   // MASMS_DIRTY (local-store.js) state at the last full serialization
  var baseStr=null, lastSnapStr=null;   // baseStr = text of the data as last synced with the cloud (the common starting point for merging marks)
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
  pill.style.cssText='display:none;position:fixed;left:10px;bottom:10px;z-index:2147483000;border:0;border-radius:999px;padding:6px 12px;font:600 12px Inter,sans-serif;cursor:pointer;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  function paint(){
    var m={off:['#6b7a99','Cloud: sign in'],ok:['#1a9b5a','Cloud: saved'],sync:['#e0900b','Cloud: syncing…'],err:['#d63a3a','Cloud: error — retry']}[state];
    pill.style.background=m[0]; pill.textContent='☁ '+m[1].replace('Cloud: ','');
  }
  function setState(s){ state=s; paint(); try{ window.dispatchEvent(new Event('masms-cloud')); }catch(e){} }
  function signOut(){ token=null; ready=false; me=null; try{localStorage.removeItem(TOKEN_KEY);}catch(e){} setState('off'); }
  // Only the System Developer connects the device to the cloud (once, from the login page or the top bar) and manages it afterwards;
  // nobody else is offered the cloud sign-in, sign-out or account screens. A connected device stays connected (the token renews itself).
  var setupOpen=false, afterSetup=null;
  function isSysDev(){ try{ return !!isLoggedIn && currentUserRole==='System Developer'; }catch(e){ return false; } }
  pill.onclick=function(){
    if(!isSysDev() && !setupOpen){ toast('Only the System Developer can connect or change the cloud sign-in.'); return; }
    if(!token) openDialog(); else openAccount();
  };

  // used by the top-bar / mobile menu "cloud" link
  window.MASMS_CLOUD={ click:function(){ pill.onclick(); }, label:function(){ return {off:'Sign in to cloud',ok:'Cloud: saved',sync:'Cloud: syncing…',err:'Cloud: error – retry'}[state]; }, signedIn:function(){ return !!token; }, setup:function(cb){ if(token){ if(cb) cb(); return; } setupOpen=true; afterSetup=cb||null; openDialog(); }, isSysDev:isSysDev, connect:function(t){ token=t; try{ localStorage.setItem(TOKEN_KEY,t); }catch(e){} return Promise.resolve(start()); }, linkSchools:function(){ return linkSchools(); }, setToken:function(t){ if(t&&t!==token){ token=t; try{ localStorage.setItem(TOKEN_KEY,t); }catch(e){} } }, syncNow:function(){ return pull(true).then(function(){ save(); }); }, api:function(m,path,body){ return api(m,path,body); } };

  function openDialog(){
    api('GET','/auth/status').catch(function(){return {};}).then(function(st){
      var d=document.createElement('div');
      d.style.cssText='position:fixed;inset:0;background:rgba(10,20,40,.55);z-index:2147483001;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif';
      d.innerHTML='<form style="background:#fff;border-radius:14px;padding:22px;width:320px;max-width:92vw;display:grid;gap:10px"><b style="font-size:16px">'+(st.needsSetup?'Create the platform owner account':'Connect this device (System Developer)')+'</b><input name="u" placeholder="Username" autocomplete="username" style="padding:10px;border:1px solid #cfd8ea;border-radius:8px"><input name="p" type="password" placeholder="Password (8+ chars)" autocomplete="current-password" style="padding:10px;border:1px solid #cfd8ea;border-radius:8px"><div class="e" style="color:#d63a3a;font-size:12px;min-height:14px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="c" style="padding:8px 14px;border:1px solid #cfd8ea;background:#fff;border-radius:8px;cursor:pointer">Cancel</button><button style="padding:8px 16px;border:0;background:#1a1aff;color:#fff;border-radius:8px;font-weight:600;cursor:pointer">'+(st.needsSetup?'Create':'Sign in')+'</button></div></form>';
      document.body.appendChild(d);
      var f=d.firstChild; d.querySelector('.c').onclick=function(){ d.remove(); setupOpen=false; afterSetup=null; };
      f.onsubmit=function(ev){ ev.preventDefault();
        api('POST',st.needsSetup?'/auth/register':'/auth/login',{username:f.u.value,password:f.p.value}).then(function(r){
          token=r.token; try{localStorage.setItem(TOKEN_KEY,token);}catch(e){} d.remove(); var cb=afterSetup; setupOpen=false; afterSetup=null; Promise.resolve(start()).then(function(){ if(cb) cb(); });
        }).catch(function(e){ d.querySelector('.e').textContent=e.message; });
      };
    });
  }

  function localReady(){ return (window.MASMS_LOCAL&&MASMS_LOCAL.ready)?MASMS_LOCAL.ready:Promise.resolve(); }
  function markSynced(h){ try{ if(window.MASMS_LOCAL) MASMS_LOCAL.markSynced(h); }catch(e){} }
  function skipExp(k,v){ return k==='exportedAt'?undefined:v; }
  function snapHash(){ lastSnapStr=JSON.stringify(collectBackupData(),skipExp); return hash(lastSnapStr); }
  function setBase(str,ver){ baseStr=str; try{ if(window.MASMS_LOCAL&&MASMS_LOCAL.saveBase) MASMS_LOCAL.saveBase(str,ver); }catch(e){} }
  // Re-apply this device's marks changes (since the last sync) on top of the cloud copy `r`. Returns the merged data, or null.
  function mergeOnto(base,r){
    var M=window.MASMS_MERGE; if(!M||!base||!r||!r.data) return null;
    try{ return M.apply(JSON.parse(base),JSON.parse(JSON.stringify(collectBackupData(),skipExp)),JSON.parse(JSON.stringify(r.data))); }catch(e){ return null; }
  }
  // Load a merged copy: the screen shows everyone's marks and the next save uploads the combined result.
  function adoptMerged(r,merged){
    var cloudStr=JSON.stringify(r.data,skipExp);
    apply(merged); version=r.version||version; lastHash=hash(cloudStr); setBase(cloudStr,version); seenEpoch=-1;
    setState('ok'); toast('Your changes were combined with changes from another device');
    var notes=(window.MASMS_MERGE&&MASMS_MERGE.apply.notes)||[]; if(notes.length){ try{ alert(notes.join('\n')); }catch(e){} }
    setTimeout(save,0);
  }

  // A shared phone or computer may hold another school's data from an earlier sign-in. Never carry it over: wipe it and restart clean.
  function checkSchool(){
    return api('GET','/auth/me').then(function(u){
      if(u.token){ token=u.token; try{ localStorage.setItem(TOKEN_KEY,token); }catch(e){} }   // the server renews a token daily so the device never has to sign in again
      me=u; var prev=null; try{ prev=localStorage.getItem(TENANT_KEY); }catch(e){}
      try{ localStorage.setItem(TENANT_KEY,u.tenant); }catch(e){}
      if(prev&&prev!==u.tenant&&window.MASMS_LOCAL&&MASMS_LOCAL.wipe){
        return MASMS_LOCAL.wipe().then(function(){ location.reload(); return new Promise(function(){}); });   // page reloads; start() runs again with the clean device
      }
    });
  }

  // Every school registered in the app gets its own private cloud space automatically, so its staff can sign in on any phone with no
  // cloud sign-in. Runs on the System Developer's (platform owner's) connected device: after start-up and whenever a school is registered.
  var linking=false;
  var relink=false;
  function linkSchools(){
    // a school registered while another link is in flight is linked as soon as that one ends (not at the 30s retry)
    if(linking){ relink=true; return Promise.resolve(); }
    if(!token||!me||!me.platform) return Promise.resolve();
    var list=[]; try{ list=(typeof sdSchools!=='undefined'?sdSchools:[]).filter(function(r){ return r&&r.name&&!r.cloudCode; }); }catch(e){}
    if(!list.length) return Promise.resolve();
    var snap; try{ snap=collectBackupData(); }catch(e){ return Promise.resolve(); }
    linking=true; var changed=false, chain=Promise.resolve();
    list.forEach(function(r){
      chain=chain.then(function(){
        var seed={ schoolProfile:(snap.schoolProfiles||{})[r.name]||null, schoolData:(snap.schoolData||{})[r.name]||{}, sdRecord:JSON.parse(JSON.stringify(r)) };
        return api('POST','/schools/link',{ name:r.name, seed:seed }).then(function(j){ if(j&&j.code){ r.cloudCode=j.code; changed=true; } }).catch(function(){});   // a failure is retried at the next start-up
      });
    });
    return chain.then(function(){
      linking=false;
      if(relink){ relink=false; setTimeout(linkSchools,0); }
      if(changed){ try{ if(window.MASMS_DIRTY) MASMS_DIRTY.bump(); }catch(e){} }
      // a school that could not be linked now (signal dropped, server busy) is tried again soon: do not wait for the next start-up
      var pending=0; try{ pending=(typeof sdSchools!=='undefined'?sdSchools:[]).filter(function(r){ return r&&r.name&&!r.cloudCode; }).length; }catch(e){}
      if(pending&&!linkTimer) linkTimer=setTimeout(function(){ linkTimer=null; linkSchools(); },5000);
    });
  }
  var linkTimer=null;

  function start(){
    if(!token) return setState('off');
    setState('sync');
    return localReady().then(checkSchool).then(function(){ return api('GET','/data'); }).then(function(r){
      version=r.version||0;
      // data restored from this device that the cloud never received (e.g. entered offline): combine marks if that is all that
      // changed, otherwise let the user choose
      var unsynced=!!(window.MASMS_LOCAL&&MASMS_LOCAL.takeUnsynced())&&r.data;
      var baseP=(unsynced&&MASMS_LOCAL.loadBase)?MASMS_LOCAL.loadBase().catch(function(){ return null; }):Promise.resolve(null);
      return baseP.then(function(b){
        var merged=unsynced&&b&&b.json?mergeOnto(b.json,r):null;
        if(merged){ ready=true; adoptMerged(r,merged); linkSchools(); return; }
        var keepLocal=unsynced&&
          confirm('This device has changes that were never uploaded to the school\'s server.\n\nOK = keep this device\'s data and upload it\nCancel = replace it with the copy on the server');
        if(r.data&&!keepLocal){ apply(r.data); lastHash=snapHash(); markSynced(lastHash); setBase(lastSnapStr,version); ready=true; setState('ok'); }
        else { ready=true; lastHash=''; save(); }
        linkSchools();
      });
    }).catch(function(e){ if(e.status===401){ token=null; try{localStorage.removeItem(TOKEN_KEY);}catch(_){} setState('off'); } else if(e.status===403){ setState('err'); alert(e.message); } else setState('err'); });
  }


  function toast(msg){
    try{
      var t=document.createElement('div');
      t.textContent=msg;
      t.style.cssText='position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:2147483002;background:#152c58;color:#fff;padding:9px 16px;border-radius:999px;font:600 13px Inter,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:90vw;text-align:center';
      document.body.appendChild(t); setTimeout(function(){ t.remove(); },4000);
    }catch(e){}
  }
  function editing(){ var a=document.activeElement, n=a&&a.tagName; return n==='INPUT'||n==='TEXTAREA'||n==='SELECT'||(a&&a.isContentEditable); }

  // Check whether another device saved newer data; if so load it (or ask, when this device has unsaved changes too).
  // force=true skips the "user is typing" delay.
  function pull(force){
    if(!ready||!token||busy||pulling) return Promise.resolve();
    pulling=true;
    return api('GET','/data/version').then(function(m){
      if(!m||!(m.version>version)) return;
      var dirty; try{ dirty=snapHash()!==lastHash; }catch(e){ dirty=false; }
      if(!dirty&&!force&&editing()) return;               // don't redraw the screen under someone who is typing; retry next check
      if(dirty&&!force&&/^portal:/.test(m.updatedBy||'')){ seenEpoch=-1; setTimeout(save,0); return; }   // only learners saved quiz attempts: upload ours; the server keeps both
      var attempt=Promise.resolve(false);
      if(dirty&&baseStr&&window.MASMS_MERGE){
        // combine this device's changes with the other device's data instead of asking which copy to keep
        if(editing()) return;   // not under someone who is typing; the next check retries
        setState('sync');
        attempt=api('GET','/data').then(function(r){
          var merged=mergeOnto(baseStr,r);
          if(!merged) return false;   // a true clash (e.g. one device deleted what the other edited): ask below
          adoptMerged(r,merged); return true;
        });
      }
      return attempt.then(function(done){
      if(done) return;
      if(dirty){
        var who=m.updatedBy?(' ('+m.updatedBy+')'):'';
        var useCloud=confirm('Another device'+who+' saved newer data to the school\'s server, and this device also has changes that were not uploaded yet.\n\nOK = load the other device\'s data (this device\'s unsaved changes are replaced)\nCancel = keep this device\'s data and overwrite the copy on the server');
        if(!useCloud){ version=m.version; seenEpoch=-1; return; }   // next save() uploads this device's data on top of the newer version
      }
      setState('sync');
      return api('GET','/data').then(function(r){
        if(!r.data) return;
        apply(r.data); version=r.version||m.version; lastHash=snapHash(); markSynced(lastHash); setBase(lastSnapStr,version); seenEpoch=-1;
        setState('ok'); toast('Updated with the latest saved data'+(r.updatedBy?' (saved by '+r.updatedBy+')':''));
      });
      });
    }).catch(function(e){
      if(e.status===401){ token=null; ready=false; try{localStorage.removeItem(TOKEN_KEY);}catch(_){} setState('off'); }
      else if(state==='sync') setState('err');
    }).then(function(){ pulling=false; if(state==='sync') setState('ok'); });
  }

  // idle=true is the timer path: skip the expensive serialize+hash while nothing has changed since the last check.
  function save(idle){
    if(!ready||!token||busy||pulling) return;
    var D=window.MASMS_DIRTY;
    if(idle===true&&D&&D.epoch===seenEpoch&&Date.now()-seenAt<D.RECHECK) return;
    var ep=D?D.epoch:-1, snap; try{ snap=collectBackupData(); }catch(e){ return; }
    var str=JSON.stringify(snap,skipExp), h=hash(str);
    seenEpoch=ep; seenAt=Date.now();
    if(h===lastHash) return;
    busy=true; setState('sync');
    var base=version;
    api('PUT','/data',{data:snap,baseVersion:version}).then(function(r){ version=r.merged?base:r.version; lastHash=h; markSynced(h); if(!r.merged) setBase(str,version); setState('ok'); linkSchools(); })   // merged: the server added learners' attempts, so the next check loads them
      .catch(function(e){
        seenEpoch=-1;   // upload failed: retry on the next tick even if nothing else changes
        if(e.status===409){ busy=false; pull(true); }   // another device saved first: pull() loads it or lets the user choose
        else if(e.status===401){ token=null; setState('off'); }
        else{ setState('err'); if(e.status===413&&!window.__tooBigShown){ window.__tooBigShown=1; try{ toast('The school data is too big to upload (server limit 4 MB), so learners and staff on other devices cannot sign in. Remove or shrink photos, then it uploads by itself.'); }catch(_){} } }
      }).then(function(){ busy=false; });
  }


  // ---- Account panel: who is signed in, change password, manage this school's users, (platform owner) manage schools ----
  function esc(t){ return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  var BTN='padding:8px 14px;border:1px solid #cfd8ea;background:#fff;border-radius:8px;cursor:pointer;font:600 13px Inter,sans-serif';
  var BTN1='padding:8px 14px;border:0;background:#1a1aff;color:#fff;border-radius:8px;cursor:pointer;font:600 13px Inter,sans-serif';
  var INP='padding:9px;border:1px solid #cfd8ea;border-radius:8px;font:13px Inter,sans-serif;width:100%;box-sizing:border-box';
  function modal(html){
    var d=document.createElement('div');
    d.style.cssText='position:fixed;inset:0;background:rgba(10,20,40,.55);z-index:2147483001;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:12px';
    d.innerHTML='<div style="background:#fff;border-radius:14px;padding:20px;width:560px;max-width:100%;max-height:90vh;overflow:auto;display:grid;gap:12px;color:#152c58">'+html+'</div>';
    d.addEventListener('click',function(e){ if(e.target===d) d.remove(); });
    document.body.appendChild(d); return d;
  }
  function msg(d,t,bad){ var m=d.querySelector('.msg'); if(m){ m.textContent=t||''; m.style.color=bad?'#d63a3a':'#1a9b5a'; } }
  function ask(label,type){ var v=prompt(label); return v; }

  function openAccount(){
    var u=me||{username:'',tenantName:'',role:''};
    var admin=u.role==='admin'||u.platform;
    var d=modal('<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:17px">Cloud account</b><button type="button" class="x" style="'+BTN+'">Close</button></div>'+
      '<div style="font-size:14px;line-height:1.6">Signed in as <b>'+esc(u.username)+'</b> · '+(u.platform?'platform owner':esc(u.role))+'<br>School: <b>'+esc(u.tenantName||u.tenant||'')+'</b><br><span style="color:#6b7a99">'+esc(window.MASMS_CLOUD.label())+'</span></div>'+
      '<div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="sync" style="'+BTN1+'">Sync now</button><button type="button" class="pw" style="'+BTN+'">Change my password</button>'+
      (admin?'<button type="button" class="users" style="'+BTN+'">Users of this school</button>':'')+
      (u.platform?'<button type="button" class="schools" style="'+BTN+'">All schools</button>':'')+
      '<button type="button" class="out" style="'+BTN+';color:#d63a3a">Sign out</button></div><div class="msg" style="font-size:13px;min-height:16px"></div>');
    d.querySelector('.x').onclick=function(){ d.remove(); };
    d.querySelector('.sync').onclick=function(){ msg(d,'Syncing…'); window.MASMS_CLOUD.syncNow().then(function(){ msg(d,'Up to date.'); }); };
    d.querySelector('.out').onclick=function(){ if(confirm('Sign out of cloud sync on this device?')){ d.remove(); signOut(); } };
    d.querySelector('.pw').onclick=function(){
      var cur=prompt('Current password:'); if(cur==null) return;
      var nw=prompt('New password (8+ characters):'); if(nw==null) return;
      api('POST','/auth/password',{current:cur,password:nw}).then(function(){ msg(d,'Password changed.'); }).catch(function(e){ msg(d,e.message,true); });
    };
    if(admin) d.querySelector('.users').onclick=function(){ d.remove(); openUsers(null); };
    if(u.platform) d.querySelector('.schools').onclick=function(){ d.remove(); openSchools(); };
  }

  function openUsers(tenant){
    api('GET','/users'+(tenant?'?tenant='+encodeURIComponent(tenant):'')).then(function(r){
      var rows=r.users.map(function(x){
        var self=me&&x.username===me.username;
        return '<tr><td style="padding:6px 8px">'+esc(x.username)+(self?' <i>(you)</i>':'')+'</td><td style="padding:6px 8px">'+esc(x.platform?'platform owner':x.role)+'</td><td style="padding:6px 8px;text-align:right;white-space:nowrap">'+
          '<button type="button" data-pw="'+esc(x.username)+'" style="'+BTN+'">Reset password</button> '+(self?'':'<button type="button" data-rm="'+esc(x.username)+'" style="'+BTN+';color:#d63a3a">Remove</button>')+'</td></tr>';
      }).join('');
      var d=modal('<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">Users · '+esc(r.tenant)+'</b><button type="button" class="x" style="'+BTN+'">Close</button></div>'+
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'+rows+'</table></div>'+
        '<form class="add" style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:center"><input name="u" placeholder="New username" autocomplete="off" style="'+INP+'"><input name="p" placeholder="Password (8+ chars)" autocomplete="new-password" style="'+INP+'"><select name="r" style="'+INP+';width:auto"><option value="staff">staff</option><option value="admin">admin</option></select><button style="'+BTN1+'">Add</button></form>'+
        '<div class="msg" style="font-size:13px;min-height:16px"></div><div style="font-size:12px;color:#6b7a99">Staff sign in to the cloud with these details, then use the school\'s own app login inside.</div>');
      d.querySelector('.x').onclick=function(){ d.remove(); };
      d.querySelector('.add').onsubmit=function(ev){ ev.preventDefault(); var f=ev.target;
        api('POST','/auth/register',{username:f.u.value,password:f.p.value,role:f.r.value,tenant:tenant||undefined}).then(function(){ d.remove(); openUsers(tenant); }).catch(function(e){ msg(d,e.message,true); }); };
      d.querySelectorAll('[data-rm]').forEach(function(b){ b.onclick=function(){ var n=b.getAttribute('data-rm'); if(!confirm('Remove '+n+'? They will be signed out and cannot sign in again.')) return;
        api('DELETE','/users/'+encodeURIComponent(n)).then(function(){ d.remove(); openUsers(tenant); }).catch(function(e){ msg(d,e.message,true); }); }; });
      d.querySelectorAll('[data-pw]').forEach(function(b){ b.onclick=function(){ var n=b.getAttribute('data-pw'); var np=prompt('New password for '+n+' (8+ characters):'); if(np==null) return;
        api('PUT','/users/'+encodeURIComponent(n)+'/password',{password:np}).then(function(){ msg(d,'Password reset for '+n+'.'); }).catch(function(e){ msg(d,e.message,true); }); }; });
    }).catch(function(e){ alert(e.message); });
  }

  function openSchools(){
    api('GET','/schools').then(function(r){
      var rows=r.schools.map(function(x){
        return '<tr><td style="padding:6px 8px"><b>'+esc(x.name)+'</b><br><span style="color:#6b7a99">code: '+esc(x.code)+'</span></td><td style="padding:6px 8px">'+x.users+' users<br><span style="color:#6b7a99">'+(x.lastSaved?'saved '+esc(new Date(x.lastSaved).toLocaleString()):'no data yet')+'</span></td>'+
          '<td style="padding:6px 8px;text-align:right;white-space:nowrap"><button type="button" data-u="'+esc(x.code)+'" style="'+BTN+'">Users</button> <button type="button" data-t="'+esc(x.code)+'" data-a="'+(x.active?1:0)+'" style="'+BTN+(x.active?';color:#d63a3a':'')+'">'+(x.active?'Suspend':'Restore')+'</button></td></tr>';
      }).join('');
      var d=modal('<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">Schools on this server</b><button type="button" class="x" style="'+BTN+'">Close</button></div>'+
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'+rows+'</table></div>'+
        '<form class="add" style="display:grid;gap:8px;border-top:1px solid #e3e9f5;padding-top:12px"><b style="font-size:14px">Add a school</b><input name="n" placeholder="School name" style="'+INP+'"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input name="u" placeholder="Admin username" autocomplete="off" style="'+INP+'"><input name="p" placeholder="Admin password (8+ chars)" autocomplete="new-password" style="'+INP+'"></div><button style="'+BTN1+'">Create school</button></form>'+
        '<div class="msg" style="font-size:13px;min-height:16px"></div><div style="font-size:12px;color:#6b7a99">Each school has its own private data and users. Give the new admin their username and password; they add their own staff.</div>');
      d.querySelector('.x').onclick=function(){ d.remove(); };
      d.querySelector('.add').onsubmit=function(ev){ ev.preventDefault(); var f=ev.target;
        api('POST','/schools',{name:f.n.value,adminUsername:f.u.value,adminPassword:f.p.value}).then(function(){ d.remove(); openSchools(); }).catch(function(e){ msg(d,e.message,true); }); };
      d.querySelectorAll('[data-u]').forEach(function(b){ b.onclick=function(){ d.remove(); openUsers(b.getAttribute('data-u')); }; });
      d.querySelectorAll('[data-t]').forEach(function(b){ b.onclick=function(){ var on=b.getAttribute('data-a')==='1';
        if(on&&!confirm('Suspend this school? Nobody there can sign in or sync until you restore it. Their data is kept.')) return;
        api('PATCH','/schools/'+encodeURIComponent(b.getAttribute('data-t')),{active:!on}).then(function(){ d.remove(); openSchools(); }).catch(function(e){ msg(d,e.message,true); }); }; });
    }).catch(function(e){ alert(e.message); });
  }

  document.addEventListener('DOMContentLoaded',function(){ document.body.appendChild(pill); paint(); start(); });
  setInterval(function(){ if(!document.hidden) save(true); },10000);      // upload this device's changes
  setInterval(function(){ if(!document.hidden) pull(); },15000);          // download other devices' changes
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(); else pull(); });
  window.addEventListener('focus',function(){ pull(); });
  window.addEventListener('online',function(){ pull(true).then(function(){ save(); }); });
})();
