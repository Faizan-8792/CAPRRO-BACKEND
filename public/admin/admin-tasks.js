// admin-tasks.js
// Task board helpers for CA PRO Firm Admin (Add Task UI + Assign dropdown + Compact cards + Expand/Collapse + Delete)
const TASK_API_BASE ="https://caprro-backend-1.onrender.com/api";
const TASK_TOKEN_KEY = 'caproadminjwt';

function getAdminToken() {
  return localStorage.getItem(TASK_TOKEN_KEY);
}

function qs(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function apiTasks(path, opts) {
  const token = getAdminToken();
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    opts?.headers || {}
  );
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${TASK_API_BASE}${path}`, {
    method: opts?.method || 'GET',
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    const msg = data?.error || data?.message || 'Request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// -------------------- CACHE (users for assign/filter) --------------------
let __firmUsersCache = []; // [{id,email,name}]

// -------------------- BOARD RENDERING --------------------

function renderTaskColumn(title, key, items) {
  const list = items || [];
  const count = list.length;
  const colorMap = {
    NOT_STARTED: 'secondary',
    WAITING_DOCS: 'warning',
    IN_PROGRESS: 'info',
    FILED: 'success',
    CLOSED: 'dark',
  };
  const badgeColor = colorMap[key] || 'secondary';

  const cardsHtml = list
    .map((t) => {
      const due = t.dueDateISO ? new Date(t.dueDateISO).toLocaleDateString('en-IN') : '';
      const staff = t.assignedTo?.name || t.assignedTo?.email || 'Unassigned';

      return `
        <div class="task-card task-card-compact" data-task-id="${esc(t.id)}">
          <div class="task-summary">
            <div class="task-summary-left">
              <p class="task-summary-title">${esc(t.title)} — ${esc(t.clientName)}</p>
              <div class="task-summary-sub">
                ${esc(t.serviceType)} • Due ${esc(due)} • ${esc(staff)}
              </div>
            </div>

            <div class="task-actions">
              <button class="btn btn-outline-danger btn-sm task-delete-btn"
                      type="button"
                      data-task-id="${esc(t.id)}">Delete</button>
            </div>
          </div>

          <div class="task-details mt-2">
            <div class="task-meta">
              <div><strong>Client:</strong> ${esc(t.clientName)}</div>
              <div><strong>Service:</strong> ${esc(t.serviceType)}</div>
              <div><strong>Due:</strong> ${esc(due)}</div>
              <div><strong>Staff:</strong> ${esc(staff)}</div>
            </div>

            <div class="mt-2">
              <select class="form-select form-select-sm task-status-select" data-task-id="${esc(t.id)}">
                <option value="NOT_STARTED" ${t.status === 'NOT_STARTED' ? 'selected' : ''}>Not started</option>
                <option value="WAITING_DOCS" ${t.status === 'WAITING_DOCS' ? 'selected' : ''}>Waiting for docs</option>
                <option value="IN_PROGRESS" ${t.status === 'IN_PROGRESS' ? 'selected' : ''}>In progress</option>
                <option value="FILED" ${t.status === 'FILED' ? 'selected' : ''}>Filed</option>
                <option value="CLOSED" ${t.status === 'CLOSED' ? 'selected' : ''}>Closed</option>
              </select>
            </div>

            ${t.status === 'WAITING_DOCS' ? `
              <div class="mt-2">
                <select class="form-select form-select-sm task-delay-reason"
                        data-task-id="${esc(t.id)}">
                  <option value="">Select delay reason</option>
                  <option value="CLIENT" ${t.meta?.delayReason === 'CLIENT' ? 'selected' : ''}>Client not responding</option>
                  <option value="DOCS" ${t.meta?.delayReason === 'DOCS' ? 'selected' : ''}>Documents incomplete</option>
                  <option value="INTERNAL" ${t.meta?.delayReason === 'INTERNAL' ? 'selected' : ''}>Internal delay</option>
                  <option value="PORTAL" ${t.meta?.delayReason === 'PORTAL' ? 'selected' : ''}>Govt portal issue</option>
                </select>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="col-md-4 col-lg-2">
      <div class="task-column">
        <div class="task-column-header">
          <span>${esc(title)}</span>
          <span class="badge bg-${badgeColor}">${count}</span>
        </div>
        ${cardsHtml || `<div class="text-muted small">No tasks</div>`}
      </div>
    </div>
  `;
}

async function refreshTaskBoard() {
  const columnsEl = qs('taskBoardColumns');
  const statusEl = qs('taskBoardStatus');
  if (!columnsEl) return;

  try {
    if (statusEl) statusEl.textContent = 'Loading tasks...';

    const qsService = qs('taskFilterService');
    const qsStaff = qs('taskFilterStaff');
    const qsMonth = qs('taskFilterMonth');

    const params = new URLSearchParams();
    if (qsService?.value) params.set('serviceType', qsService.value);
    if (qsStaff?.value) params.set('assignedTo', qsStaff.value);
    if (qsMonth?.value) params.set('month', qsMonth.value);

    const query = params.toString() ? `?${params.toString()}` : '';
    const resp = await apiTasks(`/tasks/board${query}`);
    const { columns = {}, plan } = resp;

    const colHtml = [
      renderTaskColumn('Not started', 'NOT_STARTED', columns.NOT_STARTED),
      renderTaskColumn('Waiting for docs', 'WAITING_DOCS', columns.WAITING_DOCS),
      renderTaskColumn('In progress', 'IN_PROGRESS', columns.IN_PROGRESS),
      renderTaskColumn('Filed', 'FILED', columns.FILED),
      renderTaskColumn('Closed', 'CLOSED', columns.CLOSED),
    ].join('');

    columnsEl.innerHTML = colHtml;

    if (statusEl) {
      if (plan === 'FREE') {
        statusEl.textContent =
          'Free plan: Limited number of tasks. Upgrade to PREMIUM for filters and unlimited board.';
      } else {
        statusEl.textContent =
          'Premium plan: Filters active. Use service/staff/month to slice tasks.';
      }
    }

    attachStatusChangeHandlers();
    attachCardToggleHandlers();
    attachDeleteHandlers();
    attachDelayReasonHandlers();
  } catch (e) {
    console.error('refreshTaskBoard error:', e);
    if (statusEl) statusEl.textContent = e.message || 'Failed to load task board.';
  }
}

function attachStatusChangeHandlers() {
  const selects = document.querySelectorAll('.task-status-select');
  selects.forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const taskId = e.target.getAttribute('data-task-id');
      const newStatus = e.target.value;
      if (!taskId || !newStatus) return;
      try {
        await apiTasks(`/tasks/${taskId}`, {
          method: 'PUT',
          body: { status: newStatus },
        });
        await refreshTaskBoard();
      } catch (err) {
        console.error('Status update error:', err);
        alert(err.message || 'Failed to update task status');
      }
    });
  });
}

function attachCardToggleHandlers() {
  document.querySelectorAll('.task-card').forEach((card) => {
    card.classList.remove('task-card-expanded');

    card.addEventListener('click', (e) => {
      if (e.target.closest('.task-delete-btn')) return;
      if (e.target.closest('.task-status-select')) return;
      if (e.target.closest('.task-delay-reason')) return;
      card.classList.toggle('task-card-expanded');
    });
  });
}

function attachDeleteHandlers() {
  document.querySelectorAll('.task-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const taskId = btn.getAttribute('data-task-id');
      if (!taskId) return;

      const ok = confirm('Delete this task?');
      if (!ok) return;

      try {
        await apiTasks(`/tasks/${taskId}`, { method: 'DELETE' });
        await refreshTaskBoard();
      } catch (err) {
        console.error('Delete error:', err);
        alert(err.message || 'Failed to delete task');
      }
    });
  });
}

// -------------------- DELAY REASON HANDLER --------------------
function attachDelayReasonHandlers() {
  document.querySelectorAll('.task-delay-reason').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const taskId = sel.getAttribute('data-task-id');
      const delayReason = sel.value;
      if (!taskId) return;

      await apiTasks(`/tasks/${taskId}`, {
        method: 'PUT',
        body: { meta: { delayReason } }
      });
    });
  });
}

// -------------------- USERS: cache for filters + assign --------------------

async function loadFirmUsersCache() {
  const token = getAdminToken();
  if (!token) return;

  try {
    const meRes = await apiTasks('/auth/me');
    const firmId = meRes?.user?.firmId;
    if (!firmId) return;

    const usersRes = await apiTasks(`/firms/${firmId}/users`);
    const users = usersRes?.users || [];

    __firmUsersCache = users
      .map((u) => ({
        id: u._id || u.id,
        email: u.email,
        name: u.name || '',
      }))
      .filter((u) => u.id && u.email);
  } catch (e) {
    console.error('loadFirmUsersCache error:', e);
  }
}

function fillStaffFilterDropdown() {
  const sel = qs('taskFilterStaff');
  if (!sel) return;

  const current = sel.value || '';
  sel.innerHTML =
    `<option value="">All</option>` +
    __firmUsersCache.map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`).join('');
  sel.value = current;
}

function fillAssignDropdown() {
  const sel = qs('addTaskAssignTo');
  if (!sel) return;

  const current = sel.value || '';
  sel.innerHTML =
    '<option value="">Unassigned</option>' +
    __firmUsersCache
      .map(
        (u) =>
          `<option value="${esc(u.id)}">${esc(u.name || u.email)} (${esc(u.email)})</option>`
      )
      .join('');
  sel.value = current;
}

// -------------------- FILTERS --------------------

function initTaskFilters() {
  const applyBtn = qs('taskFilterApply');
  const clearBtn = qs('taskFilterClear');

  if (applyBtn) {
    applyBtn.addEventListener('click', () => refreshTaskBoard());
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const qsService = qs('taskFilterService');
      const qsStaff = qs('taskFilterStaff');
      const qsMonth = qs('taskFilterMonth');
      if (qsService) qsService.value = '';
      if (qsStaff) qsStaff.value = '';
      if (qsMonth) qsMonth.value = '';
      refreshTaskBoard();
    });
  }
}

// -------------------- ADD TASK (Admin UI) --------------------

async function createTaskFromAdminUI() {
  const statusEl = qs('addTaskStatus');

  const clientName = qs('addTaskClient')?.value?.trim();
  const serviceType = qs('addTaskService')?.value?.trim() || 'OTHER';
  const title = qs('addTaskTitle')?.value?.trim();
  const dueDate = qs('addTaskDue')?.value;
  const assignedTo = qs('addTaskAssignTo')?.value?.trim() || null;
  const status = qs('addTaskStatusSelect')?.value?.trim() || 'NOT_STARTED';

  if (!clientName || !title || !dueDate) {
    if (statusEl) statusEl.textContent = 'Client, Title, Due date required.';
    return;
  }

  const dueDateISO = new Date(dueDate + 'T00:00:00').toISOString();

  try {
    if (statusEl) statusEl.textContent = 'Creating task...';

    const body = { clientName, serviceType, title, dueDateISO, status };
    if (assignedTo) body.assignedTo = assignedTo;

    await apiTasks('/tasks', { method: 'POST', body });

    if (statusEl) statusEl.textContent = 'Task created!';
    setTimeout(() => {
      if (statusEl) statusEl.textContent = '';
    }, 1500);

    if (qs('addTaskClient')) qs('addTaskClient').value = '';
    if (qs('addTaskTitle')) qs('addTaskTitle').value = '';
    if (qs('addTaskDue')) qs('addTaskDue').value = '';
    if (qs('addTaskStatusSelect')) qs('addTaskStatusSelect').value = 'NOT_STARTED';
    if (qs('addTaskAssignTo')) qs('addTaskAssignTo').value = '';

    await refreshTaskBoard();
  } catch (e) {
    console.error('Create task error:', e);
    if (statusEl) statusEl.textContent = e.message || 'Failed to create task.';
  }
}

function initAddTaskUI() {
  const btn = qs('addTaskBtn');
  if (!btn) return;
  btn.addEventListener('click', createTaskFromAdminUI);
}

// -------------------- COMPLIANCE ASSISTANT UI --------------------

async function loadAdminComplianceAssistant() {
  try {
    const tbody = qs('caTaskTbody');
    const statusEl = qs('caStatus');
    
    if (!tbody) return;
    
    if (statusEl) statusEl.textContent = 'Loading compliance priorities...';
    
    // Fetch clients to chase data
    const resp = await apiTasks('/stats/clients-to-chase-today');
    const { pendingDocsClients = [] } = resp;
    
    if (pendingDocsClients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No pending tasks requiring attention.</td></tr>';
      if (statusEl) statusEl.textContent = 'All caught up!';
      return;
    }
    
    // Render table rows with new columns and action buttons
    tbody.innerHTML = pendingDocsClients.map((task, index) => {
      const dueDate = task.dueDateISO ? new Date(task.dueDateISO).toLocaleDateString('en-IN') : '';
      const priorityBadge = task.suggestedAction === 'ESCALATE' 
        ? '<span class="badge bg-danger">ESCALATE</span>' 
        : '<span class="badge bg-warning">CHASE</span>';
      
      return `
        <tr data-task-id="${esc(task.taskId)}">
          <td>${esc(task.clientName)}</td>
          <td>${esc(task.serviceType)}</td>
          <td>${esc(dueDate)}</td>
          <td>Unassigned</td>
          <td>${priorityBadge}</td>
          <td>${esc(task.delayReason || 'Not specified')}</td>
          <td>${esc(task.waitingDays)} days</td>
          <td>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-secondary btn-sm" data-action="copy" data-task-id="${esc(task.taskId)}">
                Copy
              </button>
              <button class="btn btn-outline-primary btn-sm" data-action="done" data-task-id="${esc(task.taskId)}">
                Done
              </button>
              <button class="btn btn-outline-danger btn-sm" data-action="escalate" data-task-id="${esc(task.taskId)}">
                Escalate
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    
    if (statusEl) statusEl.textContent = `Found ${pendingDocsClients.length} tasks requiring attention`;
    
    // Attach action button handlers
    attachComplianceAssistantActions();
    
  } catch (err) {
    console.error('loadAdminComplianceAssistant error:', err);
    const tbody = qs('caTaskTbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Error loading data: ${err.message}</td></tr>`;
    }
  }
}

function attachComplianceAssistantActions() {
  // Copy button - reuse existing clipboard logic
  document.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      const row = btn.closest('tr');
      const clientName = row.cells[0].textContent;
      const serviceType = row.cells[1].textContent;
      const dueDate = row.cells[2].textContent;
      
      const text = `Client: ${clientName}\nService: ${serviceType}\nDue: ${dueDate}\nTask ID: ${taskId}`;
      
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-success');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('btn-success');
          btn.classList.add('btn-outline-secondary');
        }, 1500);
      } catch (err) {
        console.error('Copy failed:', err);
        alert('Failed to copy to clipboard');
      }
    });
  });
  
  // Done button - call followup endpoint
  document.querySelectorAll('[data-action="done"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      
      try {
        btn.disabled = true;
        btn.textContent = 'Processing...';
        
        await apiTasks(`/tasks/${taskId}/followup`, {
          method: 'POST',
        });
        
        btn.textContent = 'Done ✓';
        btn.classList.remove('btn-outline-primary');
        btn.classList.add('btn-success');
        
        // Optionally refresh the list after a delay
        setTimeout(() => {
          loadAdminComplianceAssistant();
        }, 1000);
        
      } catch (err) {
        console.error('Followup action failed:', err);
        alert(err.message || 'Failed to mark as done');
        btn.disabled = false;
        btn.textContent = 'Done';
      }
    });
  });
  
  // Escalate button - call escalate endpoint
  document.querySelectorAll('[data-action="escalate"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      
      if (!confirm('Escalate this task to partner/manager?')) return;
      
      try {
        btn.disabled = true;
        btn.textContent = 'Escalating...';
        
        await apiTasks(`/tasks/${taskId}/escalate`, {
          method: 'POST',
        });
        
        btn.textContent = 'Escalated ✓';
        btn.classList.remove('btn-outline-danger');
        btn.classList.add('btn-dark');
        
        // Update the row to show it's escalated
        const row = btn.closest('tr');
        const delayReasonCell = row.cells[5];
        delayReasonCell.innerHTML = '<span class="badge bg-danger">ESCALATED</span>';
        
      } catch (err) {
        console.error('Escalate action failed:', err);
        alert(err.message || 'Failed to escalate task');
        btn.disabled = false;
        btn.textContent = 'Escalate';
      }
    });
  });
}

// -------------------- INIT --------------------

async function initTaskBoard() {
  await loadFirmUsersCache();
  fillStaffFilterDropdown();
  fillAssignDropdown();
  initTaskFilters();
  initAddTaskUI();
  await refreshTaskBoard();
}

window.initTaskBoard = initTaskBoard;
window.refreshTaskBoard = refreshTaskBoard;
window.loadAdminComplianceAssistant = loadAdminComplianceAssistant;