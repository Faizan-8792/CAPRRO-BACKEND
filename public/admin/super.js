// public/admin/super.js — Super Admin Dashboard

const API_BASE = "https://api.caprotoolkit.in/api";
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
// Holds the last-loaded desktop-release draft so the notify handler's re-notify warning (see
// bindAppConfigHandlers) can tell whether the version currently in the form was already announced,
// without a fresh network round-trip on every keystroke.
let lastDesktopReleaseDraft = null;

// Order mirrors DEFAULT_FEATURE_FLAGS in src/models/AppConfig.js exactly -- the server rejects
// any key outside that set with "Unknown feature flags", so this list must stay in lockstep with
// the real constant rather than being re-derived here.
const FEATURE_FLAG_KEYS = [
  "zeroApprovalFirmCreation",
  "unrestrictedTasks",
  "fullReminderOffsets",
  "reliableReminderDelivery",
  "fullTabWorkspace",
  "sampleWorkspace",
  "homeWorkspace",
  "clientComplianceProfile",
  "complianceGenerationShadow",
  "complianceGenerationLive",
  "gstReconciliation",
  "tdsHealth",
  "noticeCases",
  "assuranceEngagements",
  "filingDashboard",
  "teamWorkload",
  "auditWorkingPapers",
  "dailyDigest",
  "weeklySummary",
];

// Last-loaded server state for feature flags, so Save can diff against it and send only the
// keys the operator actually changed (mirrors lastDesktopReleaseDraft's role above).
let lastFeatureFlags = null;

function featureFlagCheckbox(key) {
  return qs(`flag-${key}`);
}

// The public GET /api/app-config response always merges featureFlags over DEFAULT_FEATURE_FLAGS
// server-side (see getAppConfig / AppConfigSchema.statics.getFeatureFlags), so every key is
// always present here -- no per-key fallback is needed.
function loadFeatureFlagsSection(featureFlags) {
  const flags = featureFlags || {};
  lastFeatureFlags = { ...flags };
  for (const key of FEATURE_FLAG_KEYS) {
    const box = featureFlagCheckbox(key);
    if (box) box.checked = flags[key] === true;
  }
}

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

    loadFeatureFlagsSection(c.featureFlags);
  } catch (err) {
    console.warn("App config load fail:", err.message);
  }

  // Deliberately a SEPARATE call to the super-only draft route below, NOT the public GET above --
  // a saved-but-unannounced draft is served as null there on purpose (see publishableDesktopRelease
  // in appconfig.controller.js), so this is the only way the panel can see what is actually saved.
  try {
    const dr = await api("/app-config/desktop-release");
    const d = dr.desktopRelease || {};
    lastDesktopReleaseDraft = d;

    if (qs("desktopLatestVersion")) qs("desktopLatestVersion").value = d.latestVersion || "";
    if (qs("desktopMinSupportedVersion")) qs("desktopMinSupportedVersion").value = d.minSupportedVersion || "";
    if (qs("desktopDownloadUrl")) qs("desktopDownloadUrl").value = d.downloadUrl || "";
    if (qs("desktopSha256")) qs("desktopSha256").value = d.sha256 || "";
    if (qs("desktopSizeBytes")) qs("desktopSizeBytes").value = d.sizeBytes || "";
    if (qs("desktopReleaseNotes")) qs("desktopReleaseNotes").value = d.releaseNotes || "";
    if (qs("desktopMandatory")) qs("desktopMandatory").checked = d.mandatory === true;
    // Strict === true, unlike welcomeEnabled's "!== false" above: desktopRelease.enabled defaults
    // to false (AppConfig.js), not true, so a missing/undefined value here must read as unchecked.
    if (qs("desktopEnabled")) qs("desktopEnabled").checked = d.enabled === true;

    renderDesktopReleaseLive(d);
  } catch (err) {
    console.warn("Desktop release draft load fail:", err.message);
  }
}

// Renders the "what's actually live" readout above the desktop-release form. Every server-supplied
// string is passed through escapeHtml before it touches innerHTML -- never trust the draft's own
// text (release notes, urls, ids) to be safe markup.
function renderDesktopReleaseLive(d) {
  const el = qs("desktopReleaseLive");
  if (!el) return;
  const draft = d || {};
  if (draft.announcementId) {
    const when = draft.announcedAt ? new Date(draft.announcedAt).toLocaleString() : "an unknown time";
    const shortId = String(draft.announcementId).slice(0, 8);
    el.innerHTML =
      `Currently announced: <b>${escapeHtml(draft.latestVersion || "—")}</b> -- announced ${escapeHtml(when)} -- id ${escapeHtml(shortId)}...`;
  } else if (draft.latestVersion || draft.downloadUrl || draft.sha256) {
    el.textContent = "Saved but never announced. Users will not see it until you press Notify all users.";
  } else {
    el.textContent = "Nothing announced yet.";
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

  const saveFeatureFlagsBtn = qs("saveFeatureFlagsBtn");
  const featureFlagsStatus = qs("featureFlagsStatus");
  if (saveFeatureFlagsBtn) {
    saveFeatureFlagsBtn.addEventListener("click", async () => {
      // Diff against the last-loaded/saved state so only the flags the operator actually
      // flipped are sent -- updateFeatureFlags merges per-key and leaves the rest untouched,
      // so sending all 19 on every save would be safe but needlessly wide.
      const changed = {};
      for (const key of FEATURE_FLAG_KEYS) {
        const box = featureFlagCheckbox(key);
        if (!box) continue;
        if (!lastFeatureFlags || lastFeatureFlags[key] !== box.checked) {
          changed[key] = box.checked;
        }
      }
      if (!Object.keys(changed).length) {
        if (featureFlagsStatus) {
          featureFlagsStatus.textContent = "No changes to save.";
          featureFlagsStatus.style.color = "var(--muted)";
        }
        return;
      }

      saveFeatureFlagsBtn.disabled = true;
      saveFeatureFlagsBtn.textContent = "Saving...";
      try {
        const r = await api("/app-config/features", {
          method: "PATCH",
          body: { featureFlags: changed },
        });
        loadFeatureFlagsSection(r.featureFlags);
        if (featureFlagsStatus) {
          // Render the flag map the server echoes back verbatim (textContent, not innerHTML --
          // no escaping needed and none of this can carry markup).
          featureFlagsStatus.textContent = `Saved.\n${JSON.stringify(r.featureFlags, null, 2)}`;
          featureFlagsStatus.style.color = "#2d7a55";
        }
      } catch (err) {
        if (featureFlagsStatus) {
          if (err.status === 403) {
            featureFlagsStatus.textContent = "Only the super-admin account may change feature flags.";
          } else {
            // Covers the index-readiness rejection for noticeCases/assuranceEngagements/
            // auditWorkingPapers (and any other server error): show the server's own message
            // verbatim rather than inventing a generic one client-side.
            featureFlagsStatus.textContent = err.message || "Save failed.";
          }
          featureFlagsStatus.style.color = "#b44545";
        }
      } finally {
        saveFeatureFlagsBtn.disabled = false;
        saveFeatureFlagsBtn.textContent = "Save Feature Flags";
      }
    });
  }

  const saveDesktopReleaseBtn = qs("saveDesktopReleaseBtn");
  const notifyDesktopReleaseBtn = qs("notifyDesktopReleaseBtn");
  const desktopReleaseStatus = qs("desktopReleaseStatus");

  if (saveDesktopReleaseBtn) {
    saveDesktopReleaseBtn.addEventListener("click", async () => {
      saveDesktopReleaseBtn.disabled = true;
      saveDesktopReleaseBtn.textContent = "Saving...";
      try {
        const r = await api("/app-config/desktop-release", {
          method: "PATCH",
          body: {
            latestVersion: qs("desktopLatestVersion")?.value?.trim() || "",
            minSupportedVersion: qs("desktopMinSupportedVersion")?.value?.trim() || "",
            downloadUrl: qs("desktopDownloadUrl")?.value?.trim() || "",
            sha256: qs("desktopSha256")?.value?.trim() || "",
            sizeBytes: Number(qs("desktopSizeBytes")?.value) || 0,
            releaseNotes: qs("desktopReleaseNotes")?.value || "",
            mandatory: !!qs("desktopMandatory")?.checked,
            // Republish confirmation is not part of this UI -- Save always refuses to re-publish
            // an unchanged version number; bump the version to save again.
            allowRepublish: false,
          },
        });
        lastDesktopReleaseDraft = r.desktopRelease || lastDesktopReleaseDraft;
        renderDesktopReleaseLive(lastDesktopReleaseDraft);
        if (desktopReleaseStatus) {
          desktopReleaseStatus.textContent =
            "Saved. Nothing has been sent to users yet -- press Notify all users when you are ready.";
          desktopReleaseStatus.style.color = "#2d7a55";
        }
      } catch (err) {
        if (desktopReleaseStatus) {
          desktopReleaseStatus.textContent = err.message || "Save failed.";
          desktopReleaseStatus.style.color = "#b44545";
        }
      } finally {
        saveDesktopReleaseBtn.disabled = false;
        saveDesktopReleaseBtn.textContent = "Save Release";
      }
    });
  }

  if (notifyDesktopReleaseBtn) {
    notifyDesktopReleaseBtn.addEventListener("click", async () => {
      const version = qs("desktopLatestVersion")?.value?.trim() || "";

      // Re-notify warning (checked before either confirm): the currently-loaded draft already
      // carries this exact version AND an announcementId, so pressing Notify again would re-alert
      // users who already dismissed it.
      const alreadyAnnounced =
        !!lastDesktopReleaseDraft?.announcementId &&
        lastDesktopReleaseDraft?.latestVersion === version;

      let confirmMsg = `Notify every CA PRO desktop user that version ${version} is available? This cannot be undone.`;
      if (alreadyAnnounced) {
        confirmMsg =
          `Version ${version} has already been announced -- notifying again will re-alert users who already dismissed it. ` +
          confirmMsg;
      }

      // Gate 1: plain confirm. Declining must make NO network request.
      if (!window.confirm(confirmMsg)) return;

      // Gate 2: typed confirm. Anything but an exact match must also make NO network request.
      const typed = window.prompt(`Type the version number exactly (${version}) to confirm.`);
      if (typed !== version) {
        if (desktopReleaseStatus) {
          desktopReleaseStatus.textContent = "Cancelled -- the version did not match.";
          desktopReleaseStatus.style.color = "#b44545";
        }
        return;
      }

      notifyDesktopReleaseBtn.disabled = true;
      notifyDesktopReleaseBtn.textContent = "Notifying...";
      try {
        await api("/app-config/desktop-release/notify", { method: "POST" });
        if (desktopReleaseStatus) {
          desktopReleaseStatus.textContent =
            "Notified. Every desktop on an older build will see the update banner within a few minutes, and a Windows notification once.";
          desktopReleaseStatus.style.color = "#2d7a55";
        }
        await loadAppConfigSection();
      } catch (err) {
        if (desktopReleaseStatus) {
          if (err.status === 409 && err.data?.code === "RELEASE_INCOMPLETE") {
            desktopReleaseStatus.textContent =
              "Release is incomplete -- save a complete release (latest version, download URL, SHA-256, size) before notifying.";
          } else {
            desktopReleaseStatus.textContent = err.message || "Notify failed.";
          }
          desktopReleaseStatus.style.color = "#b44545";
        }
      } finally {
        notifyDesktopReleaseBtn.disabled = false;
        notifyDesktopReleaseBtn.textContent = "Notify all users";
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

// ─── Provider Usage (O10 spend meter/cap) ────────────────────────────
const PROVIDER_USAGE_LABELS = { DEEPSEEK: "DeepSeek", OCR_SPACE: "OCR.space" };

function renderProviderUsageTopUsers(rows) {
  if (!rows.length) {
    return `<div style="color:var(--muted);font-style:italic;font-size:12px;">No calls yet today</div>`;
  }
  return rows
    .map(
      (row, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:${i < rows.length - 1 ? "1px solid var(--border)" : "none"};">
          <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(row.email || "—")}</div>
          <div style="font-weight:700;color:var(--teal-dark);font-size:12.5px;margin-left:8px;">${Number(row.calls) || 0}</div>
        </div>`,
    )
    .join("");
}

async function loadProviderUsageStats() {
  const statusEl = qs("providerUsageStatus");
  const gridEl = qs("providerUsageGrid");

  try {
    const data = await api("/super/provider-usage");
    if (!data.ok) throw new Error("Failed to load provider usage");
    const u = data.usage || {};
    if (statusEl) statusEl.textContent = "";

    if (gridEl) {
      gridEl.innerHTML = Object.keys(PROVIDER_USAGE_LABELS)
        .map((provider) => {
          const today = Number(u.today?.[provider]) || 0;
          const month = Number(u.thisMonth?.[provider]) || 0;
          const topUsers = Array.isArray(u.topUsersToday?.[provider]) ? u.topUsersToday[provider] : [];
          return `
            <div class="col-md-6">
              <div class="card p-3">
                <h6 class="mb-2" style="font-size: 12.5px; font-weight: 700;">${escapeHtml(PROVIDER_USAGE_LABELS[provider])}</h6>
                <div class="d-flex gap-4 mb-2">
                  <div>
                    <div style="font-size:20px;font-weight:700;color:var(--text);">${today}</div>
                    <div style="font-size:11px;color:var(--muted);">calls today</div>
                  </div>
                  <div>
                    <div style="font-size:20px;font-weight:700;color:var(--text);">${month}</div>
                    <div style="font-size:11px;color:var(--muted);">calls this month</div>
                  </div>
                </div>
                <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Top users today</div>
                ${renderProviderUsageTopUsers(topUsers)}
              </div>
            </div>`;
        })
        .join("");
    }
  } catch (err) {
    console.error("Provider usage error:", err);
    if (statusEl) statusEl.textContent = err.message || "Failed to load provider usage.";
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
        <div class="stat-label">Product Access</div>
        <div class="stat-value">Free</div>
        <div class="stat-sub">All ${s.firms.total} firms</div>
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
  const accessBadge = `<span class="badge good">FREE · ALL TOOLS</span>`;
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
      <td>${accessBadge}</td>
      <td>${activeBadge}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary me-1 firm-users-btn" type="button">Users</button>
        <button class="btn btn-sm btn-outline-secondary me-1 firm-plan-btn" type="button">Edit access</button>
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
  const currentActiveCell = rowEl.querySelector("td:nth-child(5)");
  const currentActive = currentActiveCell?.innerText.trim().toLowerCase() === "active";
  const activeInput = window.prompt(
    "Keep this firm account active? (yes/no):",
    currentActive ? "yes" : "no"
  );
  if (activeInput === null) return;
  const normalized = activeInput.trim().toLowerCase();
  if (!["yes", "y", "no", "n"].includes(normalized)) {
    alert("Enter yes or no.");
    return;
  }
  const isActive = normalized.startsWith("y");

  try {
    const updated = await updateFirmPlanApi(firmId, { isActive });
    rowEl.outerHTML = renderFirmRow(updated);
  } catch (err) {
    alert(err.message || "Failed to update firm access.");
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

// ─── User directory ─────────────────────────────────────────────────
const userDir = {
  page: 1,
  limit: 25,
  search: "",
  activity: "",
  role: "",
  sort: "recent",
  totalPages: 1,
  lastUsers: [],
};
let userDirDebounce = null;

function userRoleBadge(role) {
  if (role === "SUPER_ADMIN") return `<span class="badge bg-dark">Super admin</span>`;
  if (role === "FIRM_ADMIN") return `<span class="badge good">Firm admin</span>`;
  return `<span class="badge bg-secondary">User</span>`;
}

function renderUserDirectoryRow(u, index) {
  const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
  let lastActive = "Never";
  let sinceLabel = "";
  if (u.lastActiveAt) {
    lastActive = new Date(u.lastActiveAt).toLocaleDateString();
    if (u.daysSinceActive === 0) sinceLabel = "today";
    else if (u.daysSinceActive === 1) sinceLabel = "1 day ago";
    else if (Number.isFinite(u.daysSinceActive)) sinceLabel = `${u.daysSinceActive} days ago`;
  }
  const dormant = u.lastActiveAt && Number(u.daysSinceActive) > 30;
  const never = !u.lastActiveAt;
  const lastActiveCell = never
    ? `<span class="badge warn">Never active</span>`
    : `${escapeHtml(lastActive)}${sinceLabel ? ` <span class="${dormant ? "text-danger" : "text-muted"} small">${escapeHtml(sinceLabel)}</span>` : ""}`;
  const statusBadge = u.isActive
    ? `<span class="badge good">Active</span>`
    : `<span class="badge warn">Disabled</span>`;
  const apiCalls = Number(u.totalApiCalls || 0).toLocaleString("en-IN");
  const firmCell = u.activeFirm
    ? `${escapeHtml(u.activeFirm.displayName || "—")} <span class="text-muted small">@${escapeHtml(u.activeFirm.handle || "")}</span>${u.activeFirm.kind === "PERSONAL" ? ` <span class="badge bg-secondary">personal</span>` : ""}`
    : `<span class="text-muted small">—</span>`;

  const cell = (label, value) => `<div class="col-md-3 col-6"><span class="text-muted d-block">${label}</span>${value}</div>`;
  const detail = `
    <div class="row g-3 small">
      ${cell("Name", escapeHtml(u.name || "—"))}
      ${cell("Email", escapeHtml(u.email || "—"))}
      ${cell("Joined", escapeHtml(joined))}
      ${cell("Last active", lastActiveCell)}
      ${cell("Total API calls", apiCalls)}
      ${cell("Workspaces", String(Number(u.workspaceCount || 0)))}
      ${cell("Active firm", firmCell)}
    </div>`;

  return `
    <tr class="user-dir-row" data-user-toggle="${index}" role="button" tabindex="0" aria-expanded="false" title="Show details">
      <td><strong>${escapeHtml(u.email || "—")}</strong>${u.name ? `<br><span class="text-muted small">${escapeHtml(u.name)}</span>` : ""}</td>
      <td>${userRoleBadge(u.role)}</td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(joined)}</td>
      <td>${lastActiveCell}</td>
      <td>${apiCalls}</td>
      <td>${Number(u.workspaceCount || 0)}</td>
      <td class="small">${firmCell}</td>
    </tr>
    <tr class="user-dir-detail d-none" data-user-detail="${index}"><td colspan="8" class="bg-light">${detail}</td></tr>
  `;
}

// Export the users in the current directory view (respects filters) as CSV/Excel.
function exportUserDirectory(format) {
  if (typeof globalThis.CaProFiles?.downloadCsv !== "function") return;
  const users = userDir.lastUsers || [];
  if (!users.length) return;
  const headers = ["Email", "Name", "Role", "Status", "Joined", "Last active", "Days since active", "API calls", "Workspaces", "Active firm", "Firm handle", "Firm type"];
  const rows = users.map((u) => [
    u.email || "",
    u.name || "",
    u.role || "",
    u.isActive ? "Active" : "Disabled",
    u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "",
    u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleDateString() : "Never",
    u.lastActiveAt && Number.isFinite(u.daysSinceActive) ? String(u.daysSinceActive) : "",
    String(Number(u.totalApiCalls || 0)),
    String(Number(u.workspaceCount || 0)),
    u.activeFirm?.displayName || "",
    u.activeFirm?.handle || "",
    u.activeFirm?.kind || "",
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    globalThis.CaProFiles.downloadXlsx(`users-${stamp}.xlsx`, headers, rows, "Users");
  } else {
    globalThis.CaProFiles.downloadCsv(`users-${stamp}.csv`, headers, rows);
  }
}

async function loadUserDirectory() {
  const body = qs("userDirectoryBody");
  const statusEl = qs("userDirectoryStatus");
  const metaEl = qs("userDirectoryMeta");
  if (statusEl) statusEl.textContent = "Loading users…";
  try {
    const params = new URLSearchParams({
      page: String(userDir.page),
      limit: String(userDir.limit),
      sort: userDir.sort,
    });
    if (userDir.search) params.set("search", userDir.search);
    if (userDir.activity) params.set("activity", userDir.activity);
    if (userDir.role) params.set("role", userDir.role);

    const data = await api(`/super/users?${params.toString()}`);
    const users = data.users || [];
    const p = data.pagination || {};
    userDir.totalPages = p.totalPages || 1;
    userDir.lastUsers = users;

    if (body) {
      body.innerHTML = users.length
        ? users.map((u, i) => renderUserDirectoryRow(u, i)).join("")
        : `<tr><td colspan="8" class="text-center text-muted small">No users match these filters.</td></tr>`;
    }
    if (metaEl) {
      metaEl.textContent = `Page ${p.page || 1} of ${p.totalPages || 1} · ${p.total || 0} users`;
    }
    if (statusEl) statusEl.textContent = "";
    const prevBtn = qs("userPrevBtn");
    const nextBtn = qs("userNextBtn");
    if (prevBtn) prevBtn.disabled = (p.page || 1) <= 1;
    if (nextBtn) nextBtn.disabled = !p.hasMore;
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Failed to load users.";
  }
}

function bindUserDirectoryControls() {
  const search = qs("userSearchInput");
  if (search) {
    search.addEventListener("input", () => {
      clearTimeout(userDirDebounce);
      userDirDebounce = setTimeout(() => {
        userDir.search = search.value.trim();
        userDir.page = 1;
        loadUserDirectory();
      }, 300);
    });
  }
  qs("userActivityFilter")?.addEventListener("change", (e) => {
    userDir.activity = e.target.value;
    userDir.page = 1;
    loadUserDirectory();
  });
  qs("userRoleFilter")?.addEventListener("change", (e) => {
    userDir.role = e.target.value;
    userDir.page = 1;
    loadUserDirectory();
  });
  qs("userSortSelect")?.addEventListener("change", (e) => {
    userDir.sort = e.target.value;
    userDir.page = 1;
    loadUserDirectory();
  });
  qs("userPrevBtn")?.addEventListener("click", () => {
    if (userDir.page > 1) {
      userDir.page -= 1;
      loadUserDirectory();
    }
  });
  qs("userNextBtn")?.addEventListener("click", () => {
    if (userDir.page < userDir.totalPages) {
      userDir.page += 1;
      loadUserDirectory();
    }
  });
  qs("userExportCsvBtn")?.addEventListener("click", () => exportUserDirectory("csv"));
  qs("userExportXlsxBtn")?.addEventListener("click", () => exportUserDirectory("xlsx"));

  // Expandable rows: click or Enter/Space toggles a detail panel for the user.
  const body = qs("userDirectoryBody");
  if (body) {
    const toggleRow = (row) => {
      const idx = row.dataset.userToggle;
      const detail = body.querySelector(`[data-user-detail="${idx}"]`);
      if (!detail) return;
      const nowHidden = detail.classList.toggle("d-none");
      row.setAttribute("aria-expanded", String(!nowHidden));
    };
    body.addEventListener("click", (e) => {
      const row = e.target.closest(".user-dir-row");
      if (row) toggleRow(row);
    });
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest(".user-dir-row");
      if (row) { e.preventDefault(); toggleRow(row); }
    });
  }
}

// ─── Terms acceptance history ───────────────────────────────────────
const termsAcceptanceHistory = {
  page: 1,
  limit: 25,
  search: "",
  version: "",
  from: "",
  to: "",
  totalPages: 1,
  requestEpoch: 0,
};

function formatExactAcceptanceTime(value) {
  const raw = String(value || "").trim();
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.getTime())) {
    return {
      local: "Timestamp unavailable",
      utc: raw || "—",
    };
  }

  let local;
  try {
    local = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      timeZoneName: "short",
    }).format(parsed);
  } catch {
    local = parsed.toLocaleString();
  }

  return { local, utc: parsed.toISOString() };
}

function renderTermsAcceptanceRow(acceptance) {
  const timestamp = formatExactAcceptanceTime(acceptance.acceptedAt);
  const source = String(acceptance.source || "—").toUpperCase();
  const sourceBadge = source === "DESKTOP"
    ? `<span class="badge good">Desktop</span>`
    : `<span class="badge bg-secondary">${escapeHtml(source)}</span>`;

  return `
    <tr>
      <td><strong>${escapeHtml(acceptance.email || "—")}</strong></td>
      <td>
        <span>${escapeHtml(timestamp.local)}</span><br>
        <code class="small text-break">${escapeHtml(timestamp.utc)}</code>
      </td>
      <td><span class="badge bg-secondary">${escapeHtml(acceptance.version || "—")}</span></td>
      <td>${sourceBadge}</td>
      <td><code class="small text-break">${escapeHtml(acceptance.documentHash || "—")}</code></td>
      <td><code class="small text-break">${escapeHtml(acceptance.id || "—")}</code></td>
    </tr>`;
}

function setTermsAcceptanceBusy(isBusy) {
  const apply = qs("termsAcceptanceApply");
  const clear = qs("termsAcceptanceClear");
  const previous = qs("termsAcceptancePrev");
  const next = qs("termsAcceptanceNext");
  if (apply) apply.disabled = isBusy;
  if (clear) clear.disabled = isBusy;
  if (previous && isBusy) previous.disabled = true;
  if (next && isBusy) next.disabled = true;
}

async function loadTermsAcceptanceHistory() {
  const epoch = ++termsAcceptanceHistory.requestEpoch;
  const body = qs("termsAcceptanceBody");
  const status = qs("termsAcceptanceStatus");
  const meta = qs("termsAcceptanceMeta");
  const retry = qs("termsAcceptanceRetry");

  setTermsAcceptanceBusy(true);
  if (status) {
    status.className = "text-muted mb-0 small";
    status.textContent = "Loading acceptance history...";
  }
  if (retry) retry.classList.add("d-none");
  if (body) {
    body.innerHTML = `<tr><td colspan="6" class="text-center text-muted small">Loading acceptance records...</td></tr>`;
  }

  try {
    const params = new URLSearchParams({
      page: String(termsAcceptanceHistory.page),
      limit: String(termsAcceptanceHistory.limit),
    });
    if (termsAcceptanceHistory.search) params.set("search", termsAcceptanceHistory.search);
    if (termsAcceptanceHistory.version) params.set("version", termsAcceptanceHistory.version);
    if (termsAcceptanceHistory.from) params.set("from", termsAcceptanceHistory.from);
    if (termsAcceptanceHistory.to) params.set("to", termsAcceptanceHistory.to);

    const data = await api(`/super/terms-acceptances?${params.toString()}`);
    if (epoch !== termsAcceptanceHistory.requestEpoch) return;

    const acceptances = Array.isArray(data?.acceptances) ? data.acceptances : [];
    const pagination = data?.pagination || {};
    termsAcceptanceHistory.totalPages = Math.max(1, Number(pagination.totalPages) || 1);

    const currentVersion = String(data?.currentTerms?.version || "—");
    const currentHash = String(data?.currentTerms?.documentHash || "—");
    if (qs("termsCurrentVersion")) {
      qs("termsCurrentVersion").textContent = `Version ${currentVersion}`;
    }
    if (qs("termsCurrentHash")) {
      qs("termsCurrentHash").textContent = `SHA-256 ${currentHash}`;
    }

    if (body) {
      body.innerHTML = acceptances.length
        ? acceptances.map(renderTermsAcceptanceRow).join("")
        : `<tr><td colspan="6" class="text-center text-muted small">No acceptance records match these filters.</td></tr>`;
    }
    if (status) {
      status.className = "text-muted mb-0 small";
      status.textContent = acceptances.length
        ? `Showing ${acceptances.length} acceptance record${acceptances.length === 1 ? "" : "s"} on this page.`
        : "No acceptance records match these filters.";
    }
    if (meta) {
      meta.textContent = `Page ${pagination.page || 1} of ${termsAcceptanceHistory.totalPages} · ${pagination.total || 0} records`;
    }

    const previous = qs("termsAcceptancePrev");
    const next = qs("termsAcceptanceNext");
    if (previous) previous.disabled = (pagination.page || 1) <= 1;
    if (next) next.disabled = !pagination.hasMore;
  } catch (error) {
    if (epoch !== termsAcceptanceHistory.requestEpoch) return;
    if (status) {
      status.className = "text-danger mb-0 small";
      status.textContent = error.message || "Acceptance history could not be loaded.";
    }
    if (body) {
      body.innerHTML = `<tr><td colspan="6" class="text-center text-danger small">Acceptance history is unavailable. No record data is shown.</td></tr>`;
    }
    if (meta) meta.textContent = "—";
    if (retry) retry.classList.remove("d-none");
  } finally {
    if (epoch === termsAcceptanceHistory.requestEpoch) {
      setTermsAcceptanceBusy(false);
    }
  }
}

function applyTermsAcceptanceFilters() {
  const search = qs("termsAcceptanceSearch")?.value.trim() || "";
  const version = qs("termsAcceptanceVersion")?.value.trim() || "";
  const from = qs("termsAcceptanceFrom")?.value || "";
  const to = qs("termsAcceptanceTo")?.value || "";
  const status = qs("termsAcceptanceStatus");

  if (from && to && from > to) {
    if (status) {
      status.className = "text-danger mb-0 small";
      status.textContent = "Accepted from date must not be after accepted to date.";
    }
    return;
  }

  Object.assign(termsAcceptanceHistory, {
    page: 1,
    search,
    version,
    from,
    to,
  });
  loadTermsAcceptanceHistory();
}

function bindTermsAcceptanceControls() {
  qs("termsAcceptanceFilters")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyTermsAcceptanceFilters();
  });
  qs("termsAcceptanceClear")?.addEventListener("click", () => {
    for (const id of [
      "termsAcceptanceSearch",
      "termsAcceptanceVersion",
      "termsAcceptanceFrom",
      "termsAcceptanceTo",
    ]) {
      const input = qs(id);
      if (input) input.value = "";
    }
    Object.assign(termsAcceptanceHistory, {
      page: 1,
      search: "",
      version: "",
      from: "",
      to: "",
    });
    loadTermsAcceptanceHistory();
  });
  qs("termsAcceptanceRetry")?.addEventListener("click", loadTermsAcceptanceHistory);
  qs("termsAcceptancePrev")?.addEventListener("click", () => {
    if (termsAcceptanceHistory.page <= 1) return;
    termsAcceptanceHistory.page -= 1;
    loadTermsAcceptanceHistory();
  });
  qs("termsAcceptanceNext")?.addEventListener("click", () => {
    if (termsAcceptanceHistory.page >= termsAcceptanceHistory.totalPages) return;
    termsAcceptanceHistory.page += 1;
    loadTermsAcceptanceHistory();
  });
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

    // Load app config, usage analytics, dashboard stats, user directory, and Terms acceptance history in parallel.
    bindAppConfigHandlers();
    bindUserDirectoryControls();
    bindTermsAcceptanceControls();
    await Promise.all([
      loadAppConfigSection(),
      loadUsageStats(),
      loadProviderUsageStats(),
      loadDashboardStats(),
      loadUserDirectory(),
      loadTermsAcceptanceHistory(),
    ]);

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
        if (firmsBody) firmsBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No firms found.</td></tr>`;
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


// Deep System Review
const SELF_TEST_ACTIVE_RUN_KEY = "caproDeepSystemTestRunId";
const SELF_TEST_POLL_MS = 1000;
let selfTestPollTimer = null;
let selfTestIsRunning = false;
let selfTestRequestEpoch = 0;

function isActiveSelfTest(run) {
  return ["QUEUED", "RUNNING", "RECOVERING", "CLEANUP_FAILED"].includes(run?.status);
}

function statusLabel(status) {
  const value = String(status || "pending").toLowerCase();
  if (value === "pass") return "Pass";
  if (value === "warn") return "Warning";
  if (value === "fail") return "Fail";
  return "Pending";
}

function makeStatusBadge(status) {
  const badge = document.createElement("span");
  const normalized = String(status || "pending").toLowerCase();
  badge.className = `st-status st-status-${normalized}`;
  badge.textContent = statusLabel(normalized);
  return badge;
}

function formatSelfTestJson(value) {
  if (value == null) return "Not supplied";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function makeMetric(label, value) {
  const metric = document.createElement("div");
  metric.className = "st-metric";
  const number = document.createElement("strong");
  number.textContent = String(value ?? 0);
  const caption = document.createElement("span");
  caption.textContent = label;
  metric.append(number, caption);
  return metric;
}

function appendListSection(parent, title, values) {
  if (!Array.isArray(values) || !values.length) return;
  const heading = document.createElement("h4");
  heading.textContent = title;
  const list = document.createElement("ul");
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = String(value);
    list.appendChild(item);
  }
  parent.append(heading, list);
}

function captureSelfTestDisclosureState(results) {
  const state = { groups: new Map(), evidence: new Map(), focusKey: "" };
  if (!results) return state;

  for (const details of results.querySelectorAll(".st-group[data-section-id]")) {
    state.groups.set(details.dataset.sectionId, details.open);
  }
  for (const details of results.querySelectorAll(".st-evidence[data-evidence-key]")) {
    state.evidence.set(details.dataset.evidenceKey, details.open);
  }

  const active = document.activeElement;
  if (active?.tagName === "SUMMARY") {
    const evidence = active.parentElement?.closest(".st-evidence[data-evidence-key]");
    const group = active.parentElement?.closest(".st-group[data-section-id]");
    if (evidence) state.focusKey = `evidence:${evidence.dataset.evidenceKey}`;
    else if (group) state.focusKey = `group:${group.dataset.sectionId}`;
  }
  return state;
}

function restoreSelfTestFocus(results, focusKey) {
  if (!results || !focusKey) return;
  const [kind, ...parts] = focusKey.split(":");
  const key = parts.join(":");
  const selector = kind === "evidence"
    ? ".st-evidence[data-evidence-key]"
    : ".st-group[data-section-id]";
  const details = [...results.querySelectorAll(selector)].find((entry) =>
    kind === "evidence"
      ? entry.dataset.evidenceKey === key
      : entry.dataset.sectionId === key
  );
  details?.querySelector(":scope > summary")?.focus({ preventScroll: true });
}

function renderSelfTestCheck(check, sectionId, disclosureState) {
  const wrapper = document.createElement("div");
  wrapper.className = `st-check st-check-${check.status || "pending"}`;
  wrapper.dataset.checkId = String(check.id || "unnamed");

  const row = document.createElement("div");
  row.className = "st-check-row";
  row.appendChild(makeStatusBadge(check.status));

  const copy = document.createElement("div");
  copy.className = "st-check-copy";
  const name = document.createElement("strong");
  name.textContent = check.name || check.id || "Unnamed check";
  const detail = document.createElement("span");
  detail.textContent = check.detail || "No detail returned";
  copy.append(name, detail);

  const timing = document.createElement("span");
  timing.className = "st-ms";
  timing.textContent = `${Number(check.ms || 0)} ms`;
  row.append(copy, timing);
  wrapper.appendChild(row);

  if (check.expected != null || check.actual != null || check.evidence != null) {
    const evidence = document.createElement("details");
    evidence.className = "st-evidence";
    const evidenceKey = `${sectionId}:${check.id || "unnamed"}`;
    evidence.dataset.evidenceKey = evidenceKey;
    if (disclosureState.evidence.has(evidenceKey)) {
      evidence.open = disclosureState.evidence.get(evidenceKey);
    }
    const summary = document.createElement("summary");
    summary.textContent = "Expected, actual, and supporting evidence";
    evidence.appendChild(summary);

    const grid = document.createElement("div");
    grid.className = "st-evidence-grid";
    for (const [label, value] of [
      ["Expected", check.expected],
      ["Actual", check.actual],
      ["Evidence", check.evidence],
    ]) {
      if (value == null) continue;
      const block = document.createElement("div");
      const heading = document.createElement("h5");
      heading.textContent = label;
      const pre = document.createElement("pre");
      pre.textContent = formatSelfTestJson(value);
      block.append(heading, pre);
      grid.appendChild(block);
    }
    evidence.appendChild(grid);
    wrapper.appendChild(evidence);
  }
  return wrapper;
}

function renderSelfTestGroup(group, runActive, disclosureState) {
  const details = document.createElement("details");
  details.className = `st-group st-group-${group.status || "pending"}`;
  details.dataset.sectionId = String(group.id || "unnamed");
  const defaultOpen = runActive || group.status === "fail" || group.status === "warn";
  details.open = disclosureState.groups.has(details.dataset.sectionId)
    ? disclosureState.groups.get(details.dataset.sectionId)
    : defaultOpen;

  const summary = document.createElement("summary");
  summary.appendChild(makeStatusBadge(group.status));
  const title = document.createElement("strong");
  title.textContent = group.name || group.id || "Unnamed section";
  const count = document.createElement("span");
  count.className = "st-group-count";
  count.textContent = `${group.checks?.length || 0} check${group.checks?.length === 1 ? "" : "s"}`;
  summary.append(title, count);
  details.appendChild(summary);

  const checks = document.createElement("div");
  checks.className = "st-checks";
  for (const check of group.checks || []) {
    checks.appendChild(renderSelfTestCheck(check, details.dataset.sectionId, disclosureState));
  }
  if (!group.checks?.length) {
    const pending = document.createElement("div");
    pending.className = "st-empty-group";
    pending.textContent = "This section is starting.";
    checks.appendChild(pending);
  }
  details.appendChild(checks);
  return details;
}

function renderDeepSeekReview(review) {
  if (!review) return null;
  const effectiveVerdict = String(review.advisoryStatus || review.verdict || "WARN").toUpperCase();
  const effectiveStatus = effectiveVerdict === "PASS" ? "pass" : effectiveVerdict === "FAIL" ? "fail" : "warn";
  const panel = document.createElement("section");
  panel.className = `st-ai-review st-ai-${effectiveStatus}`;
  const heading = document.createElement("div");
  heading.className = "st-ai-heading";
  const title = document.createElement("h3");
  title.textContent = "DeepSeek evidence review";
  heading.append(title, makeStatusBadge(effectiveStatus));
  panel.appendChild(heading);

  const meta = document.createElement("p");
  const confidence = Number.isFinite(Number(review.confidence))
    ? `${Math.round(Number(review.confidence) * 100)}% confidence`
    : "confidence unavailable";
  const verdictContext = review.completed && review.verdict && effectiveVerdict !== review.verdict
    ? `, provider verdict ${review.verdict}, normalized advisory ${effectiveVerdict}`
    : "";
  meta.textContent = review.completed
    ? `${review.provider || "DeepSeek"}${review.model ? `, ${review.model}` : ""}, ${confidence}${verdictContext}`
    : review.reason || "DeepSeek review did not complete";
  panel.appendChild(meta);

  if (review.summary) {
    const summary = document.createElement("p");
    summary.className = "st-ai-summary";
    summary.textContent = review.summary;
    panel.appendChild(summary);
  }
  appendListSection(panel, "Consistency warnings", review.consistencyIssues);
  appendListSection(panel, "Contradictions", review.contradictions);
  appendListSection(panel, "Coverage gaps", review.coverageGaps);
  appendListSection(panel, "Findings", review.findings);
  appendListSection(
    panel,
    "Section assessments",
    Array.isArray(review.sectionAssessments)
      ? review.sectionAssessments.map((entry) => {
        const status = entry.deterministicStatus
          ? `AI ${entry.status}; deterministic ${entry.deterministicStatus}`
          : entry.status;
        return `${entry.sectionId}: ${status} — ${entry.rationale}`;
      })
      : []
  );
  return panel;
}

function renderSelfTestReport(run) {
  const idle = qs("selfTestIdle");
  const wrap = qs("selfTestProgressWrap");
  const results = qs("selfTestResults");
  const bar = qs("selfTestBar");
  const counts = qs("selfTestCounts");
  const headline = qs("selfTestHeadline");
  const meta = qs("selfTestRunMeta");
  if (!results || !bar || !counts || !headline) return;

  const active = isActiveSelfTest(run);
  selfTestIsRunning = active;
  idle?.classList.add("d-none");
  wrap?.classList.remove("d-none");

  const progress = run.progress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  headline.textContent = progress.currentCheck || run.phase || "Preparing deep review";
  counts.textContent = `${Number(progress.completed || 0)} / ${Number(progress.total || 0)}`;
  bar.style.width = `${percent}%`;
  bar.setAttribute("aria-valuenow", String(percent));
  bar.className = "progress-bar";
  if (!active && run.summary?.overall === "FAIL") bar.classList.add("bg-danger");
  else if (!active && run.summary?.overall === "WARN") bar.classList.add("bg-warning");
  else if (!active && run.summary?.overall === "PASS") bar.classList.add("bg-success");

  if (meta) {
    const started = run.startedAt ? new Date(run.startedAt).toLocaleString() : "not started";
    meta.textContent = `Run ${run.id || "pending"} | ${run.status || "QUEUED"} | Started ${started}`;
  }

  const disclosureState = captureSelfTestDisclosureState(results);
  results.replaceChildren();
  const summary = run.summary || {};
  if (run.status === "CLEANUP_FAILED" || run.status === "RECOVERING") {
    const banner = document.createElement("div");
    banner.className = `st-banner ${run.status === "CLEANUP_FAILED" ? "bad" : "warn"}`;
    banner.textContent = run.status === "CLEANUP_FAILED"
      ? "Cleanup is not yet verified. The global test lock remains active and automatic recovery will retry."
      : "A stale review is being recovered. Cleanup verification must finish before the global lock is released.";
    results.appendChild(banner);
  } else if (!active && (run.status === "COMPLETED" || run.status === "CRASHED")) {
    const banner = document.createElement("div");
    const overall = run.status === "CRASHED" ? "FAIL" : summary.overall || "FAIL";
    banner.className = `st-banner ${overall === "PASS" ? "ok" : overall === "WARN" ? "warn" : "bad"}`;
    banner.textContent = overall === "PASS"
      ? "Deep review passed. Deterministic checks, DeepSeek review, and cleanup all completed."
      : overall === "WARN"
        ? "Review completed with warnings. Inspect DeepSeek, provider, and section evidence below."
        : `Deep review found failures.${run.error ? ` ${run.error}` : " Inspect failed sections below."}`;
    results.appendChild(banner);
  }

  if (summary.total || !active) {
    const metrics = document.createElement("div");
    metrics.className = "st-summary-grid";
    metrics.append(
      makeMetric("Passed", summary.passed),
      makeMetric("Warnings", summary.warned),
      makeMetric("Failed", summary.failed),
      makeMetric("Sections", `${summary.sectionsCovered || 0}/${summary.sectionsExpected || 0}`),
      makeMetric("Cleanup residue", run.cleanup?.residualCount ?? "Pending")
    );
    results.appendChild(metrics);
  }

  const groups = document.createElement("div");
  groups.className = "st-groups";
  for (const group of run.groups || []) {
    groups.appendChild(renderSelfTestGroup(group, active, disclosureState));
  }
  results.appendChild(groups);

  const aiReview = renderDeepSeekReview(run.deepSeekReview);
  if (aiReview) results.appendChild(aiReview);
  restoreSelfTestFocus(results, disclosureState.focusKey);
  updateSelfTestControls();
}

function renderSelfTestRequestError(message, {
  preserveReport = false,
  headline = "Deep review request failed",
} = {}) {
  const results = qs("selfTestResults");
  if (!results) return;
  const headlineElement = qs("selfTestHeadline");
  if (headlineElement) headlineElement.textContent = headline;
  results.querySelector(".st-request-error")?.remove();
  const banner = document.createElement("div");
  banner.className = "st-banner bad st-request-error";
  banner.setAttribute("role", "alert");
  banner.setAttribute("aria-atomic", "true");
  banner.textContent = message || "Could not run the deep system review.";
  if (preserveReport && results.childElementCount) results.prepend(banner);
  else results.replaceChildren(banner);
}

function updateSelfTestControls() {
  const button = qs("runSelfTestBtn");
  const confirmation = qs("selfTestConfirm");
  if (!button) return;
  button.disabled = selfTestIsRunning || !confirmation?.checked;
  button.textContent = selfTestIsRunning ? "Review Running" : "Run Deep Review";
}

function stopSelfTestPolling() {
  if (selfTestPollTimer) window.clearTimeout(selfTestPollTimer);
  selfTestPollTimer = null;
}

function beginSelfTestRequestFlow() {
  stopSelfTestPolling();
  selfTestRequestEpoch += 1;
  return selfTestRequestEpoch;
}

function isCurrentSelfTestRequest(requestEpoch) {
  return requestEpoch === selfTestRequestEpoch;
}

function clearStoredSelfTestRun(runId) {
  const storedRunId = localStorage.getItem(SELF_TEST_ACTIVE_RUN_KEY);
  if (!runId || storedRunId === String(runId)) {
    localStorage.removeItem(SELF_TEST_ACTIVE_RUN_KEY);
  }
}

function scheduleSelfTestPoll(runId, options, delayMs = SELF_TEST_POLL_MS) {
  selfTestPollTimer = window.setTimeout(() => {
    void pollSelfTestRun(runId, options);
  }, delayMs);
}

async function loadLatestSelfTestRun({
  excludedRunId = "",
  reportFailure = false,
  requestEpoch = selfTestRequestEpoch,
} = {}) {
  try {
    const data = await api("/super/self-test/latest");
    if (!isCurrentSelfTestRequest(requestEpoch)) return false;

    const run = data.run;
    if (!run || (excludedRunId && String(run.id) === String(excludedRunId))) {
      selfTestIsRunning = false;
      updateSelfTestControls();
      if (reportFailure) {
        renderSelfTestRequestError(
          "Saved review expired and no newer system-test report is available.",
          { headline: "No saved deep review available" }
        );
      }
      return false;
    }

    renderSelfTestReport(run);
    if (isActiveSelfTest(run)) {
      await pollSelfTestRun(run.id, { fallbackToLatest: false, requestEpoch });
    }
    return true;
  } catch (error) {
    if (!isCurrentSelfTestRequest(requestEpoch)) return false;
    selfTestIsRunning = false;
    updateSelfTestControls();
    if (reportFailure) {
      renderSelfTestRequestError(
        `Could not restore latest system-test report: ${error.message || "request failed"}`,
        { headline: "Could not restore latest deep review" }
      );
    } else {
      console.warn("Deep system review history unavailable:", error.message);
    }
    return false;
  }
}

async function pollSelfTestRun(runId, {
  fallbackToLatest = false,
  requestEpoch = selfTestRequestEpoch,
} = {}) {
  if (!isCurrentSelfTestRequest(requestEpoch)) return false;
  stopSelfTestPolling();
  if (!runId) return false;

  selfTestIsRunning = true;
  updateSelfTestControls();
  localStorage.setItem(SELF_TEST_ACTIVE_RUN_KEY, runId);
  try {
    const data = await api(`/super/self-test/${encodeURIComponent(runId)}`);
    if (!isCurrentSelfTestRequest(requestEpoch)) return false;

    const run = data.run;
    renderSelfTestReport(run);
    if (isActiveSelfTest(run)) {
      scheduleSelfTestPoll(runId, { fallbackToLatest, requestEpoch });
    } else {
      clearStoredSelfTestRun(runId);
      selfTestIsRunning = false;
      updateSelfTestControls();
    }
    return true;
  } catch (error) {
    if (!isCurrentSelfTestRequest(requestEpoch)) return false;

    if (error?.status === 401 || error?.status === 403) {
      clearStoredSelfTestRun(runId);
      selfTestIsRunning = false;
      updateSelfTestControls();
      renderSelfTestRequestError(
        `Progress request failed: ${error.message || "authorization failed"}`,
        { headline: "Progress request failed" }
      );
      return false;
    }

    if (error?.status === 400 || error?.status === 404) {
      clearStoredSelfTestRun(runId);
      if (fallbackToLatest) {
        if (qs("selfTestHeadline")) qs("selfTestHeadline").textContent = "Restoring latest available review";
        return loadLatestSelfTestRun({
          excludedRunId: runId,
          reportFailure: true,
          requestEpoch,
        });
      }
      selfTestIsRunning = false;
      updateSelfTestControls();
      renderSelfTestRequestError(
        "This system-test run no longer exists.",
        { headline: "Deep review no longer available" }
      );
      return false;
    }

    selfTestIsRunning = true;
    updateSelfTestControls();
    renderSelfTestRequestError(
      `Progress temporarily unavailable; retrying: ${error.message || "request failed"}`,
      {
        preserveReport: true,
        headline: "Progress temporarily unavailable; retrying",
      }
    );
    scheduleSelfTestPoll(runId, { fallbackToLatest, requestEpoch }, 3000);
    return false;
  }
}

async function runSelfTest() {
  const confirmation = qs("selfTestConfirm");
  if (!confirmation?.checked) {
    renderSelfTestRequestError(
      "Confirm the synthetic-data safety notice before starting.",
      { headline: "Confirmation required" }
    );
    confirmation?.focus();
    return;
  }

  const requestEpoch = beginSelfTestRequestFlow();
  selfTestIsRunning = true;
  updateSelfTestControls();
  qs("selfTestIdle")?.classList.add("d-none");
  qs("selfTestProgressWrap")?.classList.remove("d-none");
  if (qs("selfTestHeadline")) qs("selfTestHeadline").textContent = "Starting isolated deep review";
  if (qs("selfTestCounts")) qs("selfTestCounts").textContent = "0 / 0";
  if (qs("selfTestResults")) qs("selfTestResults").replaceChildren();

  try {
    const data = await api("/super/self-test", {
      method: "POST",
      body: { confirmation: "RUN_ISOLATED_DEEP_TEST" },
    });
    if (!isCurrentSelfTestRequest(requestEpoch)) return;
    renderSelfTestReport(data.run);
    await pollSelfTestRun(data.run.id, { fallbackToLatest: false, requestEpoch });
  } catch (error) {
    if (!isCurrentSelfTestRequest(requestEpoch)) return;
    const activeRunId = error?.data?.runId;
    if (error?.status === 409 && activeRunId) {
      await pollSelfTestRun(activeRunId, { fallbackToLatest: false, requestEpoch });
      return;
    }
    selfTestIsRunning = false;
    updateSelfTestControls();
    renderSelfTestRequestError(
      `Could not start deep review: ${error.message || "request failed"}`,
      { headline: "Could not start deep review" }
    );
  }
}

async function initializeSelfTestPanel() {
  const button = qs("runSelfTestBtn");
  const confirmation = qs("selfTestConfirm");
  if (!button || !confirmation) return;
  button.addEventListener("click", runSelfTest);
  confirmation.addEventListener("change", updateSelfTestControls);
  const requestEpoch = beginSelfTestRequestFlow();
  selfTestIsRunning = true;
  updateSelfTestControls();

  const savedRunId = localStorage.getItem(SELF_TEST_ACTIVE_RUN_KEY);
  if (savedRunId) {
    await pollSelfTestRun(savedRunId, { fallbackToLatest: true, requestEpoch });
    return;
  }
  await loadLatestSelfTestRun({ requestEpoch });
}

document.addEventListener("DOMContentLoaded", initializeSelfTestPanel);


// ─── Send test email (admin diagnostics) ────────────────────────────
async function sendTestEmailNow() {
  const btn = qs("sendTestEmailBtn");
  const status = qs("sendTestEmailStatus");
  if (!btn) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Sending…";
  if (status) { status.textContent = "Sending a test email…"; status.style.color = "var(--muted)"; }
  try {
    const data = await api("/super/send-test-email", { method: "POST" });
    if (status) {
      if (data.ok) {
        status.textContent = `✓ Test email sent to ${data.to}. Check that inbox (also spam) to confirm delivery.`;
        status.style.color = "#166534";
      } else {
        status.textContent = `✗ Email provider rejected the send: ${escapeHtml(data.error || "unknown error")}`;
        status.style.color = "#b91c1c";
      }
    }
  } catch (err) {
    if (status) {
      status.textContent = `✗ Test email failed: ${escapeHtml(err.message || "request failed")}`;
      status.style.color = "#b91c1c";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = qs("sendTestEmailBtn");
  if (btn) btn.addEventListener("click", sendTestEmailNow);
});
