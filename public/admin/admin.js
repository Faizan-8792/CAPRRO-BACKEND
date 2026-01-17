const API_BASE = "https://capro--saifullahfaizan.replit.app/api";
const TOKEN_KEY = 'caproadminjwt';
let __clientsChaseLoading = false;
let __lastHash = null; // NEW: prevents repeated hash handling
let currentFirm = null; // 🔥 MOVE THIS TO GLOBAL SCOPE (was inside initAdminPage)
let __demoMode = false;
let __demoData = null;

// AUTH HELPER FUNCTIONS
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// If the Chrome extension logs out, it can notify this page to force logout.
// This only works when this admin panel is opened from the extension and the
// content script bridge is available.
try {
    // Path A: if this page is running inside an extension context (rare)
    if (window.chrome?.runtime?.onMessage?.addListener) {
        window.chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.type === 'CAPRO_FORCE_LOGOUT') {
                try {
                    clearToken();
                    window.location.href = '/index.html?reason=extension-logout';
                } catch (e) {}
            }
        });
    }

    // Path B: normal hosted page — listen to bridge messages via window.postMessage
    window.addEventListener('message', (ev) => {
        const data = ev?.data;
        if (!data || data.source !== 'CAPRO_EXTENSION') return;
        const msg = data.payload;
        if (msg && msg.type === 'CAPRO_FORCE_LOGOUT') {
            try {
                clearToken();
                window.location.href = '/index.html?reason=extension-logout';
            } catch (e) {}
        }
    });
} catch (e) {
    // ignore if not running inside an extension-injected context
}

async function apiGetMe() {
  const token = getToken();
  if (!token) throw new Error("No token");
    if (window.caproShowLoader) window.caproShowLoader('Loading profile...');
    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) throw new Error("Unauthorized");
        return res.json();
    } finally {
        if (window.caproHideLoader) window.caproHideLoader();
    }
}

// AUTH GUARD FUNCTION
async function ensureAdminAuth() {
  try {
    const data = await apiGetMe();

    if (!data.ok) throw new Error("Invalid user");

    // ❌ Super admin should not stay on admin page
    if (data.user.role === "SUPER_ADMIN") {
      window.location.href = "/admin/super.html";
      return false;
    }

    // ✅ Only FIRM_ADMIN allowed
    if (data.user.role !== "FIRM_ADMIN") {
      clearToken();
      window.location.href = "/index.html";
      return false;
    }

    console.log("Admin authenticated:", data.user.email);
    return true;
  } catch (err) {
    console.error("Auth error:", err);
    clearToken();
    window.location.href = "/index.html";
    return false;
  }
}

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

function saveToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}

function ensureFirmAdmin(role) {
    // Only pure firm admins pass; super admin should not be treated as firm admin
    return role === 'FIRM_ADMIN';
}

function isSuperAdmin(user) {
    return user.role === 'SUPER_ADMIN' ||
           user.email === 'saifullahfaizan786@gmail.com';
}

async function api(path, opts) {
    // DEMO MODE (Pending approval): return frontend-only sample data.
    // Strict rules:
    // - Do not call backend for data reads we want to protect
    // - Never write anything (writes are already disabled in UI)
    if (__demoMode) {
        const method = (opts?.method || 'GET').toUpperCase();
        if (method !== 'GET') {
            const err = new Error('Demo Mode: write actions are disabled');
            err.status = 403;
            throw err;
        }

        const demo = __demoData || window.caproDemoData;
        // Always allow auth/me in demo mode so base UI can render identity.
        // NOTE: We don't override ensureAdminAuth()'s initial /auth/me call because
        // demo mode is only enabled after that call determines the user is pending.
        if (path === '/auth/me') {
            return {
                ok: true,
                user: {
                    name: 'Pending Admin',
                    email: 'pending.admin@example.com',
                    role: 'FIRM_ADMIN',
                    isActive: false,
                }
            };
        }
        // Known reads used across admin UI
        if (path === '/firms/me' || path.startsWith('/firms/')) {
            return { ok: true, firm: demo?.firm };
        }
        if (path.startsWith('/tasks/board')) {
            return demo?.taskBoard;
        }
        if (path === '/document-requests') {
            return demo?.documentRequests;
        }
        if (path === '/document-requests/pending-summary') {
            return demo?.pendingDocsSummary;
        }
        if (path === '/delay-logs/aggregate') {
            return demo?.delayLogsAggregate;
        }
        if (path === '/stats/clients-to-chase-today') {
            return demo?.clientsToChaseToday || { ok: true, pendingDocsClients: [], chronicLateClients: [] };
        }
        if (path.startsWith('/stats/clients-to-chase-today/')) {
            // “complete” etc. are writes in real life; in demo mode we keep it no-op.
            return { ok: true };
        }
        if (path === '/reminders/today') {
            return demo?.remindersToday || { ok: true, reminders: [] };
        }
        if (/^\/firms\/[^/]+\/users(\/.*)?$/.test(path)) {
            // Users page (list) and any future read endpoints.
            return demo?.users || { ok: true, users: [] };
        }
        if (path.startsWith('/stats/employee-productivity')) {
            return demo?.productivity || { ok: true, data: [] };
        }
        // Fallback: safe empty response
        return { ok: true };
    }

    const token = getToken();
    const headers = Object.assign({
        'Content-Type': 'application/json',
    }, opts?.headers);

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    // Show loader for API requests in admin UI
    if (window.caproShowLoader) window.caproShowLoader('Loading...');
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: opts?.method || 'GET',
            headers,
            body: opts?.body ? JSON.stringify(opts.body) : undefined,
        });

        let data = null;
        try {
            data = await res.json();
        } catch {
            // ignore
        }

        if (!res.ok) {
            const msg = data?.error || data?.message || 'Request failed';
            const err = new Error(msg);
            err.status = res.status;
            err.data = data;
            throw err;
        }

        return data;
    } finally {
        if (window.caproHideLoader) window.caproHideLoader();
    }
}

// Expose wrapper for other admin modules (e.g., compliance assistant).
window.api = api;

/**
 * UPDATED: includes 'analytics' and 'tasks' page + correct nav highlight
 */
function showPage(hash) {
    const pages = [
      'dashboard',
      'analytics', // ✅ ADD THIS
      'tasks',
      'assistant',
      'firm',
      'users',
      'join',
      'settings'
    ];
    
    for (const p of pages) {
        const el = qs(`page-${p}`);
        if (el) {
            el.style.display = (hash === `#${p}`) ? 'block' : 'none';
        }
    }

    // If an external page container was loaded, hide it when navigating to SPA sections
    const externalContainer = qs('externalPageContainer');
    if (externalContainer) externalContainer.style.display = 'none';

    // FIXED: Target sidebar links (.sidebar a), not <nav>
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.querySelectorAll('a').forEach(a => {
            const targetHash = a.getAttribute('href');
            a.classList.toggle('active', targetHash === hash);
        });
    }
}

// Load an external admin HTML page into the main content area without navigating away
async function loadAdminExternalPage(href, activatingLink) {
    const containerId = 'externalPageContainer';
    let container = qs(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        container.className = 'card p-3 mb-3';
        const main = document.querySelector('main.content');
        if (main) main.appendChild(container);
    }

    // Hide SPA sections
    document.querySelectorAll('main.content > section').forEach(s => s.style.display = 'none');
    container.style.display = 'block';
    container.innerHTML = '<div class="small-label">Loading page...</div>';

    try {
        const path = href.startsWith('/') ? href : `/admin/${href}`;
        const res = await fetch(path, { credentials: 'same-origin' });
        if (!res.ok) {
            container.innerHTML = `<div class="alert alert-danger">Failed to load page: ${res.status}</div>`;
            return;
        }
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        // Remove external stylesheet and style tags from fetched doc so we rely on admin shell CSS
        doc.querySelectorAll('link[rel="stylesheet"]').forEach(n => n.remove());
        doc.querySelectorAll('style').forEach(n => n.remove());

        // Prefer a fragment root (#page-root) if the page provides it, otherwise fall back to body
        const fragmentRoot = doc.getElementById('page-root') || doc.querySelector('.page-content');
        if (fragmentRoot) {
            container.innerHTML = fragmentRoot.innerHTML;
        } else {
            container.innerHTML = doc.body ? doc.body.innerHTML : text;
        }

        // Execute any scripts referenced in the loaded HTML
        // First, execute scripts that were part of the injected fragment (inside the container)
        const scripts = Array.from(container.querySelectorAll('script'));
        const executedSrc = new Set();
        const shouldReExecuteExternalScripts = /\b(doc-requests\.html|today-control\.html|delay-reasons\.html)\b/i.test(href);
        const loadPromises = [];
        for (const s of scripts) {
            if (s.src) {
                const src = s.getAttribute('src');
                const abs = src.startsWith('http') || src.startsWith('/') ? src : `/admin/${src}`;
                // Avoid adding the same src twice (but for external fragment pages we *do* want
                // the script to re-run when you revisit the page).
                if (!shouldReExecuteExternalScripts) {
                    if (document.querySelector(`script[src="${abs}"]`) || executedSrc.has(abs)) { s.remove(); continue; }
                }
                const newScript = document.createElement('script');
                newScript.src = abs;
                newScript.async = false;
                const p = new Promise((resolve) => {
                    newScript.onload = () => resolve({ src: abs, ok: true });
                    newScript.onerror = () => resolve({ src: abs, ok: false });
                });
                loadPromises.push(p);
                document.body.appendChild(newScript);
                executedSrc.add(abs);
            } else {
                // inline script: execute immediately
                const newScript = document.createElement('script');
                newScript.textContent = s.textContent;
                document.body.appendChild(newScript);
            }
            s.remove();
        }

        // As a fallback, if the page's HTML had script tags outside the fragment root
        // (some pages may put scripts after the fragment), also execute those.
        const docScripts = Array.from(doc.querySelectorAll('script'));
        for (const s of docScripts) {
            const src = s.getAttribute && s.getAttribute('src');
            if (src) {
                const abs = src.startsWith('http') || src.startsWith('/') ? src : `/admin/${src}`;
                if (document.querySelector(`script[src="${abs}"]`) || executedSrc.has(abs)) continue;
                const newScript = document.createElement('script');
                newScript.src = abs;
                newScript.async = false;
                const p = new Promise((resolve) => {
                    newScript.onload = () => resolve({ src: abs, ok: true });
                    newScript.onerror = () => resolve({ src: abs, ok: false });
                });
                loadPromises.push(p);
                document.body.appendChild(newScript);
                executedSrc.add(abs);
            } else if (s.textContent && s.textContent.trim()) {
                // inline scripts outside fragment
                const newScript = document.createElement('script');
                newScript.textContent = s.textContent;
                document.body.appendChild(newScript);
            }
        }

        // After all external scripts finish loading, try to call known init functions
        try {
            await Promise.all(loadPromises);
        } catch (e) {
            // ignore - we'll still attempt to call init functions
            console.warn('Some scripts failed to load', e);
        }

        // Attempt to call init function for the active external page.
        // IMPORTANT: on revisits, scripts may not re-run by themselves (because the browser
        // caches loaded JS and we de-dupe <script src=...>), so we always call init explicitly.
        const pageInitMap = {
            'doc-requests.html': 'initDocRequestsPage',
            'today-control.html': 'initTodayControl',
            'delay-reasons.html': 'initDelayReasons',
        };

        const normalized = String(href || '').split('?')[0].split('#')[0];
        const pageKey = normalized.split('/').pop();
        const initName = pageInitMap[pageKey];
        if (initName) {
            const fn = window[initName];
            if (typeof fn === 'function') {
                try {
                    fn();
                } catch (e) {
                    console.warn(`init ${initName} threw`, e);
                }
            } else {
                console.warn(`External page loaded but init function not found: ${initName}`);
            }
        }

        // Update active link styling
        if (activatingLink) {
            document.querySelectorAll('.sidebar a').forEach(a => a.classList.toggle('active', a === activatingLink));
        }

        window.scrollTo(0, 0);
    } catch (err) {
        console.error('loadAdminExternalPage error', err);
        container.innerHTML = `<div class="alert alert-danger">Error loading page</div>`;
    }
}

/**
 * UPDATED: tasks page par board init/refresh
 */
function onHashChange() {
    const h = window.location.hash.replace('#', '') || 'dashboard';
    const hash = `#${h}`;

    // NEW: if hash didn't actually change, do nothing
    if (hash === __lastHash) {
        return;
    }
    __lastHash = hash;

    showPage(hash);

    // Tasks page open hone par board init/refresh
    if (hash === '#tasks') {
        if (window.initTaskBoard) window.initTaskBoard();
        if (window.refreshTaskBoard) window.refreshTaskBoard();
    }

    // Assistant page open hone par load assistant
    if (hash === '#assistant') {
        if (window.loadAdminComplianceAssistant) {
            window.loadAdminComplianceAssistant();
        }
    }

    // Dashboard open hone par smart widgets
    if (hash === '#dashboard') {
        if (window.loadTodayReminders) loadTodayReminders();
        if (!__clientsChaseLoading) loadClientsToChaseToday();
    }

    // ✅ Analytics page open hone par chart load
    if (hash === '#analytics') {
        loadEmployeeProductivity();
    }
}

// ✅ Last day notifications UI
async function loadTodayReminders() {
    const listEl = qs('todayRemindersList');
    const statusEl = qs('todayRemindersStatus');
    if (!listEl) return;

    try {
        if (statusEl) statusEl.textContent = 'Loading last day notifications...';
        const resp = await api('/reminders/today');
        const reminders = resp?.reminders || [];

        if (!reminders.length) {
            listEl.innerHTML = "<li class='text-muted'>No reminders due tomorrow.</li>";
            if (statusEl) statusEl.textContent = '';
            return;
        }

        listEl.innerHTML = reminders
            .map(r => {
                const dt = new Date(r.dueDateISO);
                const when = dt.toLocaleDateString('en-IN');
                return `<li>${r.status} ${escapeHtml(r.clientLabel || r.typeId)} – due ${escapeHtml(when)}</li>`;
            })
            .join('');

        if (statusEl) statusEl.textContent = `${reminders.length} reminder(s) due tomorrow.`;
    } catch (e) {
        console.error('Today reminders load error:', e);
        if (statusEl) statusEl.textContent = e.message || 'Failed to load reminders.';
    }
}

// --- Clients to Chase Today ---
function buildReminderMessage(item, type) {
    const dueText = item.dueDateISO
        ? new Date(item.dueDateISO).toLocaleDateString("en-IN")
        : "upcoming due date";

    if (type === "pending") {
        return (
            `Hi ${item.clientName},\n\n` +
            `We are waiting for your ${item.serviceType || "compliance"} documents. ` +
            `Your documents have been pending for 3+ days.\n` +
            `Due: ${dueText}.\n\n` +
            `Please share the documents at the earliest.\n\n- CA PRO Toolkit`
        );
    }

    // high risk
    return (
        `Hi ${item.clientName},\n\n` +
        `In the last 2 periods, your ${item.serviceType || "compliance"} filings ` +
        `were submitted after the due date. To complete this on time, ` +
        `please share the documents a bit earlier.\n` +
        `Current due: ${dueText}.\n\n` +
        `Thanks.\n\n- CA PRO Toolkit`
    );
}

async function copyReminderToClipboard(item, type) {
    try {
        const msg = buildReminderMessage(item, type);
        await navigator.clipboard.writeText(msg);
        alert("Reminder text copied. Paste in WhatsApp / email.");
    } catch (e) {
        console.error("Clipboard copy failed", e);
        alert("Failed to copy text. Browser clipboard blocked?");
    }
}

async function markChaseComplete(type, taskId) {
    await api("/stats/clients-to-chase-today/complete", {
        method: "POST",
        body: { type, taskId },
    });
}

// ✅ FIXED: Global loading guard to prevent infinite loops
async function loadClientsToChaseToday() {
    // ✅ PREVENT MULTIPLE SIMULTANEOUS CALLS
    if (__clientsChaseLoading) {
        console.log('loadClientsToChaseToday: Already loading, skipping...');
        return;
    }
    
    __clientsChaseLoading = true;
    console.log('loadClientsToChaseToday: Starting load...');

    const pendingList = qs("chasePendingList");
    const riskList = qs("chaseRiskList");
    const pendingStatus = qs("chasePendingStatus");
    const riskStatus = qs("chaseRiskStatus");

    if (!pendingList || !riskList) {
        __clientsChaseLoading = false;
        return;
    }

    // Clear lists immediately
    pendingList.innerHTML = "";
    riskList.innerHTML = "";
    if (pendingStatus) pendingStatus.textContent = "Loading...";
    if (riskStatus) riskStatus.textContent = "Loading...";

    try {
        const data = await api("/stats/clients-to-chase-today");
        const pending = data?.pendingDocsClients || [];
        const risk = data?.chronicLateClients || [];

        // Pending docs clients - FULL AUTO-REFRESH
        if (!pending.length) {
            pendingList.innerHTML = '<li class="text-muted">No pending clients docs.</li>';
        } else {
            pendingList.innerHTML = pending
                .map((item, idx) => {
                    const label = escapeHtml(
                       `${idx + 1}. ${item.clientName} – ${item.serviceType || ""} · pending for ${item.daysPending} days`
                    );
                    return `
                        <li>
                            <span>${label}</span>
                            <div class="d-flex gap-1">
                                <button class="btn btn-sm btn-outline-primary ms-2 copy-btn"
                                        data-type="pending" data-index="${idx}">
                                    Copy
                                </button>
                                <button class="btn btn-sm btn-outline-success ms-1 done-btn"
                                        data-type="pending" data-taskid="${item.taskId}">
                                    Done
                                </button>
                            </div>
                        </li>`;
                })
                .join("");
        }

        // High-risk clients - ADD same auto-refresh
        if (!risk.length) {
            riskList.innerHTML = '<li class="text-muted">No habitual client pending.</li>';
        } else {
            riskList.innerHTML = risk
                .map((item, idx) => {
                    const label = escapeHtml(
                        `${idx + 1}. ${item.clientName} – ${item.serviceType || ""} · last delay ${item.lastPeriodDelayDays} days`
                    );
                    return `
                        <li>
                            <span>${label}</span>
                            <div class="d-flex gap-1">
                                <button class="btn btn-sm btn-outline-primary ms-2 copy-btn"
                                        data-type="risk" data-index="${idx}">
                                    Copy
                                </button>
                                <button class="btn btn-sm btn-outline-success ms-1 done-btn"
                                        data-type="risk" data-taskid="${item.taskId}">
                                    Done
                                </button>
                            </div>
                        </li>`;
                })
                .join("");
        }

        if (pendingStatus) pendingStatus.textContent = "";
        if (riskStatus) riskStatus.textContent = "";

        // ✅ FIXED: Proper event delegation with loading state
        pendingList.onclick = async (e) => {
            const doneBtn = e.target.closest('.done-btn');
            if (doneBtn) {
                const taskId = doneBtn.dataset.taskid;
                if (!taskId) return;

                try {
                    doneBtn.disabled = true;
                    const oldText = doneBtn.textContent;
                    doneBtn.textContent = "Done...";

                    await markChaseComplete('pending', taskId);
                    await loadClientsToChaseToday();  // ✅ Guard prevents infinite loop
                } catch (err) {
                    alert(err.message || "Failed to mark as done.");
                } finally {
                    doneBtn.disabled = false;
                    doneBtn.textContent = "Done";
                }
                return;
            }

            const copyBtn = e.target.closest('.copy-btn');
            if (copyBtn) {
                const idx = Number(copyBtn.dataset.index);
                const item = pending[idx];
                if (!item) return;
                copyReminderToClipboard(item, 'pending');
            }
        };

        riskList.onclick = async (e) => {
            const doneBtn = e.target.closest('.done-btn');
            if (doneBtn) {
                const taskId = doneBtn.dataset.taskid;
                if (!taskId) return;

                try {
                    doneBtn.disabled = true;
                    doneBtn.textContent = "Done...";

                    await markChaseComplete('risk', taskId);
                    await loadClientsToChaseToday();  // ✅ Guard prevents infinite loop
                } catch (err) {
                    alert(err.message || "Failed to mark as done.");
                } finally {
                    doneBtn.disabled = false;
                    doneBtn.textContent = "Done";
                }
                return;
            }

            const copyBtn = e.target.closest('.copy-btn');
            if (copyBtn) {
                const idx = Number(copyBtn.dataset.index);
                const item = risk[idx];
                if (!item) return;
                copyReminderToClipboard(item, 'risk');
            }
        };

        console.log('loadClientsToChaseToday: Load complete');
        
    } catch (err) {
        console.error("loadClientsToChaseToday error:", err);
        if (pendingStatus) pendingStatus.textContent = "Failed to load.";
        if (riskStatus) riskStatus.textContent = "Failed to load.";
    } finally {
        // ✅ ALWAYS RESET GUARD
        __clientsChaseLoading = false;
        console.log('loadClientsToChaseToday: Guard reset');
    }
}

// Function to attach delete button handlers for users
function attachUserDeleteHandlers() {
  document.querySelectorAll('.delete-user-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();

      const userId = btn.dataset.userid;
      if (!userId) return;

      if (!confirm('Delete this user permanently?')) return;

      try {
        btn.disabled = true;
        btn.textContent = 'Deleting...';

        // ✅ ADD DEBUG LOG
        console.log('Deleting user', {
          firmId: currentFirm?._id,
          userId
        });

        // ✅ FIXED API URL - Check firm context first
        if (!currentFirm?._id) {
          throw new Error('Firm context missing');
        }

        // ✅ CORRECT DELETE ENDPOINT
        await api(`/firms/${currentFirm._id}/users/${userId}`, {
          method: 'DELETE'
        });

        // 🔁 Reload users table
        btn.closest('tr')?.remove();

      } catch (err) {
        console.error('User delete failed:', err);
        alert(err.message || 'Failed to delete user');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
  });
}

// ---------- Firm Admin page (admin.html) ----------
async function initAdminPage() {
    if (!qs('logoutBtn')) return;

    // AUTH CHECK FIRST
    const isAuthenticated = await ensureAdminAuth();
    if (!isAuthenticated) return;

    const token = getToken();
    if (!token) {
        window.location.href = '/index.html';
        return;
    }

    function doLogout() {
        clearToken();
        window.location.href = '/index.html';
    }

    qs('logoutBtn')?.addEventListener('click', doLogout);
    
    // ✅ Navigation setup
    window.addEventListener('hashchange', onHashChange);
    
    // FIXED: Target sidebar links (.sidebar a)
    document.querySelectorAll('.sidebar a[href^="#"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const hash = link.getAttribute('href');
            window.location.hash = hash;
        });
    });

    // Intercept sidebar links that point to separate admin HTML pages and load them into the SPA
    document.querySelectorAll('.sidebar a[href$=".html"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            loadAdminExternalPage(href, link);
        });
    });

    // Initial page load
    onHashChange();

    // Load task board if tasks page or global script exists
    if (window.initTaskBoard || document.getElementById('taskBoardColumns')) {
        console.log('Task board detected, waiting for hashchange to init');
    }

    // ❌ REMOVED: let currentFirm = null; (now declared at top)

    async function loadAndRenderUsers() {
        if (!currentFirm || !currentFirm._id) return;
        
        const tbody = qs('usersTbody');
        if (!tbody) return;

        try {
            const usersResp = await api(`/firms/${currentFirm._id}/users`);
            const users = usersResp?.users || [];

            // Update KPI
            if (qs('kpiTotalUsers')) qs('kpiTotalUsers').textContent = String(users.length);
            const activeCount = users.filter(u => u.isActive !== false).length;
            if (qs('kpiActiveUsers')) qs('kpiActiveUsers').textContent = String(activeCount);

            // Render table with delete buttons
            if (!users.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No users</td></tr>';
            } else {
                tbody.innerHTML = users.map(u => `
                    <tr>
                        <td>${escapeHtml(u.name)}</td>
                        <td>${escapeHtml(u.email)}</td>
                        <td><span class="badge bg-${u.role === 'FIRM_ADMIN' ? 'warning' : 'secondary'}">${escapeHtml(u.role)}</span></td>
                        <td>${escapeHtml(u.accountType)}</td>
                        <td>${u.isActive !== false ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-warning">Inactive</span>'}</td>
                        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</td>
                        <td>
                            <button class="btn btn-sm btn-danger delete-user-btn" data-userid="${u._id}">
                                Delete
                            </button>
                        </td>
                    </tr>
                `).join('');
            }
            
            // ✅ ADD THIS LINE: Attach event handlers to delete buttons
            attachUserDeleteHandlers();
            
        } catch (e) {
            console.error('Users load error:', e);
            if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger">Failed to load users</td></tr>';
        }
    }

    try {
        const meResp = await api('/auth/me');
        const me = meResp.user;

        // Non-admin access denied
        if (!ensureFirmAdmin(me.role)) {
            // If this is Super Admin, always go to Super dashboard (no block)
            if (isSuperAdmin(me)) {
                window.location.href = '/admin/super.html';
                return;
            }

            // For other roles, show access denied
            document.body.innerHTML = `
              <div class="container" style="padding-top: 40px">
                <div class="card p-4 mx-auto" style="max-width: 500px">
                  <div class="text-center mb-4">
                    <h3>Access denied</h3>
                    <p class="text-muted">This email does not have Firm Admin access.</p>
                  </div>
                  <div class="text-center">
                    <a href="/index.html" class="btn btn-primary">Login</a>
                  </div>
                </div>
              </div>
            `;
            return;
        }

        // PENDING APPROVAL - View-only mode
        const pendingBanner = qs('pendingBanner');
        if (!me.isActive) {
            __demoMode = true;
            __demoData = window.caproDemoData || null;
            if (pendingBanner) {
                pendingBanner.style.display = 'block';
                pendingBanner.classList.remove('d-none');
            }

            const demoHint = qs('demoModeHint');
            if (demoHint) demoHint.style.display = 'block';

            // Replace banner text to make it clear this is demo data
            try {
                const msg = pendingBanner?.querySelector('strong');
                if (msg) msg.textContent = 'Demo Mode – Pending Approval';
                const p = pendingBanner?.querySelector('br')?.nextSibling;
                // (leave existing text if structure differs)
            } catch {}

            document.querySelectorAll('button[id$="Btn"]').forEach(btn => {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            });
        }

        // Populate user info
        if (qs('emailBadge')) qs('emailBadge').textContent = me.email;
        if (qs('roleBadge')) qs('roleBadge').textContent = me.isActive ? 'FIRM_ADMIN' : 'FIRM_ADMIN (Pending)';

    // Expose mode for external pages
    window.caproDemoMode = __demoMode;
    window.caproDemoData = window.caproDemoData || __demoData;

        // FIRM LOADING
        // In demo mode, never fetch real firm data.
        let firm = null;
        if (__demoMode) {
            firm = __demoData?.firm || { displayName: 'Demo Firm', handle: 'demo-firm', planType: 'FREE' };
            currentFirm = firm;
        } else {
            try {
                const myFirmResp = await api('/firms/me');
                if (myFirmResp?.ok && myFirmResp.firm && myFirmResp.firm._id) {
                    const firmId = myFirmResp.firm._id;
                    const firmResp = await api(`/firms/${firmId}`);
                    if (firmResp?.ok && firmResp.firm) {
                        firm = firmResp.firm;
                        currentFirm = firm; // ✅ THIS IS REQUIRED - Using global currentFirm
                    }
                }
            } catch (e) {
                console.error('Firm load error:', e);
            }
        }

        if (qs('topSub')) {
            qs('topSub').textContent = firm ? `Firm: ${firm.displayName} (@${firm.handle})` : 'No firm linked';
        }

        // Navbar plan badge (PREMIUM vs STANDARD)
        // Note: legacy values in codebase include FREE/PREMIUM; user asked for STANDARD/PREMIUM.
        try {
            const badge = qs('planBadge');
            if (badge) {
                const planRaw = String(firm?.planType || 'FREE').toUpperCase();
                const isPremium = planRaw === 'PREMIUM';
                // badge text is wrapped in a nested span for shimmer layering
                const label = badge.querySelector('span') || badge;
                label.textContent = isPremium ? 'PREMIUM' : 'STANDARD';
                badge.style.display = 'inline-flex';
                badge.classList.toggle('plan-badge--premium', isPremium);
                badge.classList.toggle('plan-badge--standard', !isPremium);
            }
        } catch (e) {
            // ignore UI-only badge failures
        }

        // ✅ DASHBOARD KPIs
        if (qs('kpiFirmName')) qs('kpiFirmName').textContent = firm?.displayName || 'Individual';
        if (qs('kpiFirmHandle')) qs('kpiFirmHandle').textContent = firm?.handle || '';
        if (qs('kpiPlanType')) qs('kpiPlanType').textContent = firm?.planType || 'FREE';
        const planExpiryText = firm?.planExpiry ? new Date(firm.planExpiry).toLocaleDateString() : 'NA';
        if (qs('kpiPlanExpiry')) qs('kpiPlanExpiry').textContent = `Expires ${planExpiryText}`;

        // Form fields
        if (qs('settingsPlanType')) qs('settingsPlanType').value = firm?.planType || 'FREE';
        if (qs('settingsPlanExpiry')) qs('settingsPlanExpiry').value = planExpiryText;
        if (qs('firmDisplayName')) qs('firmDisplayName').value = firm?.displayName || '';
        if (qs('firmHandle')) qs('firmHandle').value = firm?.handle || '';
        if (qs('firmDescription')) qs('firmDescription').value = firm?.description || '';
        if (qs('firmPracticeAreas')) {
            qs('firmPracticeAreas').value = Array.isArray(firm?.practiceAreas) 
                ? firm.practiceAreas.join(', ') 
                : firm?.practiceAreas || '';
        }

        // ✅ USERS table - Load users
        await loadAndRenderUsers();

        // ✅ COMPLETE JOIN CODE SECTION
        const joinField = qs('joinCodeField');
        const editJoinInput = qs('editJoinCode');
        let revealed = false;
        const statusEl = qs('joinStatus');

        function renderJoin() {
            if (!joinField || !firm?.joinCode) return;
            joinField.value = revealed ? firm.joinCode : firm.joinCode.slice(0, 2) + '...';
            if (editJoinInput) editJoinInput.value = firm.joinCode;
        }

        renderJoin();

        // Reveal button
        const revealBtn = qs('revealJoinBtn');
        if (revealBtn && me.isActive && firm?.joinCode) {
            revealBtn.addEventListener('click', () => {
                revealed = !revealed;
                revealBtn.textContent = revealed ? 'Hide' : 'Reveal';
                renderJoin();
            });
        }

        // Copy button
        const copyBtn = qs('copyJoinBtn');
        if (copyBtn && firm?.joinCode) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(firm.joinCode);
                    if (statusEl) {
                        statusEl.textContent = 'Copied!';
                        setTimeout(() => statusEl.textContent = '', 2000);
                    }
                } catch {
                    if (statusEl) statusEl.textContent = 'Copy failed.';
                }
            });
        }

        // Rotate button
        const rotateBtn = qs('rotateJoinBtn');
        if (me.isActive && rotateBtn && firm && firm._id) {
            rotateBtn.addEventListener('click', async () => {
                try {
                    if (statusEl) statusEl.textContent = 'Rotating join code...';
                    const resp = await api(`/firms/${firm._id}/join-code/rotate`, { method: 'POST' });
                    firm.joinCode = resp.joinCode;
                    revealed = false;
                    renderJoin();
                    if (statusEl) {
                        statusEl.textContent = 'New join code generated!';
                        setTimeout(() => statusEl.textContent = '', 2000);
                    }
                } catch (e) {
                    console.error('Rotate error:', e);
                    if (statusEl) statusEl.textContent = e.message || 'Failed to rotate join code.';
                }
            });
        }

        // Save custom join code
        const saveJoinCodeBtn = qs('saveJoinCodeBtn');
        if (me.isActive && saveJoinCodeBtn && firm && firm._id) {
            saveJoinCodeBtn.addEventListener('click', async () => {
                const newCode = editJoinInput?.value.trim();
                if (!newCode) {
                    if (statusEl) statusEl.textContent = 'Join code cannot be empty.';
                    return;
                }
                if (!/^[A-Za-z0-9]{4,10}$/.test(newCode)) {
                    if (statusEl) statusEl.textContent = 'Use 4–10 letters/numbers only.';
                    return;
                }
                try {
                    if (statusEl) statusEl.textContent = 'Saving custom join code...';
                    const resp = await api(`/firms/${firm._id}`, {
                        method: 'PATCH',
                        body: { joinCode: newCode }
                    });
                    firm.joinCode = resp.firm?.joinCode || newCode;
                    revealed = true;
                    renderJoin();
                    if (statusEl) {
                        statusEl.textContent = 'Custom join code saved!';
                        setTimeout(() => statusEl.textContent = '', 2000);
                    }
                } catch (e) {
                    console.error('Custom code error:', e);
                    if (statusEl) statusEl.textContent = e.message || 'Failed to save custom code.';
                }
            });
        }

        // Save firm button
        qs('saveFirmBtn')?.addEventListener('click', async () => {
            const firmStatus = qs('firmStatus');
            if (!firm || !firm._id || !me.isActive) return;
            try {
                if (firmStatus) firmStatus.textContent = 'Saving...';
                const displayName = qs('firmDisplayName')?.value.trim();
                const description = qs('firmDescription')?.value.trim();
                const practiceAreas = qs('firmPracticeAreas')?.value.split(',')
                    .map(x => x.trim())
                    .filter(Boolean);
                await api(`/firms/${firm._id}`, {
                    method: 'PATCH',
                    body: { displayName, description, practiceAreas }
                });
                if (firmStatus) {
                    firmStatus.textContent = 'Saved!';
                    setTimeout(() => firmStatus.textContent = '', 2000);
                }
            } catch (e) {
                if (firmStatus) firmStatus.textContent = e.message;
            }
        });
    } catch (e) {
        console.error('Dashboard error:', e);
        if (e.status === 401 || e.status === 403) {
            clearToken();
            window.location.href = '/index.html';
        }
        // Other errors ignored - page stays visible
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initAdminPage();
});

/* ===============================
   EMPLOYEE PRODUCTIVITY CHART
================================ */

let __productivityChart = null;

async function loadEmployeeProductivity() {
  const period = document.getElementById('productivityPeriod')?.value || 'month';

  const resp = await api(`/stats/employee-productivity?period=${period}`);
  const data = resp.data || [];

  const labels = data.map(d => d.label);
  const values = data.map(d => d.tasksCompleted);

  const canvas = document.getElementById('employeeProductivityChart');
  const ctx = canvas.getContext('2d');

  if (__productivityChart) __productivityChart.destroy();

  // 🔥 FORCE ALL TEXT TO WHITE
  Chart.defaults.color = '#ffffff';

  __productivityChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: '#198754',   // green
        borderRadius: 8,
        barThickness: 26
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',

      layout: {
        padding: {
          left: 140   // 🔥 MOST IMPORTANT FIX (label space)
        }
      },

      plugins: {
        legend: { display: false }
      },

      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            precision: 0,
            color: '#ffffff'
          },
          grid: {
            color: 'rgba(255,255,255,0.08)'
          }
        },
        y: {
          ticks: {
            autoSkip: false,
            color: '#ffffff',
            font: {
              size: 14,
              weight: '600'
            }
          },
          grid: {
            color: 'rgba(255,255,255,0.08)'
          }
        }
            }
        }
    });
}

// Period dropdown handler
document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "productivityPeriod") {
        loadEmployeeProductivity(e.target.value);
    }
});