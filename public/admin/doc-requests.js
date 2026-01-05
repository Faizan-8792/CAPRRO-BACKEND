(() => {
  'use strict';
  const API_BASE = '/api';
  const token = localStorage.getItem('caproadminjwt');

  async function loadRequests(){
    const el = document.getElementById('requestsList');
    if (!el) return;
    el.innerHTML = 'Loading…';
    try{
      const res = await fetch(API_BASE + '/document-requests', { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if(!data.ok) throw new Error(data.error||'Failed');
      const rows = data.data || [];
      if(!rows.length) { el.innerHTML = '<div class="muted">No requests</div>'; return; }
      el.innerHTML = rows.map(r => {
        const items = (r.items||[]).map(i=>`<span class="chip">${i.label||i.key}:${i.status}</span>`).join(' ');
        return `<div style="padding:10px;border-bottom:1px solid rgba(255,255,255,0.03)"><strong>${r.clientName||r.clientId}</strong> <div class="muted small">${new Date(r.createdAt).toLocaleString()}</div><div class="dr-items">${items}</div><div style="margin-top:6px">Status: <em>${r.status}</em></div></div>`
      }).join('');
    }catch(e){ el.innerHTML = '<div class="error">'+(e.message||e)+'</div>' }
  }

  function initDocRequestsPage(){
    const btn = document.getElementById('createReqBtn');
    if (btn) {
      btn.addEventListener('click', async()=>{
        const cid = document.getElementById('clientId').value.trim();
        const due = document.getElementById('dueDate').value;
        const itemsRaw = document.getElementById('items').value.trim();
        const statusEl = document.getElementById('createStatus');
        if(!cid || !itemsRaw) { if (statusEl) { statusEl.textContent = 'Client and items required'; statusEl.className='small-label err'; } return; }
        const items = itemsRaw.split(',').map(s=>({ key: s.trim().replace(/\s+/g,'_').toUpperCase(), label: s.trim() }));
        try{
          if (statusEl) statusEl.textContent = 'Creating...';
          const res = await fetch(API_BASE + '/document-requests', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ clientId: cid, clientName: cid, items, dueDateISO: due? new Date(due+'T00:00:00').toISOString():undefined }) });
          const data = await res.json();
          if(!data.ok) throw new Error(data.error||'Failed');
          if (statusEl) { statusEl.textContent = 'Created'; statusEl.className='small-label ok'; }
          document.getElementById('clientId').value=''; document.getElementById('items').value=''; document.getElementById('dueDate').value='';
          loadRequests();
        }catch(e){ if (statusEl) { statusEl.textContent = e.message || e; statusEl.className='small-label err'; } }
      });
    }

    loadRequests();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDocRequestsPage); else initDocRequestsPage();
})();
