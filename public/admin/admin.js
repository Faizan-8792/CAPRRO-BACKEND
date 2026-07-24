const API_BASE = "https://api.caprotoolkit.in/api";
const TOKEN_KEY = 'caproadminjwt';
let __clientsChaseLoading = false;
let __lastHash = null; // NEW: prevents repeated hash handling

// AUTH HELPER FUNCTIONS
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Token handoff: allow opening this panel as /admin/admin.html?t=<jwt> (e.g.
// from the extension). Store the token, then strip it from the URL.
function absorbTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    const handoff = url.searchParams.get("t");
    if (handoff) {
      localStorage.setItem(TOKEN_KEY, handoff);
      url.searchParams.delete("t");
      window.history.replaceState(
        {},
        document.title,
        url.pathname + (url.search ? url.search : "") + url.hash
      );
    }
  } catch {
    /* ignore malformed URLs */
  }
}

async function apiGetMe() {
  const token = getToken();
  if (!token) throw new Error("No token");

  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) throw new Error("Unauthorized");
  return res.json();
}

// AUTH GUARD — returns the verified user object (or null on failure).
async function ensureAdminAuth() {
  try {
    absorbTokenFromUrl();
    const data = await apiGetMe();
    if (!data.ok) throw new Error("Invalid user");

    if (data.user.role === "SUPER_ADMIN") {
      window.location.href = "/admin/super.html";
      return null;
    }
    if (data.user.role !== "FIRM_ADMIN") {
      clearToken();
      window.location.href = "/index.html";
      return null;
    }
    return data.user;
  } catch (err) {
    console.error("Auth error:", err);
    clearToken();
    window.location.href = "/index.html";
    return null;
  }
}

// ─── sessionStorage cache with TTL ──────────────────────────────────
// Reduces perceived load time on tab switches / refreshes within a session.
function cacheGet(key, ttlSec) {
  try {
    const raw = sessionStorage.getItem(`__cache:${key}`);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > ttlSec * 1000) {
      sessionStorage.removeItem(`__cache:${key}`);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  try {
    sessionStorage.setItem(`__cache:${key}`, JSON.stringify({ t: Date.now(), v: value }));
  } catch {}
}
function cacheBust(prefix = "") {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(`__cache:${prefix}`)) sessionStorage.removeItem(k);
    }
  } catch {}
}

// Stale-while-revalidate: returns cached value INSTANTLY (if any),
// then triggers fresh fetch in background and calls onFresh(value).
async function swrApi(key, path, ttlSec, onFresh) {
  const cached = cacheGet(key, ttlSec);
  if (cached !== null) {
    // Fire-and-forget revalidation
    api(path).then((fresh) => {
      cacheSet(key, fresh);
      if (typeof onFresh === "function") onFresh(fresh);
    }).catch(() => {});
    return cached;
  }
  const fresh = await api(path);
  cacheSet(key, fresh);
  return fresh;
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

function formatEnumLabel(value) {
    const labels = {
        FIRM_ADMIN: 'Firm administrator',
        SUPER_ADMIN: 'Platform administrator',
        USER: 'Team member',
        FREE: 'Free',
        PRO: 'Pro',
        ENTERPRISE: 'Enterprise',
    };
    const normalized = String(value || '').trim().toUpperCase();
    if (labels[normalized]) return labels[normalized];
    return normalized
        .toLowerCase()
        .split('_')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function cleanRequestId(value) {
    const requestId = String(value || '').trim();
    return /^[A-Za-z0-9._:-]{1,96}$/.test(requestId) ? requestId : '';
}

function safeUserMessage(error, fallback = 'The request could not be completed. Try again.') {
    const status = Number(error?.status || 0);
    let message = fallback;

    if (status === 400 || status === 422) {
        message = 'Some submitted information could not be accepted. Review it and try again.';
    } else if (status === 401) {
        message = 'Your session has expired. Sign in again.';
    } else if (status === 403) {
        message = 'Your account does not have permission to complete this action.';
    } else if (status === 404) {
        message = 'The requested information is no longer available. Refresh and try again.';
    } else if (status === 409) {
        message = 'This information changed while you were working. Refresh and try again.';
    } else if (status === 429) {
        message = 'Too many requests were received. Wait briefly and try again.';
    } else if (status >= 500) {
        message = 'The service could not complete this request. Try again, or contact support if the issue continues.';
    } else if (error?.isRemoteRequest && !status) {
        message = 'The service could not be reached. Check your connection and try again.';
    }

    const requestId = cleanRequestId(error?.requestId);
    return `${message}${requestId ? ` Reference: ${requestId}.` : ''}`;
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
    const token = getToken();
    const headers = Object.assign({
        'Content-Type': 'application/json',
    }, opts?.headers);

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    let res;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method: opts?.method || 'GET',
            headers,
            body: opts?.body ? JSON.stringify(opts.body) : undefined,
        });
    } catch (error) {
        error.isRemoteRequest = true;
        error.status = 0;
        throw error;
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        // A safe fallback is created below for unsuccessful non-JSON responses.
    }

    if (!res.ok) {
        const msg = data?.error || data?.message || `Request failed (${res.status})`;
        const err = new Error(msg);
        err.isRemoteRequest = true;
        err.status = res.status;
        err.code = data?.code || null;
        err.category = data?.category || null;
        err.requestId = data?.requestId || res.headers.get('x-request-id') || '';
        err.data = data;
        throw err;
    }

    return data;
}

/**
 * UPDATED: includes 'tasks' page + correct nav highlight
 */
function showPage(hash) {
    const pages = ['dashboard', 'tasks', 'assistant', 'firm', 'users', 'join', 'settings'];
    for (const p of pages) {
        const el = qs(`page-${p}`);
        if (el) {
            el.style.display = (hash === `#${p}`) ? 'block' : 'none';
        }
    }

    // FIXED: Target sidebar links (.sidebar a), not <nav>
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.querySelectorAll('a').forEach(a => {
            const targetHash = a.getAttribute('href');
            a.classList.toggle('active', targetHash === hash);
        });
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
}

// ✅ Last day notifications UI
async function loadTodayReminders() {
    const listEl = qs('todayRemindersList');
    const statusEl = qs('todayRemindersStatus');
    if (!listEl) return;

    try {
        if (statusEl) statusEl.textContent = 'Loading upcoming reminders...';
        const resp = await api('/reminders/today');
        const reminders = resp?.reminders || [];

        if (!reminders.length) {
            listEl.innerHTML = "<li class='text-muted'>No reminders are due tomorrow.</li>";
            if (statusEl) statusEl.textContent = '';
            return;
        }

        listEl.innerHTML = reminders
            .map(r => {
                const dt = new Date(r.dueDateISO);
                const when = dt.toLocaleDateString('en-IN');
                const status = formatEnumLabel(r.status);
                return `<li>${escapeHtml(status)} · ${escapeHtml(r.clientLabel || r.typeId)} · due ${escapeHtml(when)}</li>`;
            })
            .join('');

        if (statusEl) {
            statusEl.textContent = `${reminders.length} reminder${reminders.length === 1 ? '' : 's'} due tomorrow.`;
        }
    } catch (error) {
        console.error('Upcoming reminders load error:', error);
        if (statusEl) statusEl.textContent = safeUserMessage(error, 'Upcoming reminders could not be loaded. Try again.');
    }
}

// --- Clients to Chase Today ---
function buildReminderMessage(item, type) {
    const dueText = item.dueDateISO
        ? new Date(item.dueDateISO).toLocaleDateString('en-IN')
        : 'the upcoming due date';
    const clientName = item.clientName || 'Client';
    const serviceName = formatEnumLabel(item.serviceType) || 'compliance work';

    if (type === 'pending') {
        return (
            `Dear ${clientName},\n\n` +
            `This is a reminder that we are awaiting documents required for your ${serviceName}. ` +
            `Please share the outstanding items at your earliest convenience so the work can be completed before ${dueText}.\n\n` +
            `If you have already shared them, please disregard this message.\n\n` +
            `Regards,\nCA PRO Toolkit`
        );
    }

    return (
        `Dear ${clientName},\n\n` +
        `To support timely completion of your ${serviceName}, please share the required documents in advance of ${dueText}. ` +
        `Early receipt will allow sufficient time for review and any necessary follow-up.\n\n` +
        `If you have already shared them, please disregard this message.\n\n` +
        `Regards,\nCA PRO Toolkit`
    );
}

function setFollowUpStatus(type, message, kind = '') {
    const statusEl = qs(type === 'risk' ? 'chaseRiskStatus' : 'chasePendingStatus');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('text-danger', kind === 'error');
    statusEl.classList.toggle('text-success', kind === 'success');
    if (kind === 'success') {
        setTimeout(() => {
            if (statusEl.textContent === message) statusEl.textContent = '';
        }, 4000);
    }
}

async function copyReminderToClipboard(item, type) {
    try {
        let message = null;
        try {
            const resp = await api('/audit/reminder-message', {
                method: 'POST',
                body: {
                    clientName: item.clientName,
                    serviceType: item.serviceType,
                    type,
                    daysPending: item.daysPending,
                    lastDelayDays: item.lastPeriodDelayDays,
                    dueDate: item.dueDateISO,
                    tone: 'polite',
                },
            });
            if (resp?.message) message = resp.message;
        } catch (error) {
            console.warn('Personalized reminder unavailable; using reviewed template:', error);
        }

        if (!message) message = buildReminderMessage(item, type);

        await navigator.clipboard.writeText(message);
        setFollowUpStatus(type, 'Reminder copied. Paste it into your approved communication channel.', 'success');
    } catch (error) {
        console.error('Clipboard copy failed:', error);
        setFollowUpStatus(type, 'Clipboard access is unavailable. Allow clipboard access, then try again.', 'error');
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

        // Document follow-ups
        if (!pending.length) {
            pendingList.innerHTML = '<li class="text-muted">No document follow-ups are due.</li>';
        } else {
            pendingList.innerHTML = pending
                .map((item, idx) => {
                    const service = formatEnumLabel(item.serviceType) || 'Compliance work';
                    const label = escapeHtml(
                        `${idx + 1}. ${item.clientName} · ${service} · awaiting documents for ${item.daysPending} days`
                    );
                    return `
                        <li>
                            <span>${label}</span>
                            <div class="d-flex gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary ms-2 copy-btn"
                                        data-type="pending" data-index="${idx}">
                                    Copy message
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-success ms-1 done-btn"
                                        data-type="pending" data-taskid="${item.taskId}">
                                    Complete
                                </button>
                            </div>
                        </li>`;
                })
                .join('');
        }

        // Priority follow-ups
        if (!risk.length) {
            riskList.innerHTML = '<li class="text-muted">No priority follow-ups are due.</li>';
        } else {
            riskList.innerHTML = risk
                .map((item, idx) => {
                    const service = formatEnumLabel(item.serviceType) || 'Compliance work';
                    const label = escapeHtml(
                        `${idx + 1}. ${item.clientName} · ${service} · early follow-up recommended`
                    );
                    return `
                        <li>
                            <span>${label}</span>
                            <div class="d-flex gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary ms-2 copy-btn"
                                        data-type="risk" data-index="${idx}">
                                    Copy message
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-success ms-1 done-btn"
                                        data-type="risk" data-taskid="${item.taskId}">
                                    Complete
                                </button>
                            </div>
                        </li>`;
                })
                .join('');
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
                    doneBtn.textContent = "Saving...";

                    await markChaseComplete('pending', taskId);
                    await loadClientsToChaseToday();
                } catch (error) {
                    console.error('Document follow-up completion failed:', error);
                    setFollowUpStatus('pending', safeUserMessage(error, 'The follow-up could not be completed. Try again.'), 'error');
                } finally {
                    doneBtn.disabled = false;
                    doneBtn.textContent = "Complete";
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
                    doneBtn.textContent = "Saving...";

                    await markChaseComplete('risk', taskId);
                    await loadClientsToChaseToday();
                } catch (error) {
                    console.error('Priority follow-up completion failed:', error);
                    setFollowUpStatus('risk', safeUserMessage(error, 'The follow-up could not be completed. Try again.'), 'error');
                } finally {
                    doneBtn.disabled = false;
                    doneBtn.textContent = "Complete";
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
        
    } catch (error) {
        console.error('Client follow-up load error:', error);
        const message = safeUserMessage(error, 'Client follow-ups could not be loaded. Try again.');
        if (pendingStatus) pendingStatus.textContent = message;
        if (riskStatus) riskStatus.textContent = message;
    } finally {
        __clientsChaseLoading = false;
        console.log('loadClientsToChaseToday: Guard reset');
    }
}

// Skeleton shimmer placeholders — instant visual feedback while data loads
function paintSkeleton() {
    const kpiIds = ['kpiFirmName', 'kpiFirmHandle', 'kpiTotalUsers', 'kpiActiveUsers', 'kpiPlanType', 'kpiPlanExpiry'];
    for (const id of kpiIds) {
        const el = qs(id);
        if (el && !el.textContent.trim()) {
            el.innerHTML = '<span class="skel-shimmer"></span>';
        }
    }
    const tbody = qs('usersTbody');
    if (tbody) {
        tbody.innerHTML = Array.from({ length: 3 }).map(() =>
            `<tr>${Array.from({ length: 7 }).map(() => '<td><span class="skel-shimmer"></span></td>').join('')}</tr>`
        ).join('');
    }
}

// ---------- Firm Admin page (admin.html) ----------
async function initAdminPage() {
    if (!qs('logoutBtn')) return;

    // Render skeleton placeholders IMMEDIATELY so the page feels instant
    paintSkeleton();

    // AUTH CHECK (returns the user object; no duplicate /auth/me later)
    const me = await ensureAdminAuth();
    if (!me) return;

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

    // Initial page load
    onHashChange();

    // Load task board if tasks page or global script exists
    if (window.initTaskBoard || document.getElementById('taskBoardColumns')) {
        console.log('Task board detected, waiting for hashchange to init');
    }

    let currentFirm = null; // Store firm globally for delete operations

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

            // Render team members
            if (!users.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No team members found.</td></tr>';
            } else {
                tbody.innerHTML = users.map(u => `
                    <tr>
                        <td>${escapeHtml(u.name)}</td>
                        <td>${escapeHtml(u.email)}</td>
                        <td><span class="badge bg-${u.role === 'FIRM_ADMIN' ? 'warning' : 'secondary'}">${escapeHtml(formatEnumLabel(u.role))}</span></td>
                        <td>${escapeHtml(formatEnumLabel(u.accountType))}</td>
                        <td>${u.isActive !== false ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-warning">Inactive</span>'}</td>
                        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</td>
                        <td>
                            <button type="button" class="btn btn-sm btn-outline-danger delete-user-btn" data-userid="${u._id}">
                                Remove
                            </button>
                        </td>
                    </tr>
                `).join('');
            }
        } catch (error) {
            console.error('Team member load error:', error);
            if (tbody) {
                const message = escapeHtml(safeUserMessage(error, 'Team members could not be loaded. Refresh and try again.'));
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">${message}</td></tr>`;
            }
        }
    }

    try {
        // Non-admin access denied
        if (!ensureFirmAdmin(me.role)) {
            if (isSuperAdmin(me)) {
                window.location.href = '/admin/super.html';
                return;
            }
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

        // PENDING APPROVAL — view-only mode
        const pendingBanner = qs('pendingBanner');
        if (!me.isActive) {
            if (pendingBanner) {
                pendingBanner.style.display = 'block';
                pendingBanner.classList.remove('d-none');
            }
            document.querySelectorAll('button[id$="Btn"]').forEach(btn => {
                btn.disabled = true;
                btn.classList.add('opacity-50');
            });
        }

        // Populate user info immediately
        if (qs('emailBadge')) qs('emailBadge').textContent = me.email;
        if (qs('roleBadge')) qs('roleBadge').textContent = me.isActive ? 'Firm administrator' : 'Firm administrator · approval pending';

        // FIRM LOADING — stale-while-revalidate from cache + parallel users fetch
        let firm = null;
        try {
            // Step 1: Get firmId (cached for 5 min)
            const myFirmResp = await swrApi('firms/me', '/firms/me', 300, (fresh) => {
                if (fresh?.firm?._id) reloadFirmAndUsers(fresh.firm._id);
            });
            if (myFirmResp?.ok && myFirmResp.firm && myFirmResp.firm._id) {
                const firmId = myFirmResp.firm._id;
                // Step 2: Fire firm details + users in PARALLEL (Promise.all)
                const [firmResp, usersResp] = await Promise.all([
                    swrApi(`firms/${firmId}`, `/firms/${firmId}`, 300, (fresh) => {
                        if (fresh?.firm) hydrateFirm(fresh.firm);
                    }),
                    swrApi(`firms/${firmId}/users`, `/firms/${firmId}/users`, 60, (fresh) => {
                        if (fresh?.users) renderUsersTable(fresh.users);
                    }),
                ]);
                if (firmResp?.ok && firmResp.firm) {
                    firm = firmResp.firm;
                    currentFirm = firm;
                }
                if (usersResp?.users) {
                    renderUsersTable(usersResp.users);
                }
            }
        } catch (e) {
            console.error('Firm load error:', e);
        }

        // Helper to refresh data when cache returns stale
        async function reloadFirmAndUsers(firmId) {
            try {
                const [firmResp, usersResp] = await Promise.all([
                    api(`/firms/${firmId}`),
                    api(`/firms/${firmId}/users`),
                ]);
                if (firmResp?.firm) hydrateFirm(firmResp.firm);
                if (usersResp?.users) renderUsersTable(usersResp.users);
            } catch {}
        }

        function hydrateFirm(f) {
            currentFirm = f;
            if (qs('topSub')) qs('topSub').textContent = `Firm: ${f.displayName} (@${f.handle})`;
            if (qs('kpiFirmName')) qs('kpiFirmName').textContent = f.displayName || 'Individual';
            if (qs('kpiFirmHandle')) qs('kpiFirmHandle').textContent = f.handle || '';
            if (qs('kpiPlanType')) qs('kpiPlanType').textContent = 'FREE';
            if (qs('kpiPlanExpiry')) qs('kpiPlanExpiry').textContent = 'All tools included';
        }

        function renderUsersTable(users) {
            const tbody = qs('usersTbody');
            if (qs('kpiTotalUsers')) qs('kpiTotalUsers').textContent = String(users.length);
            const activeCount = users.filter(u => u.isActive !== false).length;
            if (qs('kpiActiveUsers')) qs('kpiActiveUsers').textContent = String(activeCount);
            if (!tbody) return;
            if (!users.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No team members found.</td></tr>';
                return;
            }
            tbody.innerHTML = users.map(u => `
                <tr>
                    <td>${escapeHtml(u.name)}</td>
                    <td>${escapeHtml(u.email)}</td>
                    <td><span class="badge bg-${u.role === 'FIRM_ADMIN' ? 'warning' : 'secondary'}">${escapeHtml(formatEnumLabel(u.role))}</span></td>
                    <td>${escapeHtml(formatEnumLabel(u.accountType))}</td>
                    <td>${u.isActive !== false ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-warning">Inactive</span>'}</td>
                    <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</td>
                    <td>
                        <button type="button" class="btn btn-sm btn-outline-danger delete-user-btn" data-userid="${u._id}">
                            Remove
                        </button>
                    </td>
                </tr>
            `).join('');
        }

        // topSub + hydrate fall-through: if firm is null after fetch
        if (!firm && qs('topSub')) {
            qs('topSub').textContent = 'No firm linked';
        }

        // Form fields populated once firm data is in (KPIs already hydrated above)
        if (qs('firmDisplayName')) qs('firmDisplayName').value = firm?.displayName || '';
        if (qs('firmHandle')) qs('firmHandle').value = firm?.handle || '';
        if (qs('firmDescription')) qs('firmDescription').value = firm?.description || '';
        if (qs('firmPracticeAreas')) {
            qs('firmPracticeAreas').value = Array.isArray(firm?.practiceAreas)
                ? firm.practiceAreas.join(', ')
                : firm?.practiceAreas || '';
        }

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
                    if (statusEl) statusEl.textContent = safeUserMessage(e, 'The join code could not be rotated. Try again.');
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
                } catch (error) {
                    console.error('Custom join code save error:', error);
                    if (statusEl) statusEl.textContent = safeUserMessage(error, 'The custom join code could not be saved. Try again.');
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
            } catch (error) {
                console.error('Firm profile save error:', error);
                if (firmStatus) firmStatus.textContent = safeUserMessage(error, 'Firm details could not be saved. Try again.');
            }
        });

        // Remove a team member after explicit confirmation.
        document.getElementById('usersTbody')?.addEventListener('click', async (event) => {
            const removeButton = event.target.closest('.delete-user-btn');
            if (!removeButton) return;

            const userId = removeButton.dataset.userid;
            const memberName = removeButton.closest('tr')?.querySelector('td')?.textContent?.trim() || 'this team member';
            const confirmed = confirm(`Remove ${memberName} from this firm? They will lose access to the firm's workspace.`);
            if (!confirmed) return;

            const firmStatus = qs('firmStatus');
            try {
                removeButton.textContent = 'Removing...';
                removeButton.disabled = true;
                await api(`/firms/${firm._id}/users/${userId}`, { method: 'DELETE' });
                cacheBust(`firms/${firm._id}/users`);
                const usersResp = await api(`/firms/${firm._id}/users`);
                if (usersResp?.users) renderUsersTable(usersResp.users);
                if (firmStatus) firmStatus.textContent = `${memberName} was removed from the firm.`;
            } catch (error) {
                console.error('Team member removal error:', error);
                if (firmStatus) {
                    firmStatus.textContent = safeUserMessage(error, 'The team member could not be removed. Try again.');
                }
            } finally {
                removeButton.disabled = false;
                removeButton.textContent = 'Remove';
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