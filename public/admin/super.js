// public/admin/super.js — Super Admin Dashboard

const API_BASE = "https://caprro-backend-1.onrender.com/api";
const TOKEN_KEY = "caproadminjwt";

// ─── Auth helpers ───────────────────────────────────────────────────
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function apiGetMe() {
  const token = getToken();
  if (!token) throw new Error("No token");
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json();
}

async function ensureSuperAdminAuth() {
  try {
    const data = await apiGetMe();
    if (!data.ok) throw new Error("Invalid user");
    if (data.user.role !== "SUPER_ADMIN") {
      window.location.href = "/admin/admin.html";
      return false;
    }
    return true;
  } catch (err) {
    console.error("Auth error:", err);
    clearToken();
    window.location.href = "/index.html";
    return false;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────
function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const msg = data?.error || data?.message || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function requireSuperAdmin(user) {
  return user.role === "SUPER_ADMIN" || user.email === "saifullahfaizan786@gmail.com";
}

async function loadMe() {
  const me = await api("/auth/me");
  return me.user;
}

// ─── App Config (maintenance + welcome) ────────────────────────────
async function loadAppConfigSection() {
  try {
    const r = await api("/app-config");
    if (!r.ok) return;
    const c = r.config;

    const toggle = qs("maintenanceToggle");
    const label = qs("maintenanceLabel");
    const msg = qs("maintenanceMessageInput");
    if (toggle) toggle.checked = !!c.maintenanceMode;
    if (label) label.textContent = `Maintenance mode: ${c.maintenanceMode ? "ON" : "OFF"}`;
    if (msg) msg.value = c.maintenanceMessage || "";

    const wa = c.welcomeAnnouncement || {};
    if (qs("welcomeVersion")) qs("welcomeVersion").value = wa.version || "";
    if (qs("welcomeTitleInput")) qs("welcomeTitleInput").value = wa.title || "";
    if (qs("welcomeBodyInput")) qs("welcomeBodyInput").value = wa.body || "";
    if (qs("welcomeEnabled")) qs("welcomeEnabled").checked = wa.enabled !== false;
  } catch (err) {
    console.warn("App config load fail:", err.message);
  }
}

function bindAppConfigHandlers() {
  const toggle = qs("maintenanceToggle");
  const label = qs("maintenanceLabel");
  const msgInput = qs("maintenanceMessageInput");
  const saveMsgBtn = qs("saveMaintenanceBtn");
  const msgStatus = qs("maintenanceStatus");

  if (toggle) {
    toggle.addEventListener("change", async () => {
      const want = toggle.checked;
      const prev = !want;
      toggle.disabled = true;
      try {
        const r = await api("/app-config/maintenance", {
          method: "PATCH",
          body: { maintenanceMode: want },
        });
        if (r.ok) {
          if (label) label.textContent = `Maintenance mode: ${r.maintenanceMode ? "ON" : "OFF"}`;
          if (msgStatus) {
            msgStatus.textContent = r.maintenanceMode
              ? "Maintenance mode is now ON. All users will see the maintenance screen."
              : "Maintenance mode is OFF. Users have full access.";
            msgStatus.style.color = r.maintenanceMode ? "#b8782e" : "#2d7a55";
          }
        } else {
          toggle.checked = prev;
        }
      } catch (err) {
        toggle.checked = prev;
        if (msgStatus) {
          msgStatus.textContent = err.message || "Failed to update.";
          msgStatus.style.color = "#b44545";
        }
      } finally {
        toggle.disabled = false;
      }
    });
  }

  if (saveMsgBtn) {
    saveMsgBtn.addEventListener("click", async () => {
      const message = msgInput?.value?.trim() || "";
      saveMsgBtn.disabled = true;
      saveMsgBtn.textContent = "Saving...";
      try {
        await api("/app-config/maintenance", {
          method: "PATCH",
          body: { maintenanceMessage: message },
        });
        if (msgStatus) {
          msgStatus.textContent = "Saved.";
          msgStatus.style.color = "#2d7a55";
        }
      } catch (err) {
        if (msgStatus) {
          msgStatus.textContent = err.message || "Save failed.";
          msgStatus.style.color = "#b44545";
        }
      } finally {
        saveMsgBtn.disabled = false;
        saveMsgBtn.textContent = "Save Message";
      }
    });
  }

  const saveWelcomeBtn = qs("saveWelcomeBtn");
  const welcomeStatus = qs("welcomeStatus");
  if (saveWelcomeBtn) {
    saveWelcomeBtn.addEventListener("click", async () => {
      saveWelcomeBtn.disabled = true;
      saveWelcomeBtn.textContent = "Saving...";
      try {
        await api("/app-config/welcome", {
          method: "PATCH",
          body: {
            version: qs("welcomeVersion")?.value?.trim() || "",
            title: qs("welcomeTitleInput")?.value || "",
            body: qs("welcomeBodyInput")?.value || "",
            enabled: !!qs("welcomeEnabled")?.checked,
          },
        });
        if (welcomeStatus) {
          welcomeStatus.textContent = "Saved. Users with a different seen-version will see this on next popup open.";
          welcomeStatus.style.color = "#2d7a55";
        }
      } catch (err) {
        if (welcomeStatus) {
          welcomeStatus.textContent = err.message || "Save failed.";
          welcomeStatus.style.color = "#b44545";
        }
      } finally {
        saveWelcomeBtn.disabled = false;
        saveWelcomeBtn.textContent = "Save Announcement";
      }
    });
  }
}

// ─── Usage Stats (DAU/WAU/MAU) ──────────────────────────────────────
async function loadUsageStats() {
  const grid = qs("usageGrid");
  const statusEl = qs("usageLoadingStatus");
  const chartEl = qs("dailyActivityChart");
  const topUsersEl = qs("topUsersList");

  try {
    const data = await api("/super/usage-stats");
    if (!data.ok) throw new Error("Failed to load usage stats");
    const u = data.usage;
    if (statusEl) statusEl.textContent = "";

    if (grid) {
      grid.innerHTML = `
        <div class="stat-card stat-primary">
          <div class="stat-label">DAU (Last 24h)</div>
          <div class="stat-value">${u.dau}</div>
          <div class="stat-sub">Active in last day</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">WAU (Last 7d)</div>
          <div class="stat-value">${u.wau}</div>
          <div class="stat-sub">Active in last week</div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-label">MAU (Last 30d)</div>
          <div class="stat-value">${u.mau}</div>
          <div class="stat-sub">Active in last month</div>
        </div>
        <div class="stat-card stat-primary">
          <div class="stat-label">QAU (Last 90d)</div>
          <div class="stat-value">${u.qau}</div>
          <div class="stat-sub">Active in last quarter</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">Activation Rate</div>
          <div class="stat-value">${u.activationRate}%</div>
          <div class="stat-sub">${u.totalEverActive} of ${u.totalUsers} users</div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-label">7-day Retention</div>
          <div class="stat-value">${u.retentionRate}%</div>
          <div class="stat-sub">Of activated users</div>
        </div>
        <div class="stat-card stat-primary">
          <div class="stat-label">Total API Calls</div>
          <div class="stat-value">${(u.totalApiCalls || 0).toLocaleString("en-IN")}</div>
          <div class="stat-sub">Lifetime tracked</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">Total Users</div>
          <div class="stat-value">${u.totalUsers}</div>
          <div class="stat-sub">Ever signed up</div>
        </div>
      `;
    }

    if (chartEl) {
      const days = u.dailyActivity || [];
      if (!days.length) {
        chartEl.innerHTML = `<div style="color:var(--muted);font-size:12px;font-style:italic;padding:14px 0;">No activity recorded yet</div>`;
      } else {
        const max = Math.max(...days.map((d) => d.count), 1);
        chartEl.innerHTML = days
          .map((d) => {
            const h = Math.max(8, Math.round((d.count / max) * 80));
            const dayLabel = d._id.slice(5); // MM-DD
            return `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;" title="${d._id}: ${d.count} active">
                <div style="width:100%;height:${h}px;background:linear-gradient(180deg,var(--teal),var(--teal-light));border-radius:4px 4px 0 0;"></div>
                <div style="font-size:9.5px;color:var(--muted);font-weight:600">${dayLabel}</div>
                <div style="font-size:10px;color:var(--text);font-weight:700">${d.count}</div>
              </div>
            `;
          })
          .join("");
      }
    }

    if (topUsersEl) {
      const top = u.topUsers || [];
      if (!top.length) {
        topUsersEl.innerHTML = `<div style="color:var(--muted);font-style:italic;">No active users yet</div>`;
      } else {
        topUsersEl.innerHTML = top
          .map(
            (user, i) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:${i < top.length - 1 ? "1px solid var(--border)" : "none"};">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;color:var(--text);text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${escapeHtml(user.email || "—")}</div>
                  <div style="font-size:11px;color:var(--muted);">${escapeHtml(user.role || "USER")}${user.firmId?.handle ? " · @" + escapeHtml(user.firmId.handle) : ""}</div>
                </div>
                <div style="font-weight:700;color:var(--teal-dark);font-size:13px;margin-left:8px;">${user.totalApiCalls}</div>
              </div>
            `
          )
          .join("");
      }
    }
  } catch (err) {
    console.error("Usage stats error:", err);
    if (statusEl) statusEl.textContent = err.message || "Failed to load usage stats.";
  }
}

// ─── Dashboard Stats ────────────────────────────────────────────────
async function loadDashboardStats() {
  const grid = qs("statsGrid");
  const statusEl = qs("statsLoadingStatus");
  const taskBreakdownEl = qs("taskStatusBreakdown");
  const serviceBreakdownEl = qs("serviceBreakdown");

  try {
    const data = await api("/super/dashboard-stats");
    if (!data.ok) throw new Error("Failed to load stats");

    const s = data.stats;
    if (statusEl) statusEl.textContent = "";

    // Main stats cards
    grid.innerHTML = `
      <div class="stat-card stat-primary">
        <div class="stat-label">Total Users</div>
        <div class="stat-value">${s.users.total}</div>
        <div class="stat-sub">Active: ${s.users.active} · Inactive: ${s.users.inactive}</div>
      </div>
      <div class="stat-card stat-gold">
        <div class="stat-label">Total Firms</div>
        <div class="stat-value">${s.firms.total}</div>
        <div class="stat-sub">Active: ${s.firms.active}</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-label">Total Tasks</div>
        <div class="stat-value">${s.tasks.active}</div>
        <div class="stat-sub">All time: ${s.tasks.total}</div>
      </div>
      <div class="stat-card stat-danger">
        <div class="stat-label">Pending Admins</div>
        <div class="stat-value">${s.users.pendingAdmins}</div>
        <div class="stat-sub">Awaiting approval</div>
      </div>
      <div class="stat-card stat-primary">
        <div class="stat-label">Firm Admins</div>
        <div class="stat-value">${s.users.firmAdmins}</div>
        <div class="stat-sub">Active firm admins</div>
      </div>
      <div class="stat-card stat-gold">
        <div class="stat-label">Premium Firms</div>
        <div class="stat-value">${s.firms.premium}</div>
        <div class="stat-sub">Free: ${s.firms.free}</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-label">Reminders</div>
        <div class="stat-value">${s.reminders.total}</div>
        <div class="stat-sub">Total scheduled</div>
      </div>
      <div class="stat-card stat-primary">
        <div class="stat-label">Recent (7d)</div>
        <div class="stat-value">${s.users.recentSignups}</div>
        <div class="stat-sub">New signups · ${s.tasks.recentTasks} tasks</div>
      </div>
    `;

    // Task status breakdown
    const statusColors = {
      NOT_STARTED: "bg-secondary", WAITING_DOCS: "bg-warning",
      IN_PROGRESS: "bg-primary", FILED: "bg-success", CLOSED: "bg-dark",
    };
    if (taskBreakdownEl) {
      const breakdown = s.tasks.statusBreakdown || [];
      if (!breakdown.length) {
        taskBreakdownEl.innerHTML = '<span class="text-muted small">No tasks yet</span>';
      } else {
        taskBreakdownEl.innerHTML = breakdown.map(item =>
          `<span class="badge ${statusColors[item._id] || 'bg-secondary'}">${escapeHtml(item._id)}: ${item.count}</span>`
        ).join("");
      }
    }

    // Service breakdown
    if (serviceBreakdownEl) {
      const services = s.tasks.serviceBreakdown || [];
      if (!services.length) {
        serviceBreakdownEl.innerHTML = '<span class="text-muted small">No tasks yet</span>';
      } else {
        serviceBreakdownEl.innerHTML = services.map(item =>
          `<span class="badge bg-primary">${escapeHtml(item._id)}: ${item.count}</span>`
        ).join("");
      }
    }

  } catch (err) {
    console.error("Dashboard stats error:", err);
    if (statusEl) statusEl.textContent = err.message || "Failed to load stats.";
  }
}

// ─── Pending Admins ─────────────────────────────────────────────────
async function loadPendingAdmins() {
  const data = await api("/super/pending-admins");
  return data.users || [];
}

async function approveAdmin(userId) {
  return api(`/super/approve-admin/${encodeURIComponent(userId)}`, { method: "POST" });
}

async function revokeAdmin(userId) {
  return api(`/super/revoke-admin/${encodeURIComponent(userId)}`, { method: "POST" });
}

function renderPendingRow(user) {
  const created = user.createdAt ? new Date(user.createdAt).toLocaleString() : "—";
  const firmId = typeof user.firmId === "object" && user.firmId !== null
    ? user.firmId.handle || user.firmId._id || "—"
    : user.firmId || "—";

  return `
    <tr data-id="${escapeHtml(user._id)}">
      <td>${escapeHtml(user.email || "—")}</td>
      <td>${escapeHtml(user.name || "—")}</td>
      <td>${escapeHtml(firmId)}</td>
      <td>${escapeHtml(created)}</td>
      <td>
        <button class="btn btn-sm btn-success approve-btn" type="button">Approve</button>
        <button class="btn btn-sm btn-danger revoke-btn ms-1" type="button">Revoke</button>
      </td>
    </tr>
  `;
}

function attachPendingHandlers(tbody) {
  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest("tr");
    if (!row) return;
    const userId = row.getAttribute("data-id");
    if (!userId) return;

    if (btn.classList.contains("approve-btn")) {
      btn.disabled = true;
      btn.textContent = "Approving...";
      try {
        await approveAdmin(userId);
        row.classList.add("table-success");
        row.querySelectorAll("button").forEach(b => { b.disabled = true; });
        btn.textContent = "Approved ✓";
      } catch (err) {
        alert(err.message || "Failed to approve");
        btn.disabled = false;
        btn.textContent = "Approve";
      }
    }

    if (btn.classList.contains("revoke-btn")) {
      btn.disabled = true;
      btn.textContent = "Revoking...";
      try {
        await revokeAdmin(userId);
        row.classList.add("table-warning");
        row.querySelectorAll("button").forEach(b => { b.disabled = true; });
        btn.textContent = "Revoked";
      } catch (err) {
        alert(err.message || "Failed to revoke");
        btn.disabled = false;
        btn.textContent = "Revoke";
      }
    }
  });
}

// ─── Firms & Plans ──────────────────────────────────────────────────
async function loadFirms() {
  const data = await api("/super/firms");
  return data.firms || [];
}

async function loadFirmUsers(firmId) {
  return api(`/super/firms/${encodeURIComponent(firmId)}/users`);
}

async function updateFirmPlanApi(firmId, payload) {
  const data = await api(`/super/firms/${encodeURIComponent(firmId)}/plan`, { method: "PATCH", body: payload });
  return data.firm;
}

async function updateFirmUserApi(firmId, userId, payload) {
  const data = await api(`/super/firms/${encodeURIComponent(firmId)}/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: payload });
  return data.user;
}

async function deleteFirmUserApi(firmId, userId) {
  await api(`/super/firms/${encodeURIComponent(firmId)}/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

async function deleteFirmApi(firmId) {
  await api(`/super/firms/${encodeURIComponent(firmId)}`, { method: "DELETE" });
}

function renderFirmRow(firm) {
  const planBadge = firm.planType === "PREMIUM"
    ? `<span class="badge good">PREMIUM</span>`
    : `<span class="badge bg-secondary">FREE</span>`;
  const expiryText = firm.planExpiry ? new Date(firm.planExpiry).toLocaleDateString() : "—";
  const activeBadge = firm.isActive
    ? `<span class="badge good">Active</span>`
    : `<span class="badge warn">Inactive</span>`;
  const ownerEmail = firm.owner?.email || "—";
  const ownerName = firm.owner?.name || "";
  const ownerDisplay = ownerName
    ? `${escapeHtml(ownerName)}<br><span class="text-muted small">${escapeHtml(ownerEmail)}</span>`
    : escapeHtml(ownerEmail);

  return `
    <tr data-firm-id="${escapeHtml(firm._id)}">
      <td><strong>${escapeHtml(firm.displayName || "—")}</strong></td>
      <td><code>@${escapeHtml(firm.handle || "—")}</code></td>
      <td>${ownerDisplay}</td>
      <td>${planBadge}</td>
      <td>${escapeHtml(expiryText)}</td>
      <td>${activeBadge}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary me-1 firm-users-btn" type="button">Users</button>
        <button class="btn btn-sm btn-outline-secondary me-1 firm-plan-btn" type="button">Edit Plan</button>
        <button class="btn btn-sm btn-outline-danger firm-delete-btn" type="button">Delete</button>
      </td>
    </tr>
  `;
}

function renderFirmUsersRows(firmId, users) {
  if (!users.length) {
    return `<tr><td colspan="7" class="text-center text-muted small">No users in this firm yet.</td></tr>`;
  }
  return users.map(u => {
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
    const isFirmAdmin = u.role === "FIRM_ADMIN";
    const activeBadge = u.isActive ? `<span class="badge good">Yes</span>` : `<span class="badge warn">No</span>`;
    const roleBadge = isFirmAdmin ? `<span class="badge good">FIRM_ADMIN</span>` : `<span class="badge bg-secondary">USER</span>`;

    return `
      <tr data-user-id="${escapeHtml(u._id)}" data-firm-id="${escapeHtml(firmId)}">
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${escapeHtml(u.name || "—")}</td>
        <td>${roleBadge}</td>
        <td>${escapeHtml(u.accountType || "—")}</td>
        <td>${activeBadge}</td>
        <td>${escapeHtml(created)}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary me-1 firm-user-toggle-admin" type="button">
            ${isFirmAdmin ? "Remove Admin" : "Make Admin"}
          </button>
          <button class="btn btn-sm btn-outline-secondary me-1 firm-user-toggle-active" type="button">
            ${u.isActive ? "Deactivate" : "Activate"}
          </button>
          <button class="btn btn-sm btn-outline-danger firm-user-delete" type="button">Delete</button>
        </td>
      </tr>
    `;
  }).join("");
}

function attachFirmHandlers() {
  const tbody = qs("firmsBody");
  if (!tbody) return;

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest("tr");
    if (!row) return;
    const firmId = row.getAttribute("data-firm-id");
    if (!firmId) return;

    if (btn.classList.contains("firm-users-btn")) {
      await handleViewFirmUsers(firmId);
      return;
    }
    if (btn.classList.contains("firm-plan-btn")) {
      await handleEditFirmPlan(firmId, row);
      return;
    }
    if (btn.classList.contains("firm-delete-btn")) {
      await handleDeleteFirm(firmId, row);
    }
  });
}

async function handleViewFirmUsers(firmId) {
  const statusEl = qs("firmUsersStatus");
  const bodyEl = qs("firmUsersBody");
  const titleEl = qs("firmUsersTitle");

  if (statusEl) statusEl.textContent = "Loading users…";
  if (bodyEl) bodyEl.innerHTML = "";

  // Open modal first so user sees loading state
  openModal();

  try {
    const data = await loadFirmUsers(firmId);
    if (titleEl) titleEl.textContent = `Users in ${data.firm.displayName} (@${data.firm.handle})`;
    if (bodyEl) {
      bodyEl.innerHTML = renderFirmUsersRows(firmId, data.users || []);
      attachFirmUsersHandlers();
    }
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Failed to load users.";
  }
}

// ─── Custom Modal ───────────────────────────────────────────────────
function openModal() {
  const modalEl = qs("firmUsersModal");
  if (!modalEl) return;
  modalEl.classList.add("show");
  modalEl.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const modalEl = qs("firmUsersModal");
  if (!modalEl) return;
  modalEl.classList.remove("show");
  modalEl.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function bindModalCloseHandlers() {
  qs("firmUsersCloseBtn")?.addEventListener("click", closeModal);
  qs("firmUsersCloseBtn2")?.addEventListener("click", closeModal);

  const modalEl = qs("firmUsersModal");
  if (modalEl) {
    modalEl.addEventListener("click", (e) => {
      // Click on backdrop closes modal
      if (e.target === modalEl) closeModal();
    });
  }

  // ESC key closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function attachFirmUsersHandlers() {
  const tbody = qs("firmUsersBody");
  if (!tbody) return;

  tbody.onclick = async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest("tr");
    if (!row) return;
    const firmId = row.getAttribute("data-firm-id");
    const userId = row.getAttribute("data-user-id");
    if (!firmId || !userId) return;

    if (btn.classList.contains("firm-user-toggle-admin")) {
      const isCurrentlyAdmin = row.innerHTML.includes("FIRM_ADMIN");
      const newRole = isCurrentlyAdmin ? "USER" : "FIRM_ADMIN";
      const confirmMsg = isCurrentlyAdmin ? "Remove this user's FIRM_ADMIN role?" : "Make this user FIRM_ADMIN?";
      if (!window.confirm(confirmMsg)) return;

      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        await updateFirmUserApi(firmId, userId, { role: newRole });
        // Refresh modal
        await handleViewFirmUsers(firmId);
      } catch (err) {
        alert(err.message || "Failed to update role.");
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains("firm-user-toggle-active")) {
      const isCurrentlyActive = row.innerHTML.includes(">Yes<");
      const newActive = !isCurrentlyActive;
      const confirmMsg = newActive ? "Activate this user?" : "Deactivate this user?";
      if (!window.confirm(confirmMsg)) return;

      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        await updateFirmUserApi(firmId, userId, { isActive: newActive });
        await handleViewFirmUsers(firmId);
      } catch (err) {
        alert(err.message || "Failed to update.");
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains("firm-user-delete")) {
      if (!window.confirm("Delete this user permanently? This cannot be undone.")) return;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        await deleteFirmUserApi(firmId, userId);
        row.remove();
      } catch (err) {
        alert(err.message || "Failed to delete user.");
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    }
  };
}

async function handleEditFirmPlan(firmId, rowEl) {
  const currentPlanCell = rowEl.querySelector("td:nth-child(4)");
  const currentExpiryCell = rowEl.querySelector("td:nth-child(5)");
  const currentActiveCell = rowEl.querySelector("td:nth-child(6)");

  const currentPlanText = currentPlanCell?.innerText.includes("PREMIUM") ? "PREMIUM" : "FREE";
  const currentExpiryText = currentExpiryCell?.innerText.trim() || "";
  const currentActive = currentActiveCell?.innerText.toLowerCase().includes("active");

  const planInput = window.prompt("Plan type (FREE or PREMIUM):", currentPlanText);
  if (!planInput) return;
  const planType = planInput.toUpperCase().trim();
  if (!["FREE", "PREMIUM"].includes(planType)) { alert("Must be FREE or PREMIUM."); return; }

  let planExpiry = null;
  if (planType === "PREMIUM") {
    const expiryInput = window.prompt("Plan expiry (YYYY-MM-DD), blank for no expiry:", currentExpiryText);
    if (expiryInput) {
      const d = new Date(expiryInput);
      if (Number.isNaN(d.getTime())) { alert("Invalid date. Use YYYY-MM-DD."); return; }
      planExpiry = d.toISOString();
    }
  }

  const activeInput = window.prompt("Is firm active? (yes/no):", currentActive ? "yes" : "no");
  const isActive = typeof activeInput === "string" && activeInput.trim().toLowerCase().startsWith("y");

  try {
    const updated = await updateFirmPlanApi(firmId, { planType, planExpiry, isActive });
    rowEl.outerHTML = renderFirmRow(updated);
  } catch (err) {
    alert(err.message || "Failed to update plan.");
  }
}

async function handleDeleteFirm(firmId, rowEl) {
  if (!window.confirm("Delete this firm? All linked users will be detached.")) return;
  const text = window.prompt("Type DELETE to confirm:", "");
  if (text !== "DELETE") { alert("Cancelled (you did not type DELETE)."); return; }

  try {
    await deleteFirmApi(firmId);
    rowEl.remove();
  } catch (err) {
    alert(err.message || "Failed to delete firm.");
  }
}

// ─── Init ───────────────────────────────────────────────────────────
async function initSuperPage() {
  if (!qs("superLogoutBtn")) return;

  const isAuthenticated = await ensureSuperAdminAuth();
  if (!isAuthenticated) return;

  const token = getToken();
  if (!token) { window.location.href = "/index.html"; return; }

  // Logout
  qs("superLogoutBtn").addEventListener("click", () => {
    clearToken();
    window.location.href = "/index.html";
  });

  // Back to admin
  qs("backToAdminBtn")?.addEventListener("click", () => {
    window.location.href = "/admin/admin.html";
  });

  // Modal close handlers
  bindModalCloseHandlers();

  try {
    const me = await loadMe();
    if (!requireSuperAdmin(me)) { window.location.href = "/admin/admin.html"; return; }
    if (qs("superEmail")) qs("superEmail").textContent = me.email || "—";

    // Load app config, usage analytics, dashboard stats — all in parallel
    bindAppConfigHandlers();
    await Promise.all([loadAppConfigSection(), loadUsageStats(), loadDashboardStats()]);

    // Load pending admins
    const pendingTbody = qs("pendingAdminsBody");
    const pendingStatus = qs("pendingStatus");
    try {
      const pending = await loadPendingAdmins();
      if (!pending.length) {
        if (pendingTbody) pendingTbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No pending requests.</td></tr>`;
        if (pendingStatus) pendingStatus.textContent = "";
      } else {
        if (pendingTbody) { pendingTbody.innerHTML = pending.map(renderPendingRow).join(""); attachPendingHandlers(pendingTbody); }
        if (pendingStatus) pendingStatus.textContent = "";
      }
    } catch (err) {
      if (pendingStatus) pendingStatus.textContent = err.message || "Failed to load.";
    }

    // Load firms
    const firmsBody = qs("firmsBody");
    const firmsStatus = qs("firmsStatus");
    try {
      const firms = await loadFirms();
      if (!firms.length) {
        if (firmsBody) firmsBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No firms found.</td></tr>`;
        if (firmsStatus) firmsStatus.textContent = "";
      } else {
        if (firmsBody) { firmsBody.innerHTML = firms.map(renderFirmRow).join(""); attachFirmHandlers(); }
        if (firmsStatus) firmsStatus.textContent = "";
      }
    } catch (err) {
      if (firmsStatus) firmsStatus.textContent = err.message || "Failed to load firms.";
    }

  } catch (err) {
    console.error(err);
    const statusEl = qs("statsLoadingStatus");
    if (statusEl) statusEl.textContent = err.message || "Failed to load dashboard.";
  }
}

document.addEventListener("DOMContentLoaded", () => { initSuperPage(); });
