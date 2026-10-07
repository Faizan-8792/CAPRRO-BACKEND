// assistant.js (Admin Compliance Assistant)
import { computePriority } from './priority-engine.js';

// Same-origin base -- see public/admin/super.js for why this must never be absolute.
const API_BASE = "/api";

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

// A level in words; an unknown level is shown as the engine gave it.
const PRIORITY_LABELS = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

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

    // These count priority levels. The first was labelled "Overdue" while it counted every task
    // scoring 90 or more, which includes work due today (DS24).
    qs('caOverdueCount').textContent =
      `Critical: ${today.filter(t => t.priority === 'CRITICAL').length}`;
    qs('caTodayCount').textContent =
      `High: ${today.filter(t => t.priority === 'HIGH').length}`;
    qs('caUpcomingCount').textContent =
      `Medium: ${today.filter(t => t.priority === 'MEDIUM').length}`;

    if (!today.length) {
      tbody.innerHTML =
        `<tr><td colspan="5" class="text-center text-muted">Nothing needs attention today.</td></tr>`;
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
          <td>${escapeHtml(window.formatDueDay(t.dueDateISO))}</td>
          <td>${escapeHtml(t.assignedTo?.email || 'Unassigned')}</td>
          <td>
            <span class="cp-badge" data-tone="${t.priority === 'CRITICAL' ? 'critical' :
                                   t.priority === 'HIGH' ? 'warning' : ''}">
              ${escapeHtml(PRIORITY_LABELS[t.priority] || t.priority)}
            </span>
          </td>
        </tr>
      `)
      .join('');

    statusEl.textContent = today.length > 10 ? `Showing the 10 most urgent of ${today.length}.` : '';

  } catch (e) {
    console.error(e);
    statusEl.textContent = "Today's priorities could not be loaded. Reload the page.";
    statusEl.dataset.tone = 'critical';
  }
}

window.loadAdminComplianceAssistant = loadAdminComplianceAssistant;