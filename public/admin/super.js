// public/admin/super.js

const API_BASE = "/api";
const TOKEN_KEY = "capro_admin_jwt";

function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, opts = {}) {
  const token = getToken();

  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts.headers || {}
  );

  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg =
      data?.error || data?.message || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function requireSuperAdmin(user) {
  return user.role === "SUPER_ADMIN";
}

async function loadMe() {
  const me = await api("/auth/me");
  return me.user;
}

// ---------- Pending admins ----------

async function loadPendingAdmins() {
  const data = await api("/super/pending-admins");
  return data.users || [];
}

async function approveAdmin(userId) {
  return api(`/super/approve-admin/${encodeURIComponent(userId)}`, {
    method: "POST",
  });
}

async function revokeAdmin(userId) {
  return api(`/super/revoke-admin/${encodeURIComponent(userId)}`, {
    method: "POST",
  });
}

function renderPendingRow(user) {
  const created = user.createdAt
    ? new Date(user.createdAt).toLocaleString()
    : "—";

  const firmId =
    typeof user.firmId === "object" && user.firmId !== null
      ? user.firmId.handle || user.firmId._id || "—"
      : user.firmId || "—";

  return `
    <tr data-id="${escapeHtml(user._id)}">
      <td>${escapeHtml(user.email || "—")}</td>
      <td>${escapeHtml(user.name || "—")}</td>
      <td>${escapeHtml(firmId)}</td>
      <td>${escapeHtml(created)}</td>
      <td>
        <button class="btn btn-sm btn-success approve-btn">Approve</button>
        <button class="btn btn-sm btn-danger revoke-btn ms-1">Revoke</button>
      </td>
    </tr>
  `;
}

function attachPendingHandlers(tbody) {
  tbody.addEventListener("click", async (e) => {
    const btn = e.target;
    const row = btn.closest("tr");
    if (!row) return;

    const userId = row.getAttribute("data-id");
    if (!userId) return;

    if (btn.classList.contains("approve-btn")) {
      btn.disabled = true;
      try {
        await approveAdmin(userId);
        row.classList.add("table-success");
        row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      } catch (err) {
        alert(err.message || "Failed to approve");
        btn.disabled = false;
      }
    }

    if (btn.classList.contains("revoke-btn")) {
      btn.disabled = true;
      try {
        await revokeAdmin(userId);
        row.classList.add("table-warning");
        row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      } catch (err) {
        alert(err.message || "Failed to revoke");
        btn.disabled = false;
      }
    }
  });
}

// ---------- Firms & plans ----------

async function loadFirms() {
  const data = await api("/super/firms");
  return data.firms || [];
}

async function loadFirmUsers(firmId) {
  const data = await api(`/super/firms/${encodeURIComponent(firmId)}/users`);
  return data;
}

async function updateFirmPlanApi(firmId, payload) {
  const data = await api(`/super/firms/${encodeURIComponent(firmId)}/plan`, {
    method: "PATCH",
    body: payload,
  });
  return data.firm;
}

async function updateFirmUserApi(firmId, userId, payload) {
  const data = await api(
    `/super/firms/${encodeURIComponent(firmId)}/users/${encodeURIComponent(
      userId
    )}`,
    {
      method: "PATCH",
      body: payload,
    }
  );
  return data.user;
}

async function deleteFirmUserApi(firmId, userId) {
  await api(
    `/super/firms/${encodeURIComponent(firmId)}/users/${encodeURIComponent(
      userId
    )}`,
    {
      method: "DELETE",
    }
  );
}

async function deleteFirmApi(firmId) {
  await api(`/super/firms/${encodeURIComponent(firmId)}`, {
    method: "DELETE",
  });
}

function renderFirmRow(firm) {
  const planBadge =
    firm.planType === "PREMIUM"
      ? `<span class="badge good">PREMIUM</span>`
      : `<span class="badge">FREE</span>`;

  const expiryText = firm.planExpiry
    ? new Date(firm.planExpiry).toLocaleDateString()
    : "—";

  const activeBadge = firm.isActive
    ? `<span class="badge good">Active</span>`
    : `<span class="badge warn">Inactive</span>`;

  const ownerEmail = firm.owner?.email || "—";
  const ownerName = firm.owner?.name || "";

  const ownerDisplay = ownerName
    ? `${escapeHtml(ownerName)}<br><span class="text-muted small">${escapeHtml(
        ownerEmail
      )}</span>`
    : escapeHtml(ownerEmail);

  return `
    <tr data-firm-id="${escapeHtml(firm._id)}">
      <td>${escapeHtml(firm.displayName || "—")}</td>
      <td>${escapeHtml(firm.handle || "—")}</td>
      <td>${ownerDisplay}</td>
      <td>${planBadge}</td>
      <td>${escapeHtml(expiryText)}</td>
      <td>${activeBadge}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary me-1 firm-users-btn">
          View users
        </button>
        <button class="btn btn-sm btn-outline-secondary me-1 firm-plan-btn">
          Edit plan
        </button>
        <button class="btn btn-sm btn-outline-danger firm-delete-btn">
          Delete firm
        </button>
      </td>
    </tr>
  `;
}

function renderFirmUsersRows(firmId, users) {
  if (!users.length) {
    return `
      <tr>
        <td colspan="7" class="text-center text-muted small">
          No users in this firm yet.
        </td>
      </tr>
    `;
  }

  return users
    .map((u) => {
      const created = u.createdAt
        ? new Date(u.createdAt).toLocaleDateString()
        : "—";
      const isFirmAdmin = u.role === "FIRM_ADMIN";
      const activeBadge = u.isActive
        ? `<span class="badge good">Yes</span>`
        : `<span class="badge warn">No</span>`;

      const roleBadge = isFirmAdmin
        ? `<span class="badge good">FIRM_ADMIN</span>`
        : `<span class="badge">USER</span>`;

      return `
        <tr data-user-id="${escapeHtml(u._id)}" data-firm-id="${escapeHtml(
        firmId
      )}">
          <td>${escapeHtml(u.email || "—")}</td>
          <td>${escapeHtml(u.name || "—")}</td>
          <td>${roleBadge}</td>
          <td>${escapeHtml(u.accountType || "—")}</td>
          <td>${activeBadge}</td>
          <td>${escapeHtml(created)}</td>
          <td>
            <button class="btn btn-sm btn-outline-primary me-1 firm-user-toggle-admin">
              ${isFirmAdmin ? "Remove admin" : "Make admin"}
            </button>
            <button class="btn btn-sm btn-outline-warning me-1 firm-user-toggle-active">
              ${u.isActive ? "Deactivate" : "Activate"}
            </button>
            <button class="btn btn-sm btn-outline-danger firm-user-delete">
              Delete
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
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

  try {
    const data = await loadFirmUsers(firmId);
    if (titleEl) {
      titleEl.textContent = `Users in ${data.firm.displayName} (@${data.firm.handle})`;
    }
    if (bodyEl) {
      bodyEl.innerHTML = renderFirmUsersRows(firmId, data.users || []);
      attachFirmUsersHandlers();
    }
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || "Failed to load users.";
    }
  }

  const modalEl = document.getElementById("firmUsersModal");
  if (modalEl && window.bootstrap) {
    const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
  }
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

    // Toggle admin
    if (btn.classList.contains("firm-user-toggle-admin")) {
      const isCurrentlyAdmin = row.innerHTML.includes("FIRM_ADMIN");
      const newRole = isCurrentlyAdmin ? "USER" : "FIRM_ADMIN";

      const confirmMsg = isCurrentlyAdmin
        ? "Remove this user's FIRM_ADMIN role?"
        : "Make this user FIRM_ADMIN for this firm?";
      if (!window.confirm(confirmMsg)) return;

      btn.disabled = true;
      try {
        const updated = await updateFirmUserApi(firmId, userId, {
          role: newRole,
        });

        row.outerHTML = renderFirmUsersRows(firmId, [
          {
            _id: updated.id,
            email: row.children[0].innerText,
            name: row.children[1].innerText,
            role: updated.role,
            accountType: row.children[3].innerText,
            isActive: updated.isActive,
            createdAt: null,
          },
        ]);
      } catch (err) {
        alert(err.message || "Failed to update role.");
        btn.disabled = false;
      }
      return;
    }

    // Toggle active (temporary suspend)
    if (btn.classList.contains("firm-user-toggle-active")) {
      const isCurrentlyActive = row.innerHTML.includes(">Yes<");
      const newActive = !isCurrentlyActive;

      const confirmMsg = newActive
        ? "Activate this user?"
        : "Deactivate this user (temporary suspension)?";
      if (!window.confirm(confirmMsg)) return;

      btn.disabled = true;
      try {
        const updated = await updateFirmUserApi(firmId, userId, {
          isActive: newActive,
        });

        row.outerHTML = renderFirmUsersRows(firmId, [
          {
            _id: updated.id,
            email: row.children[0].innerText,
            name: row.children[1].innerText,
            role: updated.role,
            accountType: row.children[3].innerText,
            isActive: updated.isActive,
            createdAt: null,
          },
        ]);
      } catch (err) {
        alert(err.message || "Failed to update active state.");
        btn.disabled = false;
      }
      return;
    }

    // Delete user
    if (btn.classList.contains("firm-user-delete")) {
      if (
        !window.confirm(
          "Delete this user from database? This cannot be undone."
        )
      )
        return;

      btn.disabled = true;
      try {
        await deleteFirmUserApi(firmId, userId);
        row.remove();
      } catch (err) {
        alert(err.message || "Failed to delete user.");
        btn.disabled = false;
      }
    }
  };
}

async function handleEditFirmPlan(firmId, rowEl) {
  const currentPlanCell = rowEl.querySelector("td:nth-child(4)");
  const currentExpiryCell = rowEl.querySelector("td:nth-child(5)");
  const currentActiveCell = rowEl.querySelector("td:nth-child(6)");

  const currentPlanText = currentPlanCell?.innerText.includes("PREMIUM")
    ? "PREMIUM"
    : "FREE";

  const currentExpiryText = currentExpiryCell?.innerText.trim() || "";
  const currentActive = currentActiveCell?.innerText
    .toLowerCase()
    .includes("active");

  const planInput = window.prompt(
    "Plan for this firm:\n- Type FREE for free plan\n- Type PREMIUM for paid plan",
    currentPlanText
  );
  if (!planInput) return;

  const planType = planInput.toUpperCase().trim();
  if (!["FREE", "PREMIUM"].includes(planType)) {
    alert("Plan must be FREE or PREMIUM.");
    return;
  }

  let planExpiry = null;
  if (planType === "PREMIUM") {
    const expiryInput = window.prompt(
      "Plan expiry (YYYY-MM-DD), or leave blank for no expiry:",
      currentExpiryText
    );
    if (expiryInput) {
      const d = new Date(expiryInput);
      if (Number.isNaN(d.getTime())) {
        alert("Invalid date format. Use YYYY-MM-DD.");
        return;
      }
      planExpiry = d.toISOString();
    }
  }

  const activeInput = window.prompt(
    "Is this firm active? (yes/no):",
    currentActive ? "yes" : "no"
  );
  const isActive =
    typeof activeInput === "string" &&
    activeInput.trim().toLowerCase().startsWith("y");

  try {
    const updated = await updateFirmPlanApi(firmId, {
      planType,
      planExpiry,
      isActive,
    });

    rowEl.outerHTML = renderFirmRow(updated);
  } catch (err) {
    alert(err.message || "Failed to update plan.");
  }
}

async function handleDeleteFirm(firmId, rowEl) {
  const firstConfirm = window.confirm(
    "Are you sure you want to delete this firm?\nAll linked users will be detached from this firm."
  );
  if (!firstConfirm) return;

  const text = window.prompt(
    "Type DELETE in capital letters to permanently delete this firm:",
    ""
  );
  if (text !== "DELETE") {
    alert("Firm deletion cancelled (you did not type DELETE).");
    return;
  }

  try {
    await deleteFirmApi(firmId);
    rowEl.remove();
  } catch (err) {
    alert(err.message || "Failed to delete firm.");
  }
}

// ---------- Init ----------

async function initSuperPage() {
  if (!qs("superLogoutBtn")) return;

  const token = getToken();
  if (!token) {
    window.location.href = "./index.html";
    return;
  }

  qs("superLogoutBtn")?.addEventListener("click", () => {
    clearToken();
    window.location.href = "./index.html";
  });

  qs("backToAdminBtn")?.addEventListener("click", () => {
    window.location.href = "./admin.html";
  });

  try {
    const me = await loadMe();

    if (!requireSuperAdmin(me)) {
      window.location.href = "./admin.html";
      return;
    }

    if (qs("superEmail")) qs("superEmail").textContent = me.email || "—";

    // Pending admins
    const pendingTbody = qs("pendingAdminsBody");
    const pendingStatus = qs("pendingStatus");

    try {
      const pending = await loadPendingAdmins();
      if (!pending.length) {
        if (pendingTbody) {
          pendingTbody.innerHTML = `
            <tr>
              <td colspan="5" class="text-center text-muted">
                No pending firm admin requests.
              </td>
            </tr>
          `;
        }
        if (pendingStatus) pendingStatus.textContent = "";
      } else {
        if (pendingTbody) {
          pendingTbody.innerHTML = pending.map(renderPendingRow).join("");
          attachPendingHandlers(pendingTbody);
        }
        if (pendingStatus) pendingStatus.textContent = "";
      }
    } catch (err) {
      if (pendingStatus) {
        pendingStatus.textContent =
          err.message || "Failed to load pending admins.";
      }
    }

    // Firms & plans
    const firmsBody = qs("firmsBody");
    const firmsStatus = qs("firmsStatus");

    try {
      const firms = await loadFirms();
      if (!firms.length) {
        if (firmsBody) {
          firmsBody.innerHTML = `
            <tr>
              <td colspan="7" class="text-center text-muted">
                No firms found.
              </td>
            </tr>
          `;
        }
        if (firmsStatus) firmsStatus.textContent = "";
      } else {
        if (firmsBody) {
          firmsBody.innerHTML = firms.map(renderFirmRow).join("");
          attachFirmHandlers();
        }
        if (firmsStatus) firmsStatus.textContent = "";
      }
    } catch (err) {
      if (firmsStatus) {
        firmsStatus.textContent = err.message || "Failed to load firms.";
      }
    }
  } catch (err) {
    console.error(err);
    const statusEl = qs("pendingStatus");
    if (statusEl) {
      statusEl.textContent =
        err.message || "Failed to load super admin dashboard.";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initSuperPage();
});
