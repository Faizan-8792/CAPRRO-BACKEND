// admin-tasks.js
// Task board helpers for CA PRO Firm Admin (Add Task UI + Assign dropdown + Compact cards + Expand/Collapse + Delete)
// Same-origin base -- see public/admin/super.js for why this must never be absolute.
const TASK_API_BASE = "/api";
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
    const msg = data?.error || data?.message || 'The request could not be completed. Try again.';
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
  // The column's count in the tone of its state (the library's badge, DS24).
  const toneMap = {
    NOT_STARTED: '',
    WAITING_DOCS: 'warning',
    IN_PROGRESS: 'accent',
    FILED: 'success',
    CLOSED: 'info',
  };
  const tone = toneMap[key] || '';

  const cardsHtml = list
    .map((t) => {
      const due = t.dueDateISO ? formatDueDay(t.dueDateISO) : '';
      const staff = t.assignedTo?.name || t.assignedTo?.email || 'Unassigned';

      return `
        <div class="task-card task-card-compact" data-task-id="${esc(t.id)}">
          <div class="task-summary" role="button" tabindex="0" aria-expanded="false">
            <div class="task-summary-left">
              <p class="task-summary-title">${esc(t.title)} — ${esc(t.clientName)}</p>
              <div class="task-summary-sub">
                ${esc(t.serviceType)} • Due ${esc(due)} • ${esc(staff)}
              </div>
            </div>
          </div>

          <div class="task-details">
            <div class="task-meta">
              <div><strong>Client:</strong> ${esc(t.clientName)}</div>
              <div><strong>Service:</strong> ${esc(t.serviceType)}</div>
              <div><strong>Due:</strong> ${esc(due)}</div>
              <div><strong>Staff:</strong> ${esc(staff)}</div>
            </div>

            <div class="mt-2">
              <select class="form-select form-select-sm task-status-select" data-task-id="${esc(t.id)}" aria-label="Status of ${esc(t.title)}">
                <option value="NOT_STARTED" ${t.status === 'NOT_STARTED' ? 'selected' : ''}>Not started</option>
                <option value="WAITING_DOCS" ${t.status === 'WAITING_DOCS' ? 'selected' : ''}>Waiting for docs</option>
                <option value="IN_PROGRESS" ${t.status === 'IN_PROGRESS' ? 'selected' : ''}>In progress</option>
                <option value="FILED" ${t.status === 'FILED' ? 'selected' : ''}>Filed</option>
                <option value="CLOSED" ${t.status === 'CLOSED' ? 'selected' : ''}>Closed</option>
              </select>
            </div>

            <div class="task-actions">
              <button class="btn btn-outline-danger btn-sm task-delete-btn"
                      type="button"
                      data-task-id="${esc(t.id)}">Delete task</button>
            </div>
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
          <span class="cp-badge"${tone ? ` data-tone="${tone}"` : ''}>${count}</span>
        </div>
        ${cardsHtml || `<div class="text-muted small">No tasks here.</div>`}
      </div>
    </div>
  `;
}

async function refreshTaskBoard() {
  const columnsEl = qs('taskBoardColumns');
  const statusEl = qs('taskBoardStatus');
  if (!columnsEl) return;

  try {
    taskStatus(statusEl, 'Loading tasks...', 'muted');

    const qsService = qs('taskFilterService');
    const qsStaff = qs('taskFilterStaff');
    const qsMonth = qs('taskFilterMonth');

    const params = new URLSearchParams();
    if (qsService?.value) params.set('serviceType', qsService.value);
    if (qsStaff?.value) params.set('assignedTo', qsStaff.value);
    if (qsMonth?.value) params.set('month', qsMonth.value);

    const query = params.toString() ? `?${params.toString()}` : '';
    const resp = await apiTasks(`/tasks/board${query}`);
    const { columns = {} } = resp;

    const colHtml = [
      renderTaskColumn('Not started', 'NOT_STARTED', columns.NOT_STARTED),
      renderTaskColumn('Waiting for docs', 'WAITING_DOCS', columns.WAITING_DOCS),
      renderTaskColumn('In progress', 'IN_PROGRESS', columns.IN_PROGRESS),
      renderTaskColumn('Filed', 'FILED', columns.FILED),
      renderTaskColumn('Closed', 'CLOSED', columns.CLOSED),
    ].join('');

    columnsEl.innerHTML = colHtml;

    taskStatus(statusEl, '', 'muted');

    attachStatusChangeHandlers();
    attachCardToggleHandlers();
    attachDeleteHandlers();
  } catch (e) {
    console.error('refreshTaskBoard error:', e);
    taskStatus(statusEl, e.message || 'The task board could not be loaded. Reload the page.', 'critical');
  }
}

// DS24: questions through the shared CA PRO dialog, outcomes as toasts (ui/capro-ui.js). Without
// the library a question answers no, so nothing is deleted unasked.
function taskAsk(options) {
  return window.CaproUI ? window.CaproUI.confirm(options) : Promise.resolve(false);
}

function taskToast(message, tone = 'success') {
  if (window.CaproUI) window.CaproUI.toast({ message, tone });
}

function taskStatus(el, text, tone = 'muted') {
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone;
}

function attachStatusChangeHandlers() {
  const selects = document.querySelectorAll('.task-status-select');
  selects.forEach((sel) => {
    // What the server holds, so a refused change does not leave the select showing a status
    // that was never saved.
    sel.dataset.saved = sel.value;
    sel.addEventListener('change', async (e) => {
      const taskId = e.target.getAttribute('data-task-id');
      const newStatus = e.target.value;
      if (!taskId || !newStatus) return;
      try {
        await apiTasks(`/tasks/${taskId}`, {
          method: 'PATCH',
          body: { status: newStatus },
        });
        await refreshTaskBoard();
      } catch (err) {
        console.error('Status update error:', err);
        e.target.value = e.target.dataset.saved || e.target.value;
        taskToast(err.message || 'The status could not be changed. Try again.', 'critical');
      }
    });
  });
}

// The card's summary opens and closes it - by mouse, or by Enter or Space from the keyboard; the
// summary says whether it is open. Clicks inside the opened part (the status, the delete) leave it be.
function attachCardToggleHandlers() {
  document.querySelectorAll('.task-card').forEach((card) => {
    card.classList.remove('task-card-expanded');
    const summary = card.querySelector('.task-summary');
    if (!summary) return;
    const toggle = () => {
      const open = card.classList.toggle('task-card-expanded');
      summary.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
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

      // The server archives the task (archiveTask: isActive false); nothing in this panel brings
      // it back, so the dialog says so.
      const title = btn.closest('.task-card')?.querySelector('.task-summary-title')?.textContent?.trim();
      const ok = await taskAsk({
        title: title ? `Delete the task "${title}"?` : 'Delete this task?',
        body: 'It leaves the task board for everyone in the firm, and cannot be brought back from this panel.',
        confirmLabel: 'Delete task',
        cancelLabel: 'Keep the task',
        tone: 'danger',
      });
      if (!ok) return;

      try {
        await apiTasks(`/tasks/${taskId}`, { method: 'DELETE' });
        taskToast(title ? `Deleted "${title}".` : 'Task deleted.');
        await refreshTaskBoard();
      } catch (err) {
        console.error('Delete error:', err);
        taskToast(err.message || 'The task could not be deleted. Try again.', 'critical');
      }
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
    taskStatus(statusEl, 'Enter the client name, the title and the due date.', 'critical');
    return;
  }

  // The picker's own YYYY-MM-DD: the server stores it as that day in UTC. Building local
  // midnight here sent the previous UTC day from any browser east of UTC (India included).
  const dueDateISO = dueDate;

  // One task per press: the button stays disabled until the server has answered, so a double
  // click cannot send the create twice.
  const addButton = qs('addTaskBtn');
  if (addButton?.disabled) return;
  if (addButton) addButton.disabled = true;

  try {
    taskStatus(statusEl, 'Creating the task...', 'muted');

    const body = { clientName, serviceType, title, dueDateISO, status };
    if (assignedTo) body.assignedTo = assignedTo;

    await apiTasks('/tasks', { method: 'POST', body });

    taskStatus(statusEl, '', 'muted');
    taskToast(`Task created for ${clientName}.`);

    if (qs('addTaskClient')) qs('addTaskClient').value = '';
    if (qs('addTaskTitle')) qs('addTaskTitle').value = '';
    if (qs('addTaskDue')) qs('addTaskDue').value = '';
    if (qs('addTaskStatusSelect')) qs('addTaskStatusSelect').value = 'NOT_STARTED';
    if (qs('addTaskAssignTo')) qs('addTaskAssignTo').value = '';

    await refreshTaskBoard();
  } catch (e) {
    console.error('Create task error:', e);
    taskStatus(statusEl, e.message || 'The task could not be created. Try again.', 'critical');
  } finally {
    if (addButton) addButton.disabled = false;
  }
}

function initAddTaskUI() {
  const btn = qs('addTaskBtn');
  if (!btn) return;
  btn.addEventListener('click', createTaskFromAdminUI);
}

// -------------------- INIT --------------------

// initTaskBoard runs on every visit to #tasks. The buttons are wired once: each visit used to add
// another click listener, so after three visits one click on Add task created three tasks (DS24).
let taskBoardWired = false;

async function initTaskBoard() {
  await loadFirmUsersCache();
  fillStaffFilterDropdown();
  fillAssignDropdown();
  if (!taskBoardWired) {
    initTaskFilters();
    initAddTaskUI();
    taskBoardWired = true;
  }
  await refreshTaskBoard();
}

window.initTaskBoard = initTaskBoard;
window.refreshTaskBoard = refreshTaskBoard;