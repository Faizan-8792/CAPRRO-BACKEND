// assistant.js (Admin Compliance Assistant) — DATE BASED
import { computePriority } from './priority-engine.js';

function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(path, opts) {
  // Prefer the shared admin.js api() wrapper so demo mode can intercept.
  if (typeof window.api === 'function') {
    return window.api(path, opts);
  }

  // Fallback (should be rare): local fetch.
  const token = localStorage.getItem('caproadminjwt');
  if (window.caproShowLoader) window.caproShowLoader('Loading assistant...');
  try {
    const API_BASE = "https://caprro-backend-1.onrender.com/api";
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('API failed');
    return res.json();
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }
}

async function loadAdminComplianceAssistant() {
  const tbody = qs('caTaskTbody');
  const statusEl = qs('caStatus');
  if (!tbody) return;

  try {
    statusEl.textContent = 'Analyzing today’s compliance workload...';

    const resp = await api('/tasks/board');
    const allTasks = Object.values(resp.columns || {}).flat();

    // ✅ DATE BASED PRIORITY
    const enriched = allTasks.map(t => {
      const p = computePriority(t);
      return { ...t, priority: p.level };
    });

    // ✅ SHOW ONLY RELEVANT TASKS
    const today = enriched.filter(t =>
      ['CRITICAL', 'HIGH', 'MEDIUM'].includes(t.priority)
    );

    // 🔢 Counters
    qs('caOverdueCount').textContent =
      `Critical: ${today.filter(t => t.priority === 'CRITICAL').length}`;
    qs('caTodayCount').textContent =
      `High: ${today.filter(t => t.priority === 'HIGH').length}`;
    qs('caUpcomingCount').textContent =
      `Medium: ${today.filter(t => t.priority === 'MEDIUM').length}`;

    if (!today.length) {
      tbody.innerHTML =
        `<tr><td colspan="8" class="text-center text-muted">No work to do today 🎉</td></tr>`;
      statusEl.textContent = '';
      return;
    }

    const priorityOrder = { CRITICAL: 1, HIGH: 2, MEDIUM: 3 };

    tbody.innerHTML = today
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
      .slice(0, 10)
      .map(t => `
        <tr>
          <td>${escapeHtml(t.clientName)}</td>
          <td>${escapeHtml(t.serviceType)}</td>
          <td>${new Date(t.dueDateISO).toLocaleDateString('en-IN')}</td>
          <td>${escapeHtml(t.assignedTo?.email || 'Unassigned')}</td>

          <td>
            <span class="badge bg-${
              t.priority === 'CRITICAL' ? 'danger' :
              t.priority === 'HIGH' ? 'warning' : 'secondary'
            }">
              ${t.priority}
            </span>
          </td>

          <td>${escapeHtml(t.meta?.delayReason || '-')}</td>

          <td>
            ${t.meta?.waitingSince
              ? Math.floor((Date.now() - new Date(t.meta.waitingSince)) / 86400000) + ' days'
              : '-'}
          </td>

          <td>
            <span class="badge bg-${
              t.priority === 'CRITICAL' ? 'danger' : 'secondary'
            }">
              ${t.priority === 'CRITICAL' ? 'CHASE' : 'OK'}
            </span>
          </td>
        </tr>
      `)
      .join('');

    statusEl.textContent = `Showing ${today.length} priority tasks`;

  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Failed to load compliance assistant';
  }
}

window.loadAdminComplianceAssistant = loadAdminComplianceAssistant;
