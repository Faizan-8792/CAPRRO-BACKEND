(() => {
  'use strict';
  const API='/api';
  const token=localStorage.getItem('caproadminjwt');

  async function loadTasks(){
    try{
      const res = await fetch(API + '/tasks/board', { headers: { Authorization: 'Bearer '+token } });
      const d = await res.json();
      if(!d.ok) { console.error('loadTasks failed:', d); return; }
      const cols = d.columns || {};
      const allTasks = [].concat(cols.NOT_STARTED||[], cols.WAITING_DOCS||[], cols.IN_PROGRESS||[], cols.FILED||[], cols.CLOSED||[]);
      const sel = document.getElementById('taskId');
      if (!sel) { 
        console.warn('taskId element not found in DOM'); 
        return; 
      }
      console.log('Populating taskId dropdown with', allTasks.length, 'tasks');
      // Keep placeholder option and populate with actual tasks
      sel.innerHTML = '<option value="">-- Select a task --</option>' +
        allTasks.map(t => `<option value="${t._id}">${t.clientName || 'Unknown'} • ${t.title}</option>`).join('');
    }catch(e){ console.error('loadTasks error', e); }
  }

  async function loadAgg(){
    try{
      const res = await fetch(API + '/delay-logs/aggregate', { headers: { Authorization: 'Bearer '+token } });
      const d = await res.json();
      if(!d.ok) return; // leave agg element as-is
      const aggEl = document.getElementById('agg');
      if (!aggEl) return;
      aggEl.innerHTML = (d.aggregate||[]).map(x=>`<div><strong>${x._id}</strong>: ${x.count}</div>`).join('') + '<hr/>' + (d.recent||[]).map(r=>`<div class="muted small">${r.taskId} • ${r.reason} • ${new Date(r.createdAt).toLocaleString()}</div>`).join('');
    }catch(e){ console.error('loadAgg', e); const aggEl = document.getElementById('agg'); if (aggEl) aggEl.innerText='Failed'; }
  }

  function initDelayReasons(){
    // Add a small delay to ensure DOM is fully settled after injection
    setTimeout(() => {
      const addBtn = document.getElementById('addBtn');
      if (addBtn) {
        addBtn.addEventListener('click', async()=>{
          const id=document.getElementById('taskId').value.trim(); const reason=document.getElementById('reason').value; const note=document.getElementById('note').value;
          const st=document.getElementById('addStatus'); if(!id || !reason){ if (st) { st.textContent='Please select a task and reason'; st.className='small-label err'; } return; }
          if (st) { st.textContent='Adding...'; }
          try{
            const res = await fetch(API + '/delay-logs', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer '+token }, body: JSON.stringify({ taskId:id, reason, note }) });
            const d = await res.json().catch(()=>null);
            if (!res.ok) {
              // Show detailed validation errors when available
              const msg = (d && (d.error || (d.details && JSON.stringify(d.details)))) || `Request failed (${res.status})`;
              throw new Error(msg);
            }
            if (d && d.ok === false) {
              const details = d.details ? `: ${JSON.stringify(d.details)}` : '';
              throw new Error((d.error || 'Validation failed') + details);
            }
            if (st) { st.textContent='Added'; st.className='small-label ok'; }
            document.getElementById('taskId').value=''; document.getElementById('note').value='';
            loadAgg();
          } catch(e) {
            console.error('Add delay log failed:', e);
            if (st) { st.textContent = e.message || String(e); st.className='small-label err'; }
          }
        });
      }
      loadTasks();
      loadAgg();
    }, 100);
  }

  window.initDelayReasons = initDelayReasons;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDelayReasons); else initDelayReasons();
})();
