(() => {
  'use strict';
  const API='/api';
  const token=localStorage.getItem('caproadminjwt');

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
    const addBtn = document.getElementById('addBtn');
    if (addBtn) {
      addBtn.addEventListener('click', async()=>{
        const id=document.getElementById('taskId').value.trim(); const reason=document.getElementById('reason').value; const note=document.getElementById('note').value;
        const st=document.getElementById('addStatus'); if(!id || !reason){ if (st) { st.textContent='TaskId and reason required'; st.className='small-label err'; } return; }
        if (st) { st.textContent='Adding...'; }
        try{
          const res=await fetch(API + '/delay-logs', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer '+token }, body: JSON.stringify({ taskId:id, reason, note }) });
          const d=await res.json(); if(!d.ok) throw new Error(d.error||'Failed');
          if (st) { st.textContent='Added'; st.className='small-label ok'; }
          document.getElementById('taskId').value=''; document.getElementById('note').value='';
          loadAgg();
        }catch(e){ if (st) { st.textContent=e.message || e; st.className='small-label err'; } }
      });
    }
    loadAgg();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDelayReasons); else initDelayReasons();
})();
