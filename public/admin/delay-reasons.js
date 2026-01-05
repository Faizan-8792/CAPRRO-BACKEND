(() => {
  'use strict';
  const API='/api';
  const token=localStorage.getItem('caproadminjwt');
  const taskLabelById = new Map();

  function reasonLabel(code){
    return {
      CLIENT_DELAY: 'Client delay',
      DOCUMENTS_PENDING: 'Documents pending',
      STAFF_WORKLOAD: 'Staff workload',
      TECHNICAL: 'Technical',
    }[code] || code || 'Unknown';
  }

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

      // Build lookup for pretty display in recent logs
      taskLabelById.clear();
      allTasks.forEach(t => {
        const id = t.id || t._id;
        if (!id) return;
        taskLabelById.set(String(id), `${t.clientName || 'Unknown'} • ${t.title || 'Untitled'}`);
      });

      // Keep placeholder option and populate with actual tasks
      sel.innerHTML = '<option value="">-- Select a task --</option>' +
        allTasks.map(t => {
          const id = t.id || t._id; // board API returns `id`
          return `<option value="${id}">${t.clientName || 'Unknown'} • ${t.title}</option>`;
        }).join('');
    }catch(e){ console.error('loadTasks error', e); }
  }

  function isValidObjectIdString(s){
    return typeof s === 'string' && /^[a-f\d]{24}$/i.test(s.trim());
  }

  async function loadAgg(){
    try{
      const res = await fetch(API + '/delay-logs/aggregate', { headers: { Authorization: 'Bearer '+token } });
      const d = await res.json();
      if(!d.ok) return; // leave agg element as-is
      const aggEl = document.getElementById('agg');
      if (!aggEl) return;

      const aggHtml = (d.aggregate||[])
        .map(x=>`<div><strong>${reasonLabel(x._id)}</strong>: ${x.count}</div>`)
        .join('');

      const seen = new Set();
      const recentHtml = (d.recent||[])
        .filter(r => {
          const k = String(r._id || `${r.taskId}-${r.reason}-${r.createdAt}`);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map(r => {
          const label = taskLabelById.get(String(r.taskId)) || `Task: ${String(r.taskId).slice(0,8)}…`;
          const when = new Date(r.createdAt).toLocaleString();
          return `<div class="muted small"><strong>${label}</strong> • ${reasonLabel(r.reason)} • ${when}</div>`;
        })
        .join('');

      aggEl.innerHTML = aggHtml + '<hr/>' + recentHtml;
    }catch(e){ console.error('loadAgg', e); const aggEl = document.getElementById('agg'); if (aggEl) aggEl.innerText='Failed'; }
  }

  function initDelayReasons(){
    // Add a small delay to ensure DOM is fully settled after injection
    setTimeout(() => {
      const addBtn = document.getElementById('addBtn');
      if (addBtn) {
        addBtn.addEventListener('click', async()=>{
          const taskEl = document.getElementById('taskId');
          const reasonEl = document.getElementById('reason');
          const noteEl = document.getElementById('note');
          const id = (taskEl && taskEl.value ? String(taskEl.value) : '').trim();
          const reason = reasonEl ? reasonEl.value : '';
          const note = noteEl ? noteEl.value : '';

          const st=document.getElementById('addStatus');
          if(!id || !reason){
            if (st) { st.textContent='Please select a task and reason'; st.className='small-label err'; }
            return;
          }

          if (!isValidObjectIdString(id)) {
            if (st) { st.textContent = `Invalid taskId selected: ${id}`; st.className='small-label err'; }
            return;
          }
          if (st) { st.textContent='Adding...'; }
          try{
            const res = await fetch(API + '/delay-logs', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer '+token }, body: JSON.stringify({ taskId:id, reason, note }) });
            const d = await res.json().catch(()=>null);
            console.log('[DelayLog] Response:', { status: res.status, data: d });
            if (!res.ok) {
              // Show detailed validation errors when available
              let msg = (d && (d.error || (d.details && JSON.stringify(d.details)))) || `Request failed (${res.status})`;
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
