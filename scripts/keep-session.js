/* MASMS keep-session: a reload/refresh (including the Android app) used to drop the user back on the
   login page because "logged in" only lived in memory. This remembers WHO is signed in and WHICH page
   they are on, and restores both once the on-device data has loaded. Two layers:
   - sessionStorage: survives a refresh of the tab/app window.
   - localStorage (with an idle limit, IDLE_HOURS): survives closing and reopening the Android app / installed
     web app, e.g. after switching to another app and Android unloading this one. After IDLE_HOURS with no use
     the person has to log in again.
   No password is stored. Logging out clears both. */
(function(){
  var KEY='masmsSession', LKEY='masmsSessionL', IDLE_HOURS=8, hideEl=null, armed=false, lastWritten='', lastAct=Date.now(), lastStamp=0, loggedOutElsewhere=false;
  function ls(){ try{ return window.localStorage; }catch(e){ return null; } }
  function ss(){ try{ return window.sessionStorage; }catch(e){ return null; } }
  function parse(raw){ try{ var o=JSON.parse(raw||'null'); return o&&o.name&&o.role?o:null; }catch(e){ return null; } }
  function read(){
    var s=ss(), o=s?parse(s.getItem(KEY)):null; if(o) return o;
    var l=ls(); o=l?parse(l.getItem(LKEY)):null;
    if(o && o.ts && (Date.now()-o.ts) < IDLE_HOURS*3600*1000) return o;
    if(o && l) try{ l.removeItem(LKEY); }catch(e){}   // too old: forget it
    return null;
  }
  function clear(){ lastWritten=''; lastStamp=0; var s=ss(), l=ls(); if(s) try{ s.removeItem(KEY); }catch(e){} if(l) try{ l.removeItem(LKEY); }catch(e){} }
  function save(){
    if(!armed) return;
    var s=ss(); if(!s) return;
    try{
      if(!isLoggedIn||pwChangePending) return;
      var str=JSON.stringify({
        name:currentUserName, role:currentUserRole, school:currentSchool, active:active,
        portal:!!isPortalSession, adm:currentPortalStudentAdm||null, agentId:currentAgentId||null
      });
      var changed=(str!==lastWritten);
      if(changed){ s.setItem(KEY,str); lastWritten=str; }
      // keep the on-device copy fresh (its time stamp is what the idle limit is measured from)
      var l=ls(), now=Date.now();
      if(l && !loggedOutElsewhere && currentUserRole!=='System Developer' && (changed || now-lastStamp>30000)){ var o=JSON.parse(str); o.ts=lastAct; l.setItem(LKEY,JSON.stringify(o)); lastStamp=now; }
    }catch(e){}
  }
  function unhide(){ if(hideEl&&hideEl.parentNode) hideEl.parentNode.removeChild(hideEl); hideEl=null; }

  function restore(){
    var o=read(); if(!o||isLoggedIn) return false;
    try{
      if(o.school&&o.school!==currentSchool&&schools.indexOf(o.school)>-1) switchToSchool(o.school);
      var page=o.active;
      if(o.portal){
        var st=portalEnabled&&students.find(function(s){ return s.admissionNumber===o.adm; });
        if(!st) return false;
        isLoggedIn=true; isPortalSession=true; currentPortalStudentAdm=o.adm;
        currentUserName=o.name; currentUserRole='Parent/Student';
        document.getElementById('appWrap').style.display='none';
        document.getElementById('portalAppRoot').style.display='';
        renderLoginPage(); renderPortalApp();
        return true;
      }
      var u;
      if(o.role==='System Developer'){
        u=systemUsers.find(function(x){ return x.role==='System Developer'; })||{name:'System Developer',role:'System Developer'};
      } else if(o.role==='Sales Agent'){
        var ag=(saAgents||[]).find(function(a){ return a.id===o.agentId&&a.status!=='Inactive'; });
        if(!ag) return false;
        u=saLoginUser(ag);
        if(userNeedsPasswordChange(u)) return false;
      } else {
        u=systemUsers.find(function(x){ return x.name===o.name&&x.role===o.role&&x.status!=='Disabled'&&x.status!=='Inactive'; });
        if(!u||userNeedsPasswordChange(u)) return false;
      }
      isLoggedIn=true; isPortalSession=false; currentPortalStudentAdm=null;
      currentUserName=u.name; currentUserRole=u.role;
      currentAgentId=u.role==='Sales Agent'?(u.agentId||o.agentId||null):null;
      loginError=''; pwChangePending=false;
      try{ if(page&&canAccessModule(page)) active=page; else if(u.role==='System Developer') active='sysdev'; }catch(e){}
      document.getElementById('portalAppRoot').style.display='none';
      document.getElementById('appWrap').style.display='';
      renderLoginPage(); render();
      return true;
    }catch(e){ console.warn('session restore',e); isLoggedIn=false; return false; }
  }

  // Hide the login form while a saved session is being restored so it does not flash on refresh.
  if(read()){
    hideEl=document.createElement('style'); hideEl.textContent='#loginPageRoot{visibility:hidden!important}';
    (document.head||document.documentElement).appendChild(hideEl);
    setTimeout(unhide,8000);   // safety: never leave the login page hidden
  }

  var wrapped=window.logout;
  if(typeof wrapped==='function') window.logout=function(){ armed=false; clear(); try{ return wrapped.apply(this,arguments); } finally{ armed=true; } };

  var _csl=window.completeStaffLogin; if(typeof _csl==='function') window.completeStaffLogin=function(){ loggedOutElsewhere=false; return _csl.apply(this,arguments); };
  function finish(){ try{ restore(); }catch(e){} unhide(); armed=true; save(); }
  var L=window.MASMS_LOCAL;
  if(L&&L.ready&&L.ready.then) L.ready.then(finish,finish);
  else if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ setTimeout(finish,0); });
  else setTimeout(finish,0);

  ['pointerdown','keydown','touchstart'].forEach(function(ev){ document.addEventListener(ev,function(){ lastAct=Date.now(); },{passive:true,capture:true}); });
  // Logged out in another tab/window: this one must not write the saved login back.
  window.addEventListener('storage',function(e){ if(e.key===LKEY && e.newValue===null) loggedOutElsewhere=true; });
  setInterval(save,1000);
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(); });
  window.addEventListener('pagehide',save);
  window.addEventListener('beforeunload',save);
  window.MASMS_SESSION={ restore:restore, save:save, clear:clear };
})();
