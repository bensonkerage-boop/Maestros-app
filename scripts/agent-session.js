/* Sales agent sign-in from any phone or browser.
   Agents are kept in the System Developer's roster, not in a school, so a device that is not connected to the platform account cannot check
   them itself. The server does (POST /api/agent/login) and returns the agent's own record and the schools assigned to them. This script puts
   that into the app's in-memory registry so the normal sign-in carries on (welcome password, forced password change, My Schools).
   Nothing from an agent session is saved on the phone or uploaded as school data (window.MASMS_NO_PERSIST). What the agent changes (a school they
   register or edit, their own password) is sent to the server as small requests; the System Developer's device applies them to the registry. */
(function(){
  var API=(window.MASMS_API_BASE||'')+'/api';
  var A=window.MASMS_AGENT={ active:false, token:null, ids:{} };
  function call(method,path,body){
    return fetch(API+path,{ method:method, headers:Object.assign({'Content-Type':'application/json'},A.token?{Authorization:'Bearer '+A.token}:{}), body:body?JSON.stringify(body):undefined })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status:r.status, ok:r.ok, data:j&&typeof j==='object'?j:{} }; }); });
  }
  function apply(p){
    window.MASMS_NO_PERSIST=true;   // never written to this phone's storage, never uploaded as school data
    A.active=true; A.ids={};
    (p.schools||[]).forEach(function(r){ if(!r.pending) A.ids[r.id]=1; });
    try{ saAgents=[p.agent]; }catch(e){}
    try{ sdSchools=p.schools||[]; }catch(e){}
    try{ if(p.sdAccountInfo&&typeof p.sdAccountInfo==='object') sdAccountInfo=p.sdAccountInfo; }catch(e){}
    try{ if(Number.isFinite(p.sdInvoiceNextNo)) sdInvoiceNextNo=Math.max(sdInvoiceNextNo,p.sdInvoiceNextNo); if(Number.isFinite(p.sdReceiptNextNo)) sdReceiptNextNo=Math.max(sdReceiptNextNo,p.sdReceiptNextNo); }catch(e){}
    try{ if(Number.isFinite(p.sdNextId)) sdNextId=Math.max(sdNextId,p.sdNextId); }catch(e){}   // new schools get ids far from the registry's own
  }
  // Ask the server whether the typed details are a sales agent. Resolves { ok:true } and loads the agent's data, or { ok:false, status, error }.
  A.login=function(user,pass){
    A.token=null;
    return call('POST','/agent/login',{ username:user, password:pass }).then(function(r){
      if(r.status===200&&typeof r.data.token==='string'&&r.data.agent){ A.token=r.data.token; apply(r.data); return { ok:true }; }
      return { ok:false, status:r.status, error:typeof r.data.error==='string'?r.data.error:'' };
    },function(){ return { ok:false, status:0, error:'' }; });
  };
  // the agent chose a new password (kept on the server until it reaches the System Developer's roster)
  A.savePassword=function(pw){ if(!A.active||!A.token) return Promise.resolve(); return call('POST','/agent/password',{ newPassword:pw }).catch(function(){}); };
  // the agent registered or edited one of their schools
  A.pushSchool=function(rec,isNew){
    if(!A.active||!A.token||!rec) return Promise.resolve();
    var body={ record:JSON.parse(JSON.stringify(rec)) };
    if(!isNew&&A.ids[rec.id]) body.schoolId=rec.id; else body.clientId=rec.id;
    return call('POST','/agent/schools',body).then(function(r){
      if(r.status===401){ try{ alert('Your session has ended. Sign in again; this change was not sent.'); }catch(e){} }
      else if(!r.ok){ try{ alert(r.data.error||'The change could not be sent to the server. Try again.'); }catch(e){} }
    },function(){ try{ alert('No internet connection. This change was not sent; try again when online.'); }catch(e){} });
  };
  // Logging out of an agent session reloads the page, so nothing of it stays in memory for the next person (and saving to the phone switches back on).
  var lo=window.logout;
  if(typeof lo==='function'&&!lo.__agent){ var w=function(){ var was=A.active; var r=lo.apply(this,arguments); if(was){ setTimeout(function(){ location.reload(); },50); } return r; }; w.__agent=true; window.logout=w; }
})();
