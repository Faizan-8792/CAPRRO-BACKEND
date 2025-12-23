const API_BASE = window.location.hostname === 'localhost' ? '/api' : '/capro/api';
const TOKEN_KEY = 'caproadminjwt';

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

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

function ensureFirmAdmin(role) {
    return role === 'FIRM_ADMIN';
}

function isSuperAdmin(user) {
    return user.role === 'SUPERADMIN' || user.email === 'saifullahfaizan786@gmail.com';
}

async function api(path, opts) {
    const token = getToken();
    const headers = Object.assign({
        'Content-Type': 'application/json',
    }, opts?.headers);

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

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
}

/**
 * UPDATED: includes 'tasks' page + correct nav highlight
 */
function showPage(hash) {
    const pages = ['dashboard', 'tasks', 'firm', 'users', 'join', 'settings'];
    for (const p of pages) {
        const el = qs(`page-${p}`);
        if (el) {
            el.style.display = (hash === `#${p}`) ? 'block' : 'none';
        }
    }

    const nav = qs('nav');
    if (nav) {
        nav.querySelectorAll('a').forEach(a => {
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
    showPage(hash);

    // Tasks page open hone par board init/refresh
    if (hash === '#tasks') {
        if (window.initTaskBoard) window.initTaskBoard();
        if (window.refreshTaskBoard) window.refreshTaskBoard();
    }

    // Dashboard open hone par smart widgets
    if (hash === '#dashboard') {
        if (window.loadTodayReminders) loadTodayReminders();
        loadClientsToChaseToday();
    }
}

// ---------- Login page (index.html) ----------
async function initLoginPage() {
    const sendOtpBtn = qs('sendOtp');
    if (!sendOtpBtn) return;

    const emailEl = qs('email');
    const otpEl = qs('otp');
    const statusEl = qs('status');
    const otpBlock = qs('otpBlock');
    const goVerify = qs('goVerify');
    const verifyBtn = qs('verifyOtp');

    goVerify?.addEventListener('click', () => {
        otpBlock.style.display = 'block';
        statusEl.textContent = 'Enter OTP and verify.';
    });

    sendOtpBtn.addEventListener('click', async () => {
        try {
            const email = emailEl.value.trim();
            if (!email) {
                statusEl.textContent = 'Email required.';
                return;
            }
            statusEl.textContent = 'Sending OTP...';
            const res = await fetch(`${API_BASE}/auth/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to send OTP');
            otpBlock.style.display = 'block';
            statusEl.textContent = 'OTP sent. Check your email.';
        } catch (e) {
            statusEl.textContent = e.message || 'Failed to send OTP.';
        }
    });

    verifyBtn.addEventListener('click', async () => {
        try {
            const email = emailEl.value.trim();
            const otpCode = otpEl.value.trim();
            if (!email || !otpCode) {
                statusEl.textContent = 'Email & OTP required.';
                return;
            }
            statusEl.textContent = 'Verifying OTP...';
            const res = await fetch(`${API_BASE}/auth/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otpCode }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to verify OTP');
            saveToken(data.token);
            const me = await api('/auth/me');
            const user = me.user;

            if (isSuperAdmin(user)) {
                statusEl.innerHTML = '<strong>Super Admin login successful</strong>';
                setTimeout(() => window.location.href = './super.html', 1000);
                return;
            }

            if (user.role === 'FIRM_ADMIN' && user.isActive === true) {
                statusEl.innerHTML = '<strong>Firm Admin login successful</strong>';
                setTimeout(() => window.location.href = './admin.html#dashboard', 1000);
                return;
            }

            if (user.role === 'FIRM_ADMIN' && user.isActive === false) {
                statusEl.innerHTML = '<strong>Successfully signed up for Firm Admin!</strong><br><small class="text-muted">Your request is now pending Super Admin approval. Check back later or contact Super Admin <a href="mailto:saifullahfaizan786@gmail.com">saifullahfaizan786@gmail.com</a>.</small>';
                setTimeout(() => window.location.href = './admin.html#dashboard', 3000);
                return;
            }

            clearToken();
            statusEl.innerHTML = '<strong>Admin request submitted</strong><br><small class="text-muted">To become Firm Admin, create a firm from Chrome extension first, then return here.</small>';
        } catch (e) {
            statusEl.textContent = e.message || 'Login failed.';
        }
    });
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
            `Hum aapke ${item.serviceType || "compliance"} ke documents ka wait kar rahe hain. ` +
            `Last 3+ din se documents pending hain.\n` +
            `Due: ${dueText}.\n\n` +
            `Kripya documents jaldi share karein.\n\n- CA PRO Toolkit`
        );
    }

    // high risk
    return (
        `Hi ${item.clientName},\n\n` +
        `Pichle 2 periods me aapke ${item.serviceType || "compliance"} filings ` +
        `due date ke baad submit hue the. Is baar time se complete karne ke liye ` +
        `documents thoda pehle bhejne ka request hai.\n` +
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

async function loadClientsToChaseToday() {
    const pendingList = qs("chasePendingList");
    const riskList = qs("chaseRiskList");
    const pendingStatus = qs("chasePendingStatus");
    const riskStatus = qs("chaseRiskStatus");

    if (!pendingList || !riskList) return;

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
                        `${idx + 1}. ${item.clientName} – ${item.serviceType || ""} · ${item.daysPending} din se pending`
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
                        `${idx + 1}. ${item.clientName} – ${item.serviceType || ""} · last delay ${item.lastPeriodDelayDays} din`
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

        // FIXED: Proper event delegation with loading state
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
                    await loadClientsToChaseToday();
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
                    await loadClientsToChaseToday();
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

    } catch (err) {
        console.error("loadClientsToChaseToday error:", err);
        if (pendingStatus) pendingStatus.textContent = "Failed to load.";
        if (riskStatus) riskStatus.textContent = "Failed to load.";
    }
}

// ---------- Firm Admin page (admin.html) ----------
async function initAdminPage() {
    if (!qs('logoutBtn')) return;

    const token = getToken();
    if (!token) {
        window.location.href = './index.html';
        return;
    }

    function doLogout() {
        clearToken();
        window.location.href = './index.html';
    }

    qs('logoutBtn')?.addEventListener('click', doLogout);
    window.addEventListener('hashchange', onHashChange);

    try {
        const meResp = await api('/auth/me');
        const me = meResp.user;

        if (isSuperAdmin(me)) {
            window.location.href = './super.html';
            return;
        }

        if (!ensureFirmAdmin(me.role)) {
            document.body.innerHTML = `
                <div class="container" style="padding-top: 40px">
                    <div class="card p-4 mx-auto" style="max-width: 500px">
                        <div class="text-center mb-4">
                            <h3>Admin Access</h3>
                            <p class="text-muted">Create a firm from Chrome extension first.</p>
                        </div>
                        <div class="text-center">
                            <a href="./index.html" class="btn btn-primary">Login</a>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        // PENDING APPROVAL
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

        // Populate user info
        if (qs('emailBadge')) qs('emailBadge').textContent = me.email;
        if (qs('roleBadge')) qs('roleBadge').textContent = me.isActive ? 'FIRM_ADMIN' : 'FIRM_ADMIN (Pending)';

        // FIRM LOADING
        let firm = null;
        try {
            const myFirmResp = await api('/firms/me');
            if (myFirmResp?.ok && myFirmResp.firm && myFirmResp.firm._id) {
                const firmId = myFirmResp.firm._id;
                const firmResp = await api(`/firms/${firmId}`);
                if (firmResp?.ok && firmResp.firm) {
                    firm = firmResp.firm;
                }
            }
        } catch (e) {
            console.error('Firm load error:', e);
        }

        if (qs('topSub')) {
            qs('topSub').textContent = firm ? `Firm: ${firm.displayName} (@${firm.handle})` : 'No firm linked';
        }

        // Dashboard KPIs
        if (qs('kpiFirmName')) qs('kpiFirmName').textContent = firm?.displayName || 'Individual';
        if (qs('kpiFirmHandle')) qs('kpiFirmHandle').textContent = firm?.handle ? `@${firm.handle}` : '';
        if (qs('kpiPlanType')) qs('kpiPlanType').textContent = firm?.planType || 'FREE';

        const planExpiryText = firm?.planExpiry ? new Date(firm.planExpiry).toLocaleDateString() : 'NA';
        if (qs('kpiPlanExpiry')) qs('kpiPlanExpiry').textContent = `Expires ${planExpiryText}`;
        if (qs('settingsPlanType')) qs('settingsPlanType').value = firm?.planType || 'FREE';
        if (qs('settingsPlanExpiry')) qs('settingsPlanExpiry').value = planExpiryText;


        // Firm form population
        if (qs('firmDisplayName')) qs('firmDisplayName').value = firm?.displayName || '';
        if (qs('firmHandle')) qs('firmHandle').value = firm?.handle || '';
        if (qs('firmDescription')) qs('firmDescription').value = firm?.description || '';
        if (qs('firmPracticeAreas')) qs('firmPracticeAreas').value = Array.isArray(firm?.practiceAreas) ? firm.practiceAreas.join(', ') : '';

        // USERS
        let users = [];
        if (firm && firm._id) {
            try {
                const usersResp = await api(`/firms/${firm._id}/users`);
                users = usersResp?.users || [];
            } catch (e) {
                console.error('Users load error:', e);
            }
        }

        if (qs('kpiTotalUsers')) qs('kpiTotalUsers').textContent = String(users.length);
        const activeCount = users.filter(u => u.isActive !== false).length;
        if (qs('kpiActiveUsers')) qs('kpiActiveUsers').textContent = String(activeCount);

        const tbody = qs('usersTbody');
        if (tbody) {
            if (!users.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No users</td></tr>';
            } else {
                tbody.innerHTML = users.map(u =>
                    `<tr>
                        <td>${escapeHtml(u.name)}</td>
                        <td>${escapeHtml(u.email)}</td>
                        <td><span class="badge bg-secondary">${escapeHtml(u.role)}</span></td>
                        <td>${escapeHtml(u.accountType)}</td>
                        <td>${u.isActive === false ? '<span class="badge bg-warning">Inactive</span>' : '<span class="badge bg-success">Active</span>'}</td>
                        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</td>
                    </tr>`
                ).join('');
            }
        }

        // ========== JOIN CODE SECTION ==========
        const joinField = qs('joinCodeField');
        const editJoinInput = qs('editJoinCode');
        let revealed = false;

        const renderJoin = () => {
            if (!joinField || !firm?.joinCode) {
                if (joinField) joinField.value = '';
                return;
            }
            joinField.value = revealed ? firm.joinCode : firm.joinCode.slice(0, 2) + '...';
            if (editJoinInput) editJoinInput.value = firm.joinCode;
        };

        const statusEl = qs('joinStatus');

        const revealBtn = qs('revealJoinBtn');
        if (revealBtn && me.isActive && firm?.joinCode) {
            revealBtn.addEventListener('click', () => {
                revealed = !revealed;
                revealBtn.textContent = revealed ? 'Hide' : 'Reveal';
                renderJoin();
            });
        }

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

        renderJoin();

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

        onHashChange();
    } catch (e) {
        console.error('Dashboard error:', e);
        if (e.status === 401) {
            clearToken();
            window.location.href = './index.html';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initLoginPage();
    initAdminPage();
});