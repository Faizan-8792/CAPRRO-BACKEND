// assistant.js (Admin Compliance Assistant)
import { computePriority } from './priority-engine.js';

const API_BASE = "https://caprro-backend-1.onrender.com/api";

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

async function api(path) {
  const token = localStorage.getItem('caproadminjwt');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('API failed');
  return res.json();
}

async function loadAdminComplianceAssistant() {
  const tbody = qs('caTaskTbody');
  const statusEl = qs('caStatus');
  if (!tbody) return;

  try {
    statusEl.textContent = 'Analyzing today’s compliance workload...';

    const resp = await api('/tasks/board');
    if (!resp || !resp.columns) {
      throw new Error('Invalid task board response');
    }
    const allTasks = Object.values(resp.columns || {}).flat();

    const enriched = allTasks.map(t => {
      const p = computePriority(t);
      return { ...t, priority: p.level, score: p.score };
    });

    const today = enriched.filter(t => t.score >= 30);

    qs('caOverdueCount').textContent =
      `Overdue: ${today.filter(t => t.score >= 90).length}`;
    qs('caTodayCount').textContent =
      `High: ${today.filter(t => t.priority === 'HIGH').length}`;
    qs('caUpcomingCount').textContent =
      `Medium: ${today.filter(t => t.priority === 'MEDIUM').length}`;

    if (!today.length) {
      tbody.innerHTML =
        `<tr><td colspan="8" class="text-center text-muted">No critical work today 🎉</td></tr>`;
      statusEl.textContent = '';
      return;
    }

    tbody.innerHTML = today
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(t => `
        <tr>
          <td>${escapeHtml(t.clientName)}</td>
          <td>${escapeHtml(t.serviceType)}</td>
          <td>${new Date(t.dueDateISO).toLocaleDateString('en-IN')}</td>
          <td>${escapeHtml(t.assignedTo?.email || 'Unassigned')}</td>

          <td>
            <span class="badge bg-${t.priority === 'CRITICAL' ? 'danger' :
                                   t.priority === 'HIGH' ? 'warning' :
                                   'secondary'}">
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
            <span class="badge bg-${t.score >= 60 ? 'warning' : 'secondary'}">
              ${t.score >= 60 ? 'CHASE' : 'OK'}
            </span>
          </td>
        </tr>
      `)
      .join('');

    statusEl.textContent = `Showing top ${today.length} priority tasks`;

  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Failed to load compliance assistant';
  }
}

window.loadAdminComplianceAssistant = loadAdminComplianceAssistant;