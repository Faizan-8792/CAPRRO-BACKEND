(() => {
  'use strict';
  const API = '/api';
  const token = localStorage.getItem('caproadminjwt');

  async function loadBoard(){
    try{
      const resp = await fetch(API + '/tasks/board', { headers: { Authorization: 'Bearer '+token } });
      const data = await resp.json();
      if(!data.ok) { const el = document.getElementById('dueToday'); if (el) el.innerText='Failed to load'; return; }
      const cols = data.columns || {};
      const all = [].concat(cols.NOT_STARTED||[], cols.WAITING_DOCS||[], cols.IN_PROGRESS||[], cols.FILED||[], cols.CLOSED||[]);

      const today = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today.getTime()+24*3600*1000);

      const dueToday = all.filter(t=>{
        try{ const d=new Date(t.dueDateISO); return d>=today && d<tomorrow; }catch(e){return false}
      });

      const overdue = all.filter(t=>{ try{ return new Date(t.dueDateISO) < new Date(); }catch(e){return false} });

      const since = new Date(Date.now() - 24*3600*1000);
      const newly = all.filter(t=> new Date(t.createdAt || Date.now()) >= since);

      const dueEl = document.getElementById('dueToday'); if (dueEl) dueEl.innerHTML = renderList(dueToday);
      const overdueEl = document.getElementById('overdue'); if (overdueEl) overdueEl.innerHTML = renderList(overdue);
      const newAssignedEl = document.getElementById('newAssigned'); if (newAssignedEl) newAssignedEl.innerHTML = renderList(newly);
    }catch(e){ console.error('loadBoard', e); }
  }

  function renderList(items){
    if(!items || !items.length) return '<div class="muted">No items</div>';
    return items.slice(0,20).map(t=>`<div style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.03)"><a href="/admin/admin.html#tasks" target="_blank">${t.title}</a> <div class="muted small">${t.clientName||''} • Due: ${t.dueDateISO? new Date(t.dueDateISO).toLocaleDateString(): '-'}</div></div>`).join('');
  }

  async function loadPendingDocs(){
    try{
      const res = await fetch(API + '/document-requests/pending-summary', { headers: { Authorization: 'Bearer '+token } });
      const d = await res.json();
      if(!d.ok) { const el = document.getElementById('pendingDocs'); if (el) el.innerText='Failed'; return; }
      const counts = d.counts || {};
      const html = Object.keys(counts).map(k=>`<div><strong>${k}</strong>: ${counts[k]}</div>`).join('');
      const pendingEl = document.getElementById('pendingDocs'); if (pendingEl) pendingEl.innerHTML = html + '<hr/>' + ((d.recent||[]).map(r=>`<div class="muted">${r.clientName||r.clientId} • ${new Date(r.createdAt).toLocaleString()}</div>`).join(''));
    }catch(e){ console.error('loadPendingDocs', e); }
  }

  function initTodayControl(){
    (async function(){ try{ await loadBoard(); await loadPendingDocs(); }catch(e){ console.error(e); } })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTodayControl); else initTodayControl();
})();
