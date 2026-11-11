/* MASMS keep-session: a reload/refresh (including the Android app) used to drop the user back on the
   login page because "logged in" only lived in memory. This remembers WHO is signed in and WHICH page
   they are on for the lifetime of the tab/app window (sessionStorage), and restores both once the
   on-device data has loaded. No password is stored. Logging out clears it; closing the app clears it. */
(function(){
  var KEY='masmsSession', hideEl=null, armed=false, lastWritten='';
  function ss(){ try{ return window.sessionStorage; }catch(e){ return null; } }
  function read(){ var s=ss(); if(!s) return null; try{ var o=JSON.parse(s.getItem(KEY)||'null'); return o&&o.name&&o.role?o:null; }catch(e){ return null; } }
  function clear(){ lastWritten=''; var s=ss(); if(s) try{ s.removeItem(KEY); }catch(e){} }
  function save(){
    if(!armed) return;
    var s=ss(); if(!s) return;
    try{
      if(!isLoggedIn||pwChangePending) return;
      var str=JSON.stringify({
        name:currentUserName, role:currentUserRole, school:currentSchool, active:active,
        portal:!!isPortalSession, adm:currentPortalStudentAdm||null, agentId:currentAgentId||null
      });
      if(str===lastWritten) return;   // runs every second; only touch storage when something changed
      s.setItem(KEY,str); lastWritten=str;
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

  function finish(){ try{ restore(); }catch(e){} unhide(); armed=true; save(); }
  var L=window.MASMS_LOCAL;
  if(L&&L.ready&&L.ready.then) L.ready.then(finish,finish);
  else if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ setTimeout(finish,0); });
  else setTimeout(finish,0);

  setInterval(save,1000);
  document.addEventListener('visibilitychange',function(){ if(document.hidden) save(); });
  window.addEventListener('pagehide',save);
  window.addEventListener('beforeunload',save);
  window.MASMS_SESSION={ restore:restore, save:save, clear:clear };
})();
