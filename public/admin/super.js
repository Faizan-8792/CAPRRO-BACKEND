// public/admin/super.js — Super Admin Dashboard

// Same-origin, and it must stay that way. This page is served by the API host itself -- app.js
// mounts public/ and public/admin at / and /admin on api.caprotoolkit.in -- so "/api" resolves to
// exactly the same endpoints in production that the old absolute base did. Measured 2026-08-26:
// api.caprotoolkit.in/admin/super.html is 200 while caprotoolkit.in/admin/super.html and
// caprotoolkit.in/api/app-config are both 404, so there is no other origin this page is served
// from and nothing to keep an absolute base for.
//
// An ABSOLUTE base made every copy of this page drive PRODUCTION regardless of where it was
// opened from: a local server, a staging host, a mirror, a file:// copy. For a panel that can
// overwrite production feature flags and notify every installed desktop app, that is a foot-gun
// with no upside -- and it is the reason the panel's browser gates could only ever be exercised
// against production, which is why several of them sat unrun.
//
// Pinned by tests/admin-panel-same-origin.mjs. Five sibling scripts carry the same base and were
// corrected in the same pass; see that suite for the list.
const API_BASE = "/api";
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

// Returns the signed-in super admin, or null after sending the browser elsewhere. The panel asks
// /auth/me once and initSuperPage uses this user rather than asking again (DS10): every request
// at startup counts against the API's limiter.
async function ensureSuperAdminAuth() {
  try {
    const data = await apiGetMe();
    if (!data.ok) throw new Error("Invalid user");
    if (data.user.role !== "SUPER_ADMIN") {
      window.location.href = "/admin/admin.html";
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

// ─── Utilities ──────────────────────────────────────────────────────
function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// What a failed request says when the server sent no message of its own: plain words and the
// next step, never a status code (DS24).
function superPlainError(status) {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "This account is not allowed to do that.";
  if (status === 404) return "That item no longer exists. Reload the page.";
  if (status === 429) return "Too many requests in a short time. Wait a minute, then try again.";
  return "The server could not complete that request. Try again in a moment.";
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
    const msg = data?.error || data?.message || superPlainError(res.status);
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

// ─── Dialogs, status lines and scope (DS24) ─────────────────────────
// Every question this panel asks goes through the shared CA PRO dialog (ui/capro-ui.js): its
// buttons name the action, a destructive one opens on the safe button and Enter never confirms
// it, Esc cancels and focus returns to the button that asked. If the library did not load, a
// question answers no, so nothing destructive runs unasked. Nothing here calls alert, confirm
// or prompt.
function superAsk(options) {
  return window.CaproUI ? window.CaproUI.confirm(options) : Promise.resolve(false);
}

function superAskText(options) {
  return window.CaproUI ? window.CaproUI.prompt(options) : Promise.resolve(null);
}

// The outcome of an action taken in a table row: success leaves by itself, a problem stays
// until it is dismissed.
function superToast(message, tone = "success") {
  if (window.CaproUI) window.CaproUI.toast({ message, tone });
}

// A card's status line: the outcome of the last thing done on that card, in its tone. The old
// lines set an inline colour that admin.css's `.small-label { color: ... !important }` beat, so
// every error showed in the same grey as the help text beside it.
function superStatus(el, text, tone = "muted") {
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

// Where a platform-wide change lands. Shown above every page, and typed to confirm the switches
// that reach every user, so a change on production cannot be confirmed by habit.
function superScope() {
  const host = window.location.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  return local
    ? { word: "local", label: "Local backend", host: window.location.host }
    : { word: "production", label: "Production", host };
}

function superRenderScope() {
  const scope = superScope();
  const bar = qs("superScope");
  if (bar) bar.dataset.scope = scope.word;
  if (qs("superScopeName")) qs("superScopeName").textContent = scope.label;
  if (qs("superScopeHost")) qs("superScopeHost").textContent = scope.host;
}

// Maintenance mode is a state, not an event: it shows on the switch's card and, once the Controls
// page has read it, in the scope bar above every page for as long as it is on. Startup does not
// read it separately: it asks only for the signed-in user and the page on screen (DS10).
function superRenderMaintenance(on) {
  const label = qs("maintenanceLabel");
  if (label) label.textContent = `Maintenance mode: ${on ? "ON" : "OFF"}`;
  const chip = qs("superScopeMaintenance");
  if (chip) chip.hidden = !on;
  const card = qs("maintenanceCard");
  if (card) card.dataset.state = on ? "on" : "off";
}


// SNAKE_CASE values in words ("FIRM_USER" -> "Firm user"); empty is a dash. An unknown value keeps
// its own words rather than being folded into a known one.
function superEnumLabel(value) {
  const words = String(value || "").trim().toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
}

// "12,34,567": counts read in the Indian grouping the rest of the product uses.
function superCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : "—";
}

// ─── Control changes (DS24) ─────────────────────────────────────────
// Who moved maintenance mode or a feature flag, what was set and the reason they gave. The server
// records an entry with every change (GET /api/app-config/control-changes, super only).
async function loadControlChanges() {
  const list = qs("controlChangesList");
  const status = qs("controlChangesStatus");
  if (!list) return;
  try {
    const data = await api("/app-config/control-changes");
    const changes = Array.isArray(data.changes) ? data.changes : [];
    superStatus(status, changes.length ? "" : "No change recorded yet. Changes made from now on are listed here with their reason.", "muted");
    list.innerHTML = changes
      .slice(0, 8)
      .map((change) => {
        const when = change.at ? new Date(change.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        const reason = change.reason ? escapeHtml(change.reason) : '<span class="control-change__none">No reason given</span>';
        return `
          <li class="control-change">
            <div class="control-change__what">${escapeHtml(change.summary || "Change")}</div>
            <div class="control-change__why">${reason}</div>
            <div class="control-change__meta">${escapeHtml(change.byEmail || "Actor not recorded")} · ${escapeHtml(when)}</div>
          </li>`;
      })
      .join("");
  } catch (err) {
    list.innerHTML = "";
    superStatus(status, err.message || "The change history could not be read. Reload the page.", "critical");
  }
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

// The GET /api/app-config response merges featureFlags over DEFAULT_FEATURE_FLAGS server-side
// (see getAppConfig / AppConfigSchema.statics.getFeatureFlags), so when the call SUCCEEDS every key
// is present and no per-key fallback is needed.
//
// It does not follow that a response always carries them, and that reading is what this comment
// used to invite: an unauthenticated or expired-session GET returns the config with NO flags at
// all. The caller therefore has to distinguish "loaded, all off" from "not loaded" before touching
// lastFeatureFlags -- see reportFeatureFlagLoadFailure.
function loadFeatureFlagsSection(featureFlags) {
  const flags = featureFlags || {};
  lastFeatureFlags = { ...flags };
  for (const key of FEATURE_FLAG_KEYS) {
    const box = featureFlagCheckbox(key);
    if (box) {
      box.checked = flags[key] === true;
      box.disabled = false; // a previous failed load may have disabled it
    }
  }
}

// Reports a failed load on the card itself. Silence was half of the 2026-08-26 defect: the
// operator had no way to tell "every feature is off" from "nothing loaded", and those two look
// identical in a grid of unchecked boxes.
function reportFeatureFlagLoadFailure(reason) {
  lastFeatureFlags = null;
  for (const key of FEATURE_FLAG_KEYS) {
    const box = featureFlagCheckbox(key);
    if (box) box.disabled = true;
  }
  superStatus(
    qs("featureFlagsStatus"),
    `Feature flags could not be loaded (${reason}). The checkboxes above are NOT showing the ` +
      "real state and have been disabled so they cannot be saved over it. Reload the page.",
    "critical",
  );
}

// A Controls card shows the server's settings, so its form stays disabled (a fieldset in
// super.html) until those settings have been read: the switch's resting position and an empty
// field are not the platform's state, and saving them would overwrite it. DS10 moved this read
// from startup to the first opening of the page, which put the gap in front of the admin. A card
// whose settings could not be read stays closed and says so.
function setControlsCardReady(id, ready) {
  const set = qs(id);
  if (!set) return;
  set.disabled = !ready;
  set.setAttribute("aria-busy", "false");
}

function reportAppConfigUnread() {
  const label = qs("maintenanceLabel");
  if (label) label.textContent = "Maintenance mode: could not be read - reload the page to try again";
  setControlsCardReady("maintenanceSet", false);
  setControlsCardReady("welcomeSet", false);
  setControlsCardReady("featureFlagsSet", false);
}

async function loadAppConfigSection() {
  try {
    const r = await api("/app-config");
    if (!r.ok) {
      reportFeatureFlagLoadFailure("the server did not return a config");
      reportAppConfigUnread();
      return;
    }
    const c = r.config;

    const toggle = qs("maintenanceToggle");
    const msg = qs("maintenanceMessageInput");
    if (toggle) toggle.checked = !!c.maintenanceMode;
    superRenderMaintenance(!!c.maintenanceMode);
    if (msg) msg.value = c.maintenanceMessage || "";
    setControlsCardReady("maintenanceSet", true);

    const wa = c.welcomeAnnouncement || {};
    if (qs("welcomeVersion")) qs("welcomeVersion").value = wa.version || "";
    if (qs("welcomeTitleInput")) qs("welcomeTitleInput").value = wa.title || "";
    if (qs("welcomeBodyInput")) qs("welcomeBodyInput").value = wa.body || "";
    if (qs("welcomeEnabled")) qs("welcomeEnabled").checked = wa.enabled !== false;
    setControlsCardReady("welcomeSet", true);

    // An empty or absent map is a LOAD FAILURE, not "all flags are off". An unauthenticated or
    // expired-session GET returns exactly that, and treating it as real state is what allowed a
    // panel showing nineteen unchecked boxes to be saved over a live configuration.
    if (!c.featureFlags || Object.keys(c.featureFlags).length === 0) {
      reportFeatureFlagLoadFailure("the server returned no flags");
      setControlsCardReady("featureFlagsSet", false);
    } else {
      loadFeatureFlagsSection(c.featureFlags);
      setControlsCardReady("featureFlagsSet", true);
    }
  } catch (err) {
    console.warn("App config load fail:", err.message);
    reportFeatureFlagLoadFailure(err.message || "network error");
    reportAppConfigUnread();
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
    setControlsCardReady("desktopReleaseSet", true);
  } catch (err) {
    console.warn("Desktop release draft load fail:", err.message);
    const live = qs("desktopReleaseLive");
    if (live) live.textContent = "The saved release could not be read - reload the page to try again.";
    setControlsCardReady("desktopReleaseSet", false);
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
  const msgInput = qs("maintenanceMessageInput");
  const saveMsgBtn = qs("saveMaintenanceBtn");
  const msgStatus = qs("maintenanceStatus");

  if (toggle) {
    toggle.addEventListener("change", async () => {
      const want = toggle.checked;
      const prev = !want;
      // The switch stays where the server has it while the question is open, and moves only once
      // the change is saved: it read "on" behind a dialog asking whether to turn it on.
      toggle.checked = prev;
      // A platform-wide switch: ON puts every user behind the maintenance screen and the API
      // refuses their work. It used to PATCH production on the first click, on the page this
      // panel opened to. It asks first, and declining makes NO network request (DS6). DS24: the
      // reason is required and recorded with the change, and turning it on also asks for the
      // environment's name to be typed.
      const scope = superScope();
      const where = `${scope.label.toLowerCase()}, ${scope.host}`;
      const reason = await superAskText(
        want
          ? {
              title: "Turn on maintenance mode?",
              body: [
                `Every user will see the maintenance screen and cannot work until it is turned off (${where}).`,
                "Signing in, unsubscribe links and this panel keep working.",
              ],
              label: "Reason (recorded with the change)",
              placeholder: "For example: database upgrade, about 15 minutes",
              required: true,
              maxLength: 300,
              requireText: scope.word,
              confirmLabel: "Turn on maintenance",
              cancelLabel: "Keep it off",
              tone: "danger",
            }
          : {
              title: "Turn off maintenance mode?",
              body: `Every user gets full access again (${where}).`,
              label: "Reason (recorded with the change)",
              placeholder: "For example: upgrade finished",
              required: true,
              maxLength: 300,
              confirmLabel: "Turn off maintenance",
              cancelLabel: "Keep it on",
              tone: "warning",
            },
      );
      if (reason === null) {
        toggle.checked = prev;
        return;
      }
      toggle.disabled = true;
      try {
        const r = await api("/app-config/maintenance", {
          method: "PATCH",
          body: { maintenanceMode: want, reason },
        });
        if (r.ok) {
          toggle.checked = !!r.maintenanceMode;
          superRenderMaintenance(!!r.maintenanceMode);
          superStatus(
            msgStatus,
            r.maintenanceMode
              ? "Maintenance mode is now ON. All users will see the maintenance screen."
              : "Maintenance mode is OFF. Users have full access.",
            r.maintenanceMode ? "warning" : "success",
          );
          loadControlChanges();
        } else {
          toggle.checked = prev;
        }
      } catch (err) {
        toggle.checked = prev;
        superStatus(msgStatus, err.message || "Maintenance mode could not be changed. Try again.", "critical");
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
        superStatus(msgStatus, "Message saved. Users see it while maintenance mode is on.", "success");
        loadControlChanges();
      } catch (err) {
        superStatus(msgStatus, err.message || "The message could not be saved. Try again.", "critical");
      } finally {
        saveMsgBtn.disabled = false;
        saveMsgBtn.textContent = "Save message";
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
        superStatus(welcomeStatus, "Saved. Users with a different seen-version will see this on next popup open.", "success");
      } catch (err) {
        superStatus(welcomeStatus, err.message || "The announcement could not be saved. Try again.", "critical");
      } finally {
        saveWelcomeBtn.disabled = false;
        saveWelcomeBtn.textContent = "Save announcement";
      }
    });
  }

  const saveFeatureFlagsBtn = qs("saveFeatureFlagsBtn");
  const featureFlagsStatus = qs("featureFlagsStatus");
  if (saveFeatureFlagsBtn) {
    saveFeatureFlagsBtn.addEventListener("click", async () => {
      // REFUSE to save when the current state was never loaded. This is the single most
      // important line in this file, and it replaces a `!lastFeatureFlags ||` guard that did the
      // exact opposite.
      //
      // What that guard did, on 2026-08-26, against production: loadAppConfigSection() returns
      // early on `!r.ok` and swallows any throw into a console.warn, so a failed load leaves
      // lastFeatureFlags at its initial null AND leaves all 19 checkboxes at their unchecked HTML
      // default. The operator then sees a panel that looks like "every feature is off", flips one
      // flag, and presses Save. `!lastFeatureFlags` was true for EVERY key, so the diff sent all
      // nineteen -- eighteen of them false -- and the backend faithfully applied them. Twelve live
      // features, including GST reconciliation, TDS health, notice cases and audit working papers,
      // were switched off in production by someone who changed one checkbox.
      //
      // The backend was never at fault: updateFeatureFlags builds `featureFlags.<key>` dot-paths
      // only for keys present in the body, so a true partial merge was already there. The panel
      // sent eighteen keys it had never loaded.
      //
      // "I do not know the current state" must therefore mean STOP, not "write my guess".
      if (!lastFeatureFlags) {
        superStatus(
          featureFlagsStatus,
          "Not saved. The current flag values could not be loaded, so the checkboxes above are " +
            "not showing the real state and saving them would overwrite it. Reload the page. If " +
            "that does not help, your session has probably expired -- sign in again.",
          "critical",
        );
        return;
      }

      // Diff against the last-loaded/saved state so only the flags the operator actually
      // flipped are sent -- updateFeatureFlags merges per-key and leaves the rest untouched,
      // so sending all 19 on every save would be safe but needlessly wide.
      const changed = {};
      for (const key of FEATURE_FLAG_KEYS) {
        const box = featureFlagCheckbox(key);
        if (!box) continue;
        if (lastFeatureFlags[key] !== box.checked) {
          changed[key] = box.checked;
        }
      }
      const changedKeys = Object.keys(changed);
      if (!changedKeys.length) {
        superStatus(featureFlagsStatus, "No changes to save.", "muted");
        return;
      }

      // DS24: a flag reaches every firm, so the change is confirmed with a reason the server
      // records and the environment's name typed. Declining sends nothing.
      const scope = superScope();
      const count = changedKeys.length === 1 ? "1 feature flag" : `${changedKeys.length} feature flags`;
      const turnsOff = changedKeys.some((key) => changed[key] === false);
      const reason = await superAskText({
        title: `Change ${count}?`,
        body: `The change applies to every firm and every user (${scope.label.toLowerCase()}, ${scope.host}).`,
        details: changedKeys.map((key) => `${key}: turn ${changed[key] ? "on" : "off"}`),
        label: "Reason (recorded with the change)",
        placeholder: "For example: TDS health is ready for firms",
        required: true,
        maxLength: 300,
        requireText: scope.word,
        confirmLabel: changedKeys.length === 1 ? "Change 1 flag" : `Change ${changedKeys.length} flags`,
        cancelLabel: "Keep the current flags",
        tone: turnsOff ? "danger" : "warning",
      });
      if (reason === null) return;

      saveFeatureFlagsBtn.disabled = true;
      saveFeatureFlagsBtn.textContent = "Saving...";
      try {
        const r = await api("/app-config/features", {
          method: "PATCH",
          body: { featureFlags: changed, reason },
        });
        loadFeatureFlagsSection(r.featureFlags);
        superStatus(
          featureFlagsStatus,
          `Saved: ${changedKeys.map((key) => `${key} ${r.featureFlags?.[key] ? "on" : "off"}`).join(", ")}.`,
          "success",
        );
        loadControlChanges();
      } catch (err) {
        // 403 says who may do this; anything else - the index-readiness rejection for
        // noticeCases/assuranceEngagements/auditWorkingPapers included - is the server's own
        // message, verbatim, rather than one invented here.
        superStatus(
          featureFlagsStatus,
          err.status === 403 ? "Only the super-admin account may change feature flags." : err.message || "The flags could not be saved. Try again.",
          "critical",
        );
      } finally {
        saveFeatureFlagsBtn.disabled = false;
        saveFeatureFlagsBtn.textContent = "Save feature flags";
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
        superStatus(
          desktopReleaseStatus,
          "Saved. Nothing has been sent to users yet -- press Notify all users when you are ready.",
          "success",
        );
      } catch (err) {
        superStatus(desktopReleaseStatus, err.message || "The release could not be saved. Try again.", "critical");
      } finally {
        saveDesktopReleaseBtn.disabled = false;
        saveDesktopReleaseBtn.textContent = "Save release";
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

      if (!version) {
        superStatus(desktopReleaseStatus, "Enter the version to announce, and save the release, before notifying.", "critical");
        return;
      }

      // Both gates in one dialog (U5, DS24): it says what happens and to whom, and its Notify
      // button stays off until the version is typed exactly. Cancel, Esc, or anything but the
      // exact version makes NO network request.
      const confirmed = await superAsk({
        title: `Notify every desktop user about version ${version}?`,
        body: [
          ...(alreadyAnnounced
            ? [`Version ${version} has already been announced -- notifying again will re-alert users who already dismissed it.`]
            : []),
          "Every CA PRO desktop app on an older build shows the update banner within a few minutes, and a Windows notification once. This cannot be undone.",
        ],
        requireText: version,
        requireLabel: `Type the version number exactly (${version}) to confirm`,
        confirmLabel: "Notify all users",
        cancelLabel: "Cancel",
        tone: "danger",
      });
      if (!confirmed) return;

      notifyDesktopReleaseBtn.disabled = true;
      notifyDesktopReleaseBtn.textContent = "Notifying...";
      try {
        await api("/app-config/desktop-release/notify", { method: "POST" });
        superStatus(
          desktopReleaseStatus,
          "Notified. Every desktop on an older build will see the update banner within a few minutes, and a Windows notification once.",
          "success",
        );
        await loadAppConfigSection();
      } catch (err) {
        superStatus(
          desktopReleaseStatus,
          err.status === 409 && err.data?.code === "RELEASE_INCOMPLETE"
            ? "Release is incomplete -- save a complete release (latest version, download URL, SHA-256, size) before notifying."
            : err.message || "The notification could not be sent. Try again.",
          "critical",
        );
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
          <div class="stat-label">Active, last 24 hours</div>
          <div class="stat-value">${superCount(u.dau)}</div>
          <div class="stat-sub">Daily active users</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">Active, last 7 days</div>
          <div class="stat-value">${superCount(u.wau)}</div>
          <div class="stat-sub">Weekly active users</div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-label">Active, last 30 days</div>
          <div class="stat-value">${superCount(u.mau)}</div>
          <div class="stat-sub">Monthly active users</div>
        </div>
        <div class="stat-card stat-primary">
          <div class="stat-label">Active, last 90 days</div>
          <div class="stat-value">${superCount(u.qau)}</div>
          <div class="stat-sub">Quarterly active users</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">Activation rate</div>
          <div class="stat-value">${u.activationRate}%</div>
          <div class="stat-sub">${superCount(u.totalEverActive)} of ${superCount(u.totalUsers)} users</div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-label">7-day retention</div>
          <div class="stat-value">${u.retentionRate}%</div>
          <div class="stat-sub">Of activated users</div>
        </div>
        <div class="stat-card stat-primary">
          <div class="stat-label">API calls</div>
          <div class="stat-value">${superCount(u.totalApiCalls || 0)}</div>
          <div class="stat-sub">Since tracking began</div>
        </div>
        <div class="stat-card stat-gold">
          <div class="stat-label">Users</div>
          <div class="stat-value">${superCount(u.totalUsers)}</div>
          <div class="stat-sub">Ever signed up</div>
        </div>
      `;
    }

    if (chartEl) {
      renderDayChart(chartEl, {
        rows: u.dailyActivity || [],
        windowDays: 14,
        series: [{ key: "count", label: "Users" }],
        caption: "Users by the day of their latest activity (UTC)",
        empty: "No activity recorded yet",
      });
    }

    if (topUsersEl) {
      const top = u.topUsers || [];
      if (!top.length) {
        topUsersEl.innerHTML = `<div class="admin-empty-line">No active users yet.</div>`;
      } else {
        topUsersEl.innerHTML = top
          .map(
            (user) => `
              <div class="provider-top__row">
                <div class="provider-top__who">
                  <div class="fw-semibold text-truncate">${escapeHtml(user.email || "—")}</div>
                  <div class="provider-figure__caption">${escapeHtml(superEnumLabel(user.role || "USER"))}${user.firmId?.handle ? " · @" + escapeHtml(user.firmId.handle) : ""}</div>
                </div>
                <div class="provider-top__calls">${superCount(user.totalApiCalls)}</div>
              </div>
            `
          )
          .join("");
      }
    }

    renderClientSplit(u);
    renderWorkflowBreakdown(u.workflowBreakdown || []);
    renderPerUserUsage(u.perUser || []);
  } catch (err) {
    console.error("Usage stats error:", err);
    if (statusEl) statusEl.textContent = err.message || "Failed to load usage stats.";
  }
}

// ─── Client-split + per-user usage (WorkflowUsage-backed) ───────────
const WORKFLOW_USAGE_LABELS = {
  import: "Imports",
  gst_recon: "GST reconciliation",
  tds_health: "TDS health",
  notice_case: "Notices and cases",
  compliance_calendar: "Compliance calendar",
  task: "Tasks",
  digest_view: "Digest view",
  audit_review: "Audit and assurance",
  export: "Exports",
  ocr_consent: "OCR (consented)",
  downloader_run: "GST downloader runs",
};

function renderClientSplit(u) {
  const gridEl = qs("clientSplitGrid");
  const chartEl = qs("clientSplitChart");
  const split = u.clientSplit || {};
  if (!gridEl || !chartEl) return;

  const cards = [
    { key: "daily", label: "Today", split: split.daily },
    { key: "weekly", label: "Last 7 days", split: split.weekly },
    { key: "monthly", label: "Last 30 days", split: split.monthly },
  ];
  gridEl.innerHTML = cards
    .map((c) => {
      const desktop = c.split?.desktop ?? 0;
      const extension = c.split?.extension ?? 0;
      return `
        <div class="stat-card flex-fill" style="min-width:140px">
          <div class="stat-label">${c.label}</div>
          <div class="d-flex gap-3">
            <div><span class="provider-figure__value">${superCount(desktop)}</span><span class="provider-figure__caption d-block">Desktop</span></div>
            <div><span class="provider-figure__value">${superCount(extension)}</span><span class="provider-figure__caption d-block">Extension</span></div>
          </div>
        </div>
      `;
    })
    .join("");

  renderDayChart(chartEl, {
    rows: u.dailyActivityByClient || [],
    windowDays: 14,
    series: [
      { key: "desktop", label: "Desktop" },
      { key: "extension", label: "Extension" },
    ],
    caption: "Distinct users per day by app (UTC)",
    empty: "No workflow usage recorded yet — rows appear once workflows run on the new tracking",
  });
}

// ─── Day charts: axes, a legend and the same figures as a table (DS10) ──
// The two analytics charts were bare bars: no scale, no legend for the client split, a day with
// no activity silently missing from the row, and the figures readable only by hovering. One
// renderer now draws both. Every UTC day of the window is on the x-axis (a quiet day is a zero,
// not a gap), the y-axis carries a labelled scale, a chart with more than one series gets a
// legend, and the figures sit in a real table under the bars - its header row is the x-axis, so
// each figure lines up with its bar. The bars are decoration for sighted readers; the table is
// what a screen reader reads.
const DAY_CHART_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

// The window's UTC day keys, oldest first: windowDays days ending today, widened to take in any
// day the server returned outside it (a partial first day, a clock a little ahead), so nothing
// that came back is dropped.
function dayChartKeys(rows, windowDays, today = new Date()) {
  const returned = rows
    .map((row) => String(row?._id || ""))
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort();
  let end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let start = end - (windowDays - 1) * DAY_MS;
  if (returned.length) {
    start = Math.min(start, Date.parse(`${returned[0]}T00:00:00Z`));
    end = Math.max(end, Date.parse(`${returned[returned.length - 1]}T00:00:00Z`));
  }
  const keys = [];
  for (let at = start; at <= end; at += DAY_MS) keys.push(new Date(at).toISOString().slice(0, 10));
  return keys;
}

// Whole-number ticks from 0 at a step of 1, 2 or 5 x 10^n, at most four steps; the last tick is
// the top of the scale.
function dayChartTicks(max) {
  const top = Math.max(1, Math.ceil(Number(max) || 0));
  let step = 1;
  for (let power = 1; ; power *= 10) {
    const found = [1, 2, 5].map((m) => m * power).find((candidate) => top / candidate <= 4);
    if (found) { step = found; break; }
  }
  const ticks = [];
  for (let value = 0; ; value += step) {
    ticks.push(value);
    if (value >= top) break;
  }
  return ticks;
}

function dayChartLabel(key) {
  return { day: Number(key.slice(8, 10)), month: DAY_CHART_MONTHS[Number(key.slice(5, 7)) - 1] || "" };
}

function renderDayChart(container, { rows, windowDays, series, caption, empty }) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="day-chart__empty">${escapeHtml(empty)}</div>`;
    return;
  }
  const byDay = new Map(rows.map((row) => [String(row._id), row]));
  const keys = dayChartKeys(rows, windowDays);
  const values = keys.map((key) => series.map((s) => Math.max(0, Number(byDay.get(key)?.[s.key]) || 0)));
  const ticks = dayChartTicks(Math.max(...values.flat()));
  const top = ticks[ticks.length - 1];
  const first = dayChartLabel(keys[0]);
  const last = dayChartLabel(keys[keys.length - 1]);
  const span = `${first.day} ${first.month} to ${last.day} ${last.month}`;
  const legend = series.length > 1
    ? `<ul class="day-chart__legend">${series.map((s, i) => `<li><span class="day-chart__swatch day-chart__bar--s${i}" aria-hidden="true"></span>${escapeHtml(s.label)}</li>`).join("")}</ul>`
    : "";
  const axis = ticks
    .map((tick) => `<span class="day-chart__tick" style="bottom:${(tick / top) * 100}%">${tick}</span>`)
    .join("");
  const grid = ticks
    .map((tick) => `<span class="day-chart__gridline" style="bottom:${(tick / top) * 100}%"></span>`)
    .join("");
  const bars = keys
    .map((key, k) => `<div class="day-chart__day">${series
      .map((s, i) => `<span class="day-chart__bar day-chart__bar--s${i}" style="height:${(values[k][i] / top) * 100}%"></span>`)
      .join("")}</div>`)
    .join("");
  const head = keys
    .map((key) => {
      const label = dayChartLabel(key);
      return `<th scope="col" data-day="${key}"><span>${label.day}</span><span>${label.month}</span></th>`;
    })
    .join("");
  const body = series
    .map((s, i) => `<tr><th scope="row"><span class="day-chart__swatch day-chart__bar--s${i}" aria-hidden="true"></span>${escapeHtml(s.label)}</th>${keys
      .map((key, k) => `<td>${values[k][i]}</td>`)
      .join("")}</tr>`)
    .join("");
  container.innerHTML = `
    ${legend}
    <div class="day-chart__frame">
      <div class="day-chart__plot" aria-hidden="true">
        <div class="day-chart__axis">${axis}</div>
        <div class="day-chart__bars" style="--days:${keys.length}">${grid}${bars}</div>
      </div>
      <table class="day-chart__table">
        <caption>${escapeHtml(caption)}, ${span}</caption>
        <thead><tr><th scope="col">Day</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderWorkflowBreakdown(rows) {
  const el = qs("workflowBreakdownList");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="admin-empty-line">No workflow usage recorded yet.</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (row) => `
        <div class="provider-top__row">
          <div class="provider-top__who">${escapeHtml(WORKFLOW_USAGE_LABELS[row.workflow] || row.workflow)}</div>
          <div class="text-end">
            <span class="provider-top__calls">${superCount(row.weekActive)}</span>
            <span class="provider-figure__caption ms-1">users · ${superCount(row.totalCounts)} runs${row.errorCounts ? ` · ${superCount(row.errorCounts)} errored` : ""}</span>
          </div>
        </div>`,
    )
    .join("");
}

// ─── Emails page (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1) ────────────
// One list request carries the summary for the same window, so the page load
// costs a single call; the detail drawer and the suppressions list load only
// when opened. Recipient search hashes the exact address client-side — the
// server never receives, stores, or displays a raw address.
const emailsPageState = { page: 1, pages: 1, loaded: false, suppressionsLoaded: false, lastRows: [] };

const EMAIL_TYPE_LABELS = {
  otp: "OTP", reminder: "Reminder", daily_digest: "Daily digest",
  weekly_digest: "Weekly digest", test_digest: "Test digest",
  digest_activation: "Digest activation", test_email: "Test email",
  reminder_alert: "Delivery alert", rollout_notice: "Rollout notice",
  campaign: "Campaign", other: "Other",
};
// A delivery state as a badge tone; an unknown state is shown as sent, in the neutral badge.
const EMAIL_STATUS_TONES = {
  sent: "", delivered: "success", queued: "",
  bounced: "critical", complained: "critical", failed: "critical",
};

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text).trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function emailsQueryString(includePage) {
  const from = qs("emailsFrom")?.value || "";
  const to = qs("emailsTo")?.value || "";
  const type = qs("emailsType")?.value || "";
  const status = qs("emailsStatusFilter")?.value || "";
  const recipient = qs("emailsRecipient")?.value || "";
  const params = new URLSearchParams();
  if (from) params.set("from", `${from}T00:00:00Z`);
  if (to) params.set("to", `${to}T23:59:59Z`);
  if (type) params.set("types", type);
  if (status) params.set("statuses", status);
  if (recipient) params.set("recipientHash", await sha256Hex(recipient));
  if (includePage) params.set("page", String(emailsPageState.page));
  const q = params.toString();
  return q ? `?${q}` : "";
}

async function loadEmailsPage({ resetPage = true } = {}) {
  const statusEl = qs("emailsStatus");
  const body = qs("emailsBody");
  if (!body) return;
  if (resetPage) emailsPageState.page = 1;
  try {
    if (statusEl) statusEl.textContent = "Loading emails...";
    const query = await emailsQueryString(true);
    const data = await api(`/super/emails${query}`);
    if (!data.ok) throw new Error("Failed to load emails");
    emailsPageState.loaded = true;
    emailsPageState.pages = data.pages || 1;
    emailsPageState.lastRows = data.emails || [];
    if (statusEl) statusEl.textContent = "";
    renderEmailsSummary(data.summary || {});
    renderEmailsRows(emailsPageState.lastRows);
    const info = qs("emailsPageInfo");
    if (info) info.textContent = `Page ${data.page} of ${data.pages} — ${data.total} email(s)`;
    const prev = qs("emailsPrevBtn");
    const next = qs("emailsNextBtn");
    if (prev) prev.disabled = (data.page || 1) <= 1;
    if (next) next.disabled = (data.page || 1) >= data.pages;
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Failed to load emails.";
  }
}

function renderEmailsSummary(summary) {
  const strip = qs("emailsSummaryStrip");
  const banner = qs("emailsBounceBanner");
  if (!strip) return;
  const cards = [
    ["Sent", summary.sent], ["Delivered", summary.delivered], ["Queued", summary.queued],
    ["Bounced", summary.bounced], ["Complained", summary.complained], ["Failed", summary.failed],
    ["Bounce rate", `${summary.bounceRate || 0}%`],
  ];
  strip.innerHTML = cards
    .map(([label, value]) => `
      <div class="stat-card stat-primary">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value ?? 0}</div>
      </div>`)
    .join("");
  if (banner) {
    // An elevated bounce rate is how a dead domain or a stale list shows up.
    const tooHigh = (summary.bounceRate || 0) > 5;
    banner.hidden = !tooHigh;
    if (tooHigh) {
      banner.textContent = `Bounce rate for this window is ${summary.bounceRate}% — check the suppressed addresses and the sending domain.`;
    }
  }
}

function renderEmailsRows(rows) {
  const body = qs("emailsBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="text-muted">No emails in this window. Adjust the filters, or note that records start from this release (Resend keeps only 30 days of history).</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((row) => {
      const when = row.sentAt || row.createdAt;
      const time = when ? new Date(when).toISOString().slice(0, 16).replace("T", " ") : "—";
      const firm = row.firmId?.handle || (row.firmId?.displayName ? String(row.firmId.displayName) : "—");
      const statusTone = EMAIL_STATUS_TONES[row.status] || "";
      const providerId = row.providerMessageId || "";
      return `
        <tr>
          <td>${time}</td>
          <td>${EMAIL_TYPE_LABELS[row.type] || escapeHtml(row.type)}</td>
          <td>••••${escapeHtml(row.recipientEmailLast4 || "")}</td>
          <td>${escapeHtml(firm)}</td>
          <td><span class="cp-badge"${statusTone ? ` data-tone="${statusTone}"` : ""}>${escapeHtml(row.status || "—")}</span></td>
          <td>${escapeHtml(row.errorClass || "—")}</td>
          <td class="usage-email" title="${escapeHtml(providerId)}">${providerId ? `<code>${escapeHtml(providerId.slice(0, 10))}…</code>` : "—"}</td>
          <td><button class="btn btn-sm btn-outline-secondary email-detail-btn" type="button" data-id="${String(row._id)}">Details</button></td>
        </tr>`;
    })
    .join("");
  body.querySelectorAll(".email-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEmailDetail(btn.getAttribute("data-id")));
  });
}

async function openEmailDetail(id) {
  const overlay = qs("emailDetailOverlay");
  const bodyEl = qs("emailDetailBody");
  if (!overlay || !bodyEl) return;
  overlay.hidden = false;
  bodyEl.innerHTML = `<div class="text-muted">Loading...</div>`;
  try {
    const data = await api(`/super/emails/${encodeURIComponent(id)}`);
    if (!data.ok) throw new Error("Failed to load email detail");
    const row = data.email;
    const timeline = (row.timeline || [])
      .map((entry) => `<li><strong>${escapeHtml(entry.event)}</strong> — ${entry.at ? new Date(entry.at).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—"}</li>`)
      .join("");
    bodyEl.innerHTML = `
      <dl class="row mb-3">
        <dt class="col-5">Type</dt><dd class="col-7">${EMAIL_TYPE_LABELS[row.type] || escapeHtml(row.type)}</dd>
        <dt class="col-5">Status</dt><dd class="col-7">${escapeHtml(row.status)}</dd>
        <dt class="col-5">Error class</dt><dd class="col-7">${escapeHtml(row.errorClass || "—")}</dd>
        <dt class="col-5">To (suffix only)</dt><dd class="col-7">••••${escapeHtml(row.recipientEmailLast4 || "")}</dd>
        <dt class="col-5">Provider id</dt><dd class="col-7 text-break">${escapeHtml(row.providerMessageId || "—")}</dd>
        <dt class="col-5">Source</dt><dd class="col-7">${row.backfilled ? "Backfilled from provider history" : "Recorded at send time"}</dd>
      </dl>
      <h3 class="admin-section-title">Timeline</h3>
      <ul class="mb-0">${timeline || "<li>No events recorded</li>"}</ul>
    `;
  } catch (err) {
    bodyEl.innerHTML = `<div class="text-danger">${escapeHtml(err.message || "Failed to load email detail.")}</div>`;
  }
}

async function loadEmailSuppressions() {
  const body = qs("suppressionsBody");
  if (!body) return;
  try {
    const data = await api("/super/emails/suppressions");
    if (!data.ok) throw new Error("Failed to load suppressions");
    const rows = data.suppressions || [];
    emailsPageState.suppressionsLoaded = true;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="4" class="text-muted">No suppressed addresses.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.reason)}</td>
          <td>${row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : "—"}</td>
          <td>${row.firmId ? "This firm" : "Global"}</td>
          <td><button class="btn btn-sm btn-outline-danger suppression-remove-btn" type="button" data-id="${String(row.id)}">Remove</button></td>
        </tr>`)
      .join("");
    body.querySelectorAll(".suppression-remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const remove = await superAsk({
          title: "Remove this address from the do-not-email list?",
          body: "Future emails to this address will no longer be blocked. The removal is recorded.",
          confirmLabel: "Remove from the list",
          cancelLabel: "Keep it blocked",
          tone: "danger",
        });
        if (!remove) return;
        btn.disabled = true;
        try {
          await api(`/super/emails/suppressions/${encodeURIComponent(btn.getAttribute("data-id"))}`, { method: "DELETE" });
          superToast("Removed from the do-not-email list.");
          await loadEmailSuppressions();
        } catch (err) {
          superToast(err.message || "The address could not be removed. Try again.", "critical");
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted">${escapeHtml(err.message || "Failed to load suppressions.")}</td></tr>`;
  }
}

function bindEmailsPageControls() {
  const apply = qs("emailsApplyBtn");
  if (apply) apply.addEventListener("click", () => loadEmailsPage());
  const reset = qs("emailsResetBtn");
  if (reset) {
    reset.addEventListener("click", () => {
      for (const id of ["emailsFrom", "emailsTo", "emailsType", "emailsStatusFilter", "emailsRecipient"]) {
        const el = qs(id);
        if (el) el.value = "";
      }
      loadEmailsPage();
    });
  }
  const prev = qs("emailsPrevBtn");
  if (prev) prev.addEventListener("click", () => { emailsPageState.page -= 1; loadEmailsPage({ resetPage: false }); });
  const next = qs("emailsNextBtn");
  if (next) next.addEventListener("click", () => { emailsPageState.page += 1; loadEmailsPage({ resetPage: false }); });
  const close = qs("emailDetailCloseBtn");
  if (close) close.addEventListener("click", () => { const o = qs("emailDetailOverlay"); if (o) o.hidden = true; });
  const csv = qs("emailsCsvBtn");
  if (csv) {
    csv.addEventListener("click", () => {
      const rows = emailsPageState.lastRows || [];
      const headers = ["Date/time (UTC)", "Type", "To (suffix)", "Firm", "Status", "Error class", "Provider id"];
      const data = rows.map((row) => [
        (row.sentAt || row.createdAt) ? new Date(row.sentAt || row.createdAt).toISOString() : "",
        row.type || "",
        row.recipientEmailLast4 || "",
        row.firmId?.handle || row.firmId?.displayName || "",
        row.status || "",
        row.errorClass || "",
        row.providerMessageId || "",
      ]);
      globalThis.CaProFiles.downloadCsv("email-deliveries.csv", headers, data);
    });
  }
}

function renderPerUserUsage(rows) {
  const body = qs("perUserUsageBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-muted">No usage recorded yet. Rows appear as people run workflows.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((row) => {
      const lastSeen = row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
      return `
        <tr>
          <td class="usage-email" title="${escapeHtml(row.email || row.name || String(row.userId))}">${escapeHtml(row.email || row.name || String(row.userId))}</td>
          <td>${superCount(row.desktopCount || 0)}</td>
          <td>${superCount(row.extensionCount || 0)}</td>
          <td class="usage-total">${superCount(row.totalCount || 0)}</td>
          <td>${superCount(row.workflows || 0)}</td>
          <td class="text-muted">${lastSeen}</td>
        </tr>`;
    })
    .join("");
}

// ─── Provider Usage (O10 spend meter/cap) ────────────────────────────
const PROVIDER_USAGE_LABELS = { DEEPSEEK: "DeepSeek", OCR_SPACE: "OCR.space" };

function renderProviderUsageTopUsers(rows) {
  if (!rows.length) {
    return `<div class="admin-empty-line">No calls yet today.</div>`;
  }
  return rows
    .map(
      (row) => `
        <div class="provider-top__row">
          <div class="provider-top__who">${escapeHtml(row.email || "—")}</div>
          <div class="provider-top__calls">${superCount(Number(row.calls) || 0)}</div>
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
              <div class="card p-3 mb-0 h-100">
                <h3 class="admin-section-title">${escapeHtml(PROVIDER_USAGE_LABELS[provider])}</h3>
                <div class="d-flex gap-4 mb-2">
                  <div>
                    <div class="provider-figure__value">${superCount(today)}</div>
                    <div class="provider-figure__caption">calls today</div>
                  </div>
                  <div>
                    <div class="provider-figure__value">${superCount(month)}</div>
                    <div class="provider-figure__caption">calls this month</div>
                  </div>
                </div>
                <div class="provider-top__heading">Top users today</div>
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

// ─── Reminder Delivery Health (T2 (.kiro/PLAN.md): fleet-wide delivery-failure
// visibility) ──────────────────────────────────────────────────────
// One definition of "a reminder has a delivery problem" lives server-side in
// reminder.controller.js's deliveryHealth(); this card only renders what
// GET /api/super/reminder-delivery-health already classified.
const REMINDER_DELIVERY_STATUS_TONES = {
  RETRY_SCHEDULED: "warning",
  DELIVERY_STATE_UNCONFIRMED: "critical",
  STALE_CLAIM: "critical",
  HISTORICAL_ATTEMPTS_PRESENT: "",
};

// dueDateISO is a statutory reminder date, not an activity timestamp -- converting it through
// a local-timezone Date object can move it across a day boundary into a different return
// period, so the stored UTC calendar day is read straight off the string instead.
function formatReminderDueDateUtc(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "—";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function renderReminderDeliveryHealthRow(row) {
  const issues = Array.isArray(row.issues) ? row.issues : [];
  const lastError = issues.map((i) => i.lastError).find((e) => e) || "";
  const tone = REMINDER_DELIVERY_STATUS_TONES[row.status] || "";
  const statusBadge = `<span class="cp-badge"${tone ? ` data-tone="${tone}"` : ""}>${escapeHtml(row.status || "—")}</span>`;
  return `
    <tr>
      <td>${formatReminderDueDateUtc(row.dueDateISO)}</td>
      <td>${escapeHtml(row.clientLabel || "—")}</td>
      <td><code class="small text-break">${escapeHtml(row.firmId || "—")}</code></td>
      <td><code class="small text-break">${escapeHtml(row.userId || "—")}</code></td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(lastError || "—")}</td>
    </tr>`;
}

async function loadReminderDeliveryHealthStats() {
  const statusEl = qs("reminderDeliveryHealthStatus");
  const bodyEl = qs("reminderDeliveryHealthBody");

  try {
    const data = await api("/super/reminder-delivery-health");
    if (!data.ok) throw new Error("Failed to load reminder delivery health");
    const d = data.delivery || {};
    const sample = Array.isArray(d.sample) ? d.sample : [];
    const truncated = !!d.candidatesScanTruncated;
    // A truncated scan only ever proves a floor, never the real total -- rendering a bare
    // number here would claim completeness the scan does not have.
    const countText = truncated ? `${Number(d.issueCount) || 0}+` : String(Number(d.issueCount) || 0);
    if (statusEl) statusEl.textContent = "";

    if (bodyEl) {
      const headline = `
        <div class="delivery-headline">
          <div class="delivery-headline__count">${countText}</div>
          <div class="delivery-headline__caption">reminder${countText === "1" ? "" : "s"} with a delivery problem${truncated ? ` (of ${(Number(d.candidatesScanned) || 0).toLocaleString("en-IN")} scanned -- scan capped, more may exist)` : ""}</div>
        </div>`;

      let body;
      if (!sample.length) {
        body = truncated
          ? `<div class="admin-empty-line">No delivery issues found among the candidates scanned before the scan hit its limit -- more reminders may exist beyond it and were not checked.</div>`
          : `<div class="admin-empty-line">No delivery problems right now.</div>`;
      } else {
        const truncatedNote = d.sampleTruncated
          ? `<div class="admin-hint">Showing ${sample.length} of ${countText} -- soonest due first.</div>`
          : "";
        body = `
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th scope="col">Due date</th>
                  <th scope="col">Client</th>
                  <th scope="col">Firm ID</th>
                  <th scope="col">User ID</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last error</th>
                </tr>
              </thead>
              <tbody>${sample.map(renderReminderDeliveryHealthRow).join("")}</tbody>
            </table>
          </div>
          ${truncatedNote}`;
      }

      bodyEl.innerHTML = headline + body;
    }
  } catch (err) {
    console.error("Reminder delivery health error:", err);
    if (statusEl) statusEl.textContent = err.message || "Failed to load reminder delivery health.";
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
        <div class="stat-label">Users</div>
        <div class="stat-value">${superCount(s.users.total)}</div>
        <div class="stat-sub">Active ${superCount(s.users.active)} · inactive ${superCount(s.users.inactive)}</div>
      </div>
      <div class="stat-card stat-gold">
        <div class="stat-label">Firms</div>
        <div class="stat-value">${superCount(s.firms.total)}</div>
        <div class="stat-sub">Active ${superCount(s.firms.active)}</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-label">Open tasks</div>
        <div class="stat-value">${superCount(s.tasks.active)}</div>
        <div class="stat-sub">All time ${superCount(s.tasks.total)}</div>
      </div>
      <div class="stat-card stat-danger">
        <div class="stat-label">Pending firm admins</div>
        <div class="stat-value">${superCount(s.users.pendingAdmins)}</div>
        <div class="stat-sub">Awaiting approval</div>
      </div>
      <div class="stat-card stat-primary">
        <div class="stat-label">Firm admins</div>
        <div class="stat-value">${superCount(s.users.firmAdmins)}</div>
        <div class="stat-sub">Active firm admins</div>
      </div>
      <div class="stat-card stat-gold">
        <div class="stat-label">Product access</div>
        <div class="stat-value">Free</div>
        <div class="stat-sub">All ${superCount(s.firms.total)} firms</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-label">Reminders</div>
        <div class="stat-value">${superCount(s.reminders.total)}</div>
        <div class="stat-sub">Scheduled in total</div>
      </div>
      <div class="stat-card stat-primary">
        <div class="stat-label">Last 7 days</div>
        <div class="stat-value">${superCount(s.users.recentSignups)}</div>
        <div class="stat-sub">New sign-ups · ${superCount(s.tasks.recentTasks)} tasks</div>
      </div>
    `;

    // Task status breakdown: the state in words and a tone; an unknown state is shown as sent.
    const statusTones = {
      NOT_STARTED: ["Not started", ""], WAITING_DOCS: ["Waiting for documents", "warning"],
      IN_PROGRESS: ["In progress", "accent"], FILED: ["Filed", "success"], CLOSED: ["Closed", "info"],
    };
    if (taskBreakdownEl) {
      const breakdown = s.tasks.statusBreakdown || [];
      if (!breakdown.length) {
        taskBreakdownEl.innerHTML = '<span class="text-muted small">No tasks yet</span>';
      } else {
        taskBreakdownEl.innerHTML = breakdown.map((item) => {
          const [label, tone] = statusTones[item._id] || [String(item._id ?? "—"), ""];
          return `<span class="cp-badge"${tone ? ` data-tone="${tone}"` : ""}>${escapeHtml(label)} · ${superCount(item.count)}</span>`;
        }).join("");
      }
    }

    // Service breakdown
    if (serviceBreakdownEl) {
      const services = s.tasks.serviceBreakdown || [];
      if (!services.length) {
        serviceBreakdownEl.innerHTML = '<span class="text-muted small">No tasks yet</span>';
      } else {
        serviceBreakdownEl.innerHTML = services.map((item) =>
          `<span class="cp-badge" data-tone="accent">${escapeHtml(item._id)} · ${superCount(item.count)}</span>`
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
    <tr data-id="${escapeHtml(user._id)}" data-email="${escapeHtml(user.email || "")}">
      <td>${escapeHtml(user.email || "—")}</td>
      <td>${escapeHtml(user.name || "—")}</td>
      <td>${escapeHtml(firmId)}</td>
      <td>${escapeHtml(created)}</td>
      <td class="row-actions">
        <button class="btn btn-sm btn-primary approve-btn" type="button">Approve</button>
        <button class="btn btn-sm btn-outline-danger revoke-btn" type="button">Decline</button>
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

    const email = row.dataset.email || "this account";

    if (btn.classList.contains("approve-btn")) {
      btn.disabled = true;
      btn.textContent = "Approving...";
      try {
        await approveAdmin(userId);
        row.classList.add("table-success");
        row.querySelectorAll("button").forEach(b => { b.disabled = true; });
        btn.textContent = "Approved";
        superToast(`${email} is now a firm admin.`);
      } catch (err) {
        superToast(err.message || "The request could not be approved. Try again.", "critical");
        btn.disabled = false;
        btn.textContent = "Approve";
      }
    }

    if (btn.classList.contains("revoke-btn")) {
      // Declining used to happen on the first click, with nothing asked (DS24).
      const decline = await superAsk({
        title: `Decline ${email}'s request to be a firm admin?`,
        body: "Their account stays, as an individual account with no firm. Its active or suspended state does not change.",
        confirmLabel: "Decline request",
        cancelLabel: "Keep it pending",
        tone: "danger",
      });
      if (!decline) return;
      btn.disabled = true;
      btn.textContent = "Declining...";
      try {
        await revokeAdmin(userId);
        row.classList.add("table-warning");
        row.querySelectorAll("button").forEach(b => { b.disabled = true; });
        btn.textContent = "Declined";
        superToast(`Declined ${email}'s request.`);
      } catch (err) {
        superToast(err.message || "The request could not be declined. Try again.", "critical");
        btn.disabled = false;
        btn.textContent = "Decline";
      }
    }
  });
}

// ─── Firms & Plans ──────────────────────────────────────────────────
async function loadFirms() {
  const data = await api("/super/firms");
  // The controller caps this list and reports the cap. Keep those fields: a
  // truncated list presented as complete is how a super admin concludes a firm
  // does not exist when it simply fell past the limit.
  return {
    firms: data.firms || [],
    totalFirms: Number(data.totalFirms) || (data.firms || []).length,
    returnedFirms: Number(data.returnedFirms) || (data.firms || []).length,
    truncated: Boolean(data.truncated),
    limit: Number(data.limit) || 0,
  };
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
  // The server refuses an erase without this exact confirmation token in the
  // body (super.controller deleteFirmForSuper) — sending it is what makes the
  // typed-confirmation flow below reach the endpoint instead of a 400.
  return api(`/super/firms/${encodeURIComponent(firmId)}`, { method: "DELETE", body: { confirmation: "ERASE_FIRM_DATA" } });
}

function renderFirmRow(firm) {
  const accessBadge = `<span class="cp-badge" data-tone="accent">Free · all tools</span>`;
  const activeBadge = firm.isActive
    ? `<span class="cp-badge" data-tone="success">Active</span>`
    : `<span class="cp-badge" data-tone="warning">Inactive</span>`;
  const ownerEmail = firm.owner?.email || "—";
  const ownerName = firm.owner?.name || "";
  const ownerDisplay = ownerName
    ? `${escapeHtml(ownerName)}<br><span class="text-muted small">${escapeHtml(ownerEmail)}</span>`
    : escapeHtml(ownerEmail);

  return `
    <tr data-firm-id="${escapeHtml(firm._id)}" data-firm-name="${escapeHtml(firm.displayName || "")}" data-firm-handle="${escapeHtml(firm.handle || "")}" data-active="${firm.isActive ? "1" : "0"}">
      <td><strong>${escapeHtml(firm.displayName || "—")}</strong></td>
      <td><code>@${escapeHtml(firm.handle || "—")}</code></td>
      <td>${ownerDisplay}</td>
      <td>${accessBadge}</td>
      <td>${activeBadge}</td>
      <td class="row-actions">
        <button class="btn btn-sm btn-outline-primary firm-users-btn" type="button">Users</button>
        <button class="btn btn-sm btn-outline-secondary firm-plan-btn" type="button">${firm.isActive ? "Deactivate" : "Activate"}</button>
        <button class="btn btn-sm btn-outline-danger firm-delete-btn" type="button">Erase</button>
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
    const activeBadge = u.isActive
      ? `<span class="cp-badge" data-tone="success">Active</span>`
      : `<span class="cp-badge" data-tone="warning">Inactive</span>`;
    const roleBadge = userRoleBadge(u.role);

    return `
      <tr data-user-id="${escapeHtml(u._id)}" data-firm-id="${escapeHtml(firmId)}" data-role="${escapeHtml(u.role || "")}" data-active="${u.isActive ? "1" : "0"}" data-email="${escapeHtml(u.email || "")}">
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${escapeHtml(u.name || "—")}</td>
        <td>${roleBadge}</td>
        <td>${escapeHtml(superEnumLabel(u.accountType))}</td>
        <td>${activeBadge}</td>
        <td>${escapeHtml(created)}</td>
        <td class="row-actions">
          <button class="btn btn-sm btn-outline-primary firm-user-toggle-admin" type="button">${isFirmAdmin ? "Remove admin role" : "Make admin"}</button>
          <button class="btn btn-sm btn-outline-secondary firm-user-toggle-active" type="button">${u.isActive ? "Deactivate" : "Activate"}</button>
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

    // The row says what it is (data-role, data-active); reading the state back out of the
    // rendered badges broke the moment the badges read as words instead of enum names.
    const email = row.dataset.email || "this user";

    if (btn.classList.contains("firm-user-toggle-admin")) {
      const isCurrentlyAdmin = row.dataset.role === "FIRM_ADMIN";
      const newRole = isCurrentlyAdmin ? "USER" : "FIRM_ADMIN";
      const confirmed = await superAsk(
        isCurrentlyAdmin
          ? {
              title: `Remove ${email}'s firm admin role?`,
              body: "They keep their account and lose the firm admin role.",
              confirmLabel: "Remove admin role",
              cancelLabel: "Keep the role",
              tone: "danger",
            }
          : {
              title: `Make ${email} a firm admin?`,
              body: "They get the firm admin role and the firm admin panel.",
              confirmLabel: "Make admin",
              cancelLabel: "Cancel",
            },
      );
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        await updateFirmUserApi(firmId, userId, { role: newRole });
        superToast(isCurrentlyAdmin ? `${email} is no longer a firm admin.` : `${email} is now a firm admin.`);
        await handleViewFirmUsers(firmId);
      } catch (err) {
        superToast(err.message || "The role could not be changed. Try again.", "critical");
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains("firm-user-toggle-active")) {
      const isCurrentlyActive = row.dataset.active === "1";
      const newActive = !isCurrentlyActive;
      const confirmed = await superAsk(
        newActive
          ? {
              title: `Activate ${email}?`,
              body: "They can sign in and work again.",
              confirmLabel: "Activate account",
              cancelLabel: "Cancel",
            }
          : {
              title: `Deactivate ${email}?`,
              body: "Every request they make is refused from now on, until the account is activated again. Nothing of theirs is deleted.",
              confirmLabel: "Deactivate account",
              cancelLabel: "Keep it active",
              tone: "danger",
            },
      );
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        await updateFirmUserApi(firmId, userId, { isActive: newActive });
        superToast(newActive ? `${email} is active again.` : `${email} is deactivated.`);
        await handleViewFirmUsers(firmId);
      } catch (err) {
        superToast(err.message || "The account could not be changed. Try again.", "critical");
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains("firm-user-delete")) {
      // Irreversible, so the address is typed (design rule 4). The server tombstones the account
      // rather than removing the row (deleteFirmUserForSuper), and the copy says so.
      const confirmed = await superAsk({
        title: `Delete ${email}'s account?`,
        body: [
          "Their name and email are cleared from the account, every session they have ends at once, and they are removed from every firm they belong to.",
          "Records of work they did stay with the firms, without their name. This cannot be undone.",
        ],
        requireText: row.dataset.email || "DELETE",
        requireLabel: row.dataset.email ? `Type ${row.dataset.email} to confirm` : "Type DELETE to confirm",
        confirmLabel: "Delete account",
        cancelLabel: "Keep the account",
        tone: "danger",
      });
      if (!confirmed) return;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        await deleteFirmUserApi(firmId, userId);
        row.remove();
        superToast(`${email}'s account was deleted.`);
      } catch (err) {
        superToast(err.message || "The account could not be deleted. Try again.", "critical");
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    }
  };
}

async function handleEditFirmPlan(firmId, rowEl) {
  // The button names the one change it makes; the old prompt asked the admin to type yes or no.
  const currentActive = rowEl.dataset.active === "1";
  const name = rowEl.dataset.firmName || "this firm";
  const confirmed = await superAsk(
    currentActive
      ? {
          title: `Deactivate ${name}?`,
          body: "Its members can no longer switch into the firm's workspace, and its join code stops working. Its data is kept, and you can activate it again.",
          confirmLabel: "Deactivate firm",
          cancelLabel: "Keep it active",
          tone: "danger",
        }
      : {
          title: `Activate ${name}?`,
          body: "Its members can switch into the firm's workspace again, and its join code works again.",
          confirmLabel: "Activate firm",
          cancelLabel: "Cancel",
        },
  );
  if (!confirmed) return;

  try {
    const updated = await updateFirmPlanApi(firmId, { isActive: !currentActive });
    rowEl.outerHTML = renderFirmRow(updated);
    superToast(updated.isActive ? `${name} is active.` : `${name} is deactivated.`);
  } catch (err) {
    superToast(err.message || "The firm could not be changed. Try again.", "critical");
  }
}

async function handleDeleteFirm(firmId, rowEl) {
  // The server's erase cascades every firm-scoped collection and is irreversible. The admin types
  // the firm's handle (design rule 4: the name of what is being destroyed, not a stock word);
  // deleteFirmApi then sends the ERASE_FIRM_DATA token the server itself checks.
  const name = rowEl.dataset.firmName || "this firm";
  const handle = rowEl.dataset.firmHandle || "";
  const word = handle || "ERASE";
  const confirmed = await superAsk({
    title: `Erase ${name} and all of its data?`,
    body: "Everything the firm holds is erased or anonymised, and its members lose access to it:",
    details: [
      "Tasks, reminders and notices",
      "Imports, reconciliations and their results",
      "Members' access to the firm",
      "This cannot be undone.",
    ],
    requireText: word,
    requireLabel: handle ? `Type the firm's handle (${handle}) to confirm` : "Type ERASE to confirm",
    confirmLabel: "Erase firm",
    cancelLabel: "Keep the firm",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    const data = await deleteFirmApi(firmId);
    // The server keeps the firm row when the cascade stops part-way, so that running it again
    // resumes it (deleteFirmForSuper answers ok: false with the receipt). Showing that as done
    // would claim an erasure that did not finish.
    if (data && data.ok === false) {
      superToast(`The erasure of ${name} stopped part-way. The firm is still listed: run Erase again to finish it.`, "critical");
      return;
    }
    rowEl.remove();
    superToast(`${name} and its data were erased.`);
  } catch (err) {
    superToast(err.message || "The firm could not be erased. Try again.", "critical");
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
  if (role === "SUPER_ADMIN") return `<span class="cp-badge" data-tone="provisional">Super admin</span>`;
  if (role === "FIRM_ADMIN") return `<span class="cp-badge" data-tone="accent">Firm admin</span>`;
  if (role === "USER" || !role) return `<span class="cp-badge">User</span>`;
  // An unknown role is shown as the server sent it, never folded into "User".
  return `<span class="cp-badge">${escapeHtml(role)}</span>`;
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
    ? `<span class="cp-badge" data-tone="warning">Never active</span>`
    : `${escapeHtml(lastActive)}${sinceLabel ? ` <span class="${dormant ? "text-danger" : "text-muted"} small">${escapeHtml(sinceLabel)}</span>` : ""}`;
  const statusBadge = u.isActive
    ? `<span class="cp-badge" data-tone="success">Active</span>`
    : `<span class="cp-badge" data-tone="warning">Disabled</span>`;
  const apiCalls = Number(u.totalApiCalls || 0).toLocaleString("en-IN");
  const firmCell = u.activeFirm
    ? `${escapeHtml(u.activeFirm.displayName || "—")} <span class="text-muted small">@${escapeHtml(u.activeFirm.handle || "")}</span>${u.activeFirm.kind === "PERSONAL" ? ` <span class="cp-badge">Personal</span>` : ""}`
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

async function loadPendingAdminsSection() {
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
}

async function loadFirmsSection() {
  const firmsBody = qs("firmsBody");
  const firmsStatus = qs("firmsStatus");
  try {
    const firmList = await loadFirms();
    const firms = firmList.firms;
    if (!firms.length) {
      if (firmsBody) firmsBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No firms found.</td></tr>`;
      if (firmsStatus) firmsStatus.textContent = "";
    } else {
      if (firmsBody) { firmsBody.innerHTML = firms.map(renderFirmRow).join(""); attachFirmHandlers(); }
      if (firmsStatus) {
        firmsStatus.textContent = firmList.truncated
          ? `Showing the ${firmList.returnedFirms} most recently created firms of ${firmList.totalFirms}. Older firms are not listed.`
          : "";
      }
    }
  } catch (err) {
    if (firmsStatus) firmsStatus.textContent = err.message || "Failed to load firms.";
  }
}

// ─── Each page loads its own data (DS10) ────────────────────────────
// The panel used to fetch every page's data at startup - about ten requests against the API's
// limiter of 50 per 15 minutes, so a few reloads could lock the super admin out of their own
// panel. Now a page's data is fetched the first time that page is opened, and startup asks only
// for the signed-in user and the page on screen.
const SUPER_PAGE_LOADERS = {
  overview: () => loadDashboardStats(),
  controls: () => Promise.all([loadAppConfigSection(), loadProviderUsageStats(), loadReminderDeliveryHealthStats(), loadControlChanges()]),
  analytics: () => loadUsageStats(),
  emails: () => Promise.all([loadEmailsPage(), loadEmailSuppressions()]),
  users: () => loadUserDirectory(),
  firms: () => loadFirmsSection(),
  approvals: () => loadPendingAdminsSection(),
  terms: () => loadTermsAcceptanceHistory(),
  review: () => loadSelfTestSection(),
};
const superPagesRequested = new Set();
let superSignedIn = false;

function superLoadPage(page) {
  // Nothing is fetched before the signed-in user is confirmed as a super admin.
  if (!superSignedIn) return;
  // The Emails page keeps its own flag, set only once its list has arrived, so a visit that
  // failed is retried on the next one - as it was before this change.
  if (page === "emails") {
    if (!emailsPageState.loaded) SUPER_PAGE_LOADERS.emails();
    return;
  }
  const loader = SUPER_PAGE_LOADERS[page];
  if (!loader || superPagesRequested.has(page)) return;
  superPagesRequested.add(page);
  Promise.resolve()
    .then(loader)
    .catch((err) => console.error(`Loading the ${page} page failed:`, err));
}

// ─── Init ───────────────────────────────────────────────────────────
async function initSuperPage() {
  if (!qs("superLogoutBtn")) return;

  const me = await ensureSuperAdminAuth();
  if (!me) return;

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
    if (!requireSuperAdmin(me)) { window.location.href = "/admin/admin.html"; return; }
    if (qs("superEmail")) qs("superEmail").textContent = me.email || "—";
    superRenderScope();

    bindAppConfigHandlers();
    bindUserDirectoryControls();
    bindTermsAcceptanceControls();
    bindEmailsPageControls();

    // Only the page on screen; the others load when they are opened.
    superSignedIn = true;
    superLoadPage(superShowPage(window.location.hash || `#${SUPER_DEFAULT_PAGE}`));
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
  button.textContent = selfTestIsRunning ? "Review running" : "Run deep review";
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

// The review page's controls are wired at startup and stay disabled until its latest run has been
// read; that read happens the first time the page is opened (DS10), through superLoadPage.
function bindSelfTestPanel() {
  const button = qs("runSelfTestBtn");
  const confirmation = qs("selfTestConfirm");
  if (!button || !confirmation) return;
  button.addEventListener("click", runSelfTest);
  confirmation.addEventListener("change", updateSelfTestControls);
  selfTestIsRunning = true;
  updateSelfTestControls();
}

async function loadSelfTestSection() {
  if (!qs("runSelfTestBtn") || !qs("selfTestConfirm")) return;
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

document.addEventListener("DOMContentLoaded", bindSelfTestPanel);


// ─── Send test email (admin diagnostics) ────────────────────────────
async function sendTestEmailNow() {
  const btn = qs("sendTestEmailBtn");
  const status = qs("sendTestEmailStatus");
  if (!btn) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Sending…";
  superStatus(status, "Sending a test email…", "muted");
  try {
    const data = await api("/super/send-test-email", { method: "POST" });
    // textContent: the provider's words are shown as text, so they are not escaped twice.
    if (data.ok) {
      superStatus(status, `Test email sent to ${data.to}. Check that inbox (and its spam folder) to confirm it arrived.`, "success");
    } else {
      superStatus(status, `The email provider refused the send: ${data.error || "no reason given"}`, "critical");
    }
  } catch (err) {
    superStatus(status, `The test email was not sent: ${err.message || "try again in a moment"}`, "critical");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = qs("sendTestEmailBtn");
  if (btn) btn.addEventListener("click", sendTestEmailNow);
});

/* =========================================================================
   Section routing and column sorting
   -------------------------------------------------------------------------
   This panel used to paint all eight sections at once - roughly 6,500px of
   page, growing without limit because the firms table renders every firm in
   the database. Nothing linked anywhere, so finding a section meant scrolling
   past everything before it, and no table could be reordered.

   The shell, the sidebar styling and the mobile breakpoint were already in
   admin.css, written for the firm panel and unused here, so this reuses them
   rather than inventing a second layout. The routing mirrors admin.js's
   showPage() for the same reason: two panels behaving differently is a worse
   outcome than either behaviour on its own.
   ========================================================================= */

const SUPER_PAGES = [
  "controls",
  "overview",
  "analytics",
  "emails",
  "users",
  "firms",
  "approvals",
  "terms",
  "review",
];
// Overview, not Controls: the panel used to open on the page holding the
// maintenance switch and every platform-wide setting (DS6). Reading comes
// first; Controls is one click away when it is wanted.
const SUPER_DEFAULT_PAGE = "overview";

function superShowPage(hash) {
  const wanted = String(hash || "").replace(/^#/, "");
  const page = SUPER_PAGES.includes(wanted) ? wanted : SUPER_DEFAULT_PAGE;
  for (const name of SUPER_PAGES) {
    const el = qs(`page-${name}`);
    if (el) el.hidden = name !== page;
  }
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) {
    sidebar.querySelectorAll("a").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("href") === `#${page}`);
      // A section that is not on screen is not the current location, and a
      // screen reader should not be told otherwise.
      if (a.getAttribute("href") === `#${page}`) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  return page;
}

// ---------------- Column sorting ----------------
//
// Sorting happens on the rows already in the DOM rather than by refetching.
// Two reasons: three of the five tables have no server-side sort to ask for,
// and re-sorting what is on screen cannot disagree with what the user is
// looking at. The User directory keeps its own server-side sort dropdown,
// which stays authoritative for that table - so its headers are left alone.

// A cell's text is what the user sees, so that is what is compared. Numbers,
// money and dates are detected so "9" does not sort after "10", and a blank
// or em-dash always sorts last regardless of direction - an empty cell is not
// a small value, it is an absent one.
// Every date in this panel is rendered with toLocaleDateString()/toLocaleString(),
// which follows the VIEWER's locale: d/m/y in India, m/d/y in the US. Date.parse
// reads a bare numeric date as m/d/y always, so on an Indian browser "11/8/2026"
// (11 August) sorted as 8 November, and "20/9/2026" was rejected outright as an
// invalid month and fell through to string sorting - putting two different
// orderings in one column. Rather than guess the order, ask the same API the
// cells were rendered with: format a date whose parts cannot be confused and see
// which field the browser puts first.
const SUPER_DATE_FIELD_ORDER = (function () {
  try {
    // 2001-02-03: year 2001, month 2, day 3 - three values that cannot be mistaken
    // for one another.
    const parts = new Date(2001, 1, 3).toLocaleDateString().match(/\d+/g);
    if (!parts || parts.length < 3) return ["d", "m", "y"];
    const order = parts.slice(0, 3).map((part) => {
      const value = Number(part);
      if (value === 2001 || value === 1) return "y";
      if (value === 2) return "m";
      if (value === 3) return "d";
      return "?";
    });
    return order.includes("?") ? ["d", "m", "y"] : order;
  } catch (error) {
    return ["d", "m", "y"];
  }
})();

// A cell is treated as a date only when the WHOLE cell is one, in a shape this
// panel actually renders. The old code accepted anything Date.parse liked that
// merely contained four digits, which silently sorted text columns as dates.
function superDateValue(raw) {
  const text = String(raw).trim();
  if (!text) return null;

  // ISO - unambiguous in every locale.
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    const iso = Date.parse(text);
    return Number.isNaN(iso) ? null : iso;
  }

  // A spelled-out month is unambiguous too ("3 September 2026", "September 3, 2026").
  if (/^(?:\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}|[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4})$/.test(text)) {
    const named = Date.parse(text);
    return Number.isNaN(named) ? null : named;
  }

  // Numeric d/m/y or m/d/y, optionally with a time - what toLocaleDateString and
  // toLocaleString produce.
  const match = text.match(
    /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i
  );
  if (!match) return null;

  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  let day = null;
  let month = null;
  let year = null;
  SUPER_DATE_FIELD_ORDER.forEach((field, index) => {
    if (field === "d") day = numbers[index];
    else if (field === "m") month = numbers[index];
    else if (field === "y") year = numbers[index];
  });
  if (day === null || month === null || year === null) return null;
  if (year < 100) year += year < 70 ? 2000 : 1900;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const meridiem = String(match[7] || "").toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const stamp = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isNaN(stamp) ? null : stamp;
}

function superSortKey(text) {
  const raw = String(text || "").trim();
  if (!raw || raw === "—" || raw === "-") return { empty: true, n: 0, s: "" };
  const cleaned = raw.replace(/[₹,\s]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return { empty: false, n: Number(cleaned), s: "" };
  const stamp = superDateValue(raw);
  if (stamp !== null) return { empty: false, n: stamp, s: "" };
  return { empty: false, n: null, s: raw.toLowerCase() };
}

function superCompare(a, b, direction) {
  if (a.empty && b.empty) return 0;
  if (a.empty) return 1;
  if (b.empty) return -1;
  const factor = direction === "desc" ? -1 : 1;
  if (a.n !== null && b.n !== null) return (a.n - b.n) * factor;
  return a.s.localeCompare(b.s) * factor;
}

function superSortTable(table, columnIndex, direction) {
  const body = table.tBodies[0];
  if (!body) return;
  const rows = Array.from(body.rows).filter((row) => row.cells.length > columnIndex);
  // Rows that do not participate (an "empty" placeholder, a detail row that
  // belongs under its parent) are left where they are rather than shuffled
  // into the middle of real data.
  const movable = rows.filter((row) => !row.hasAttribute("data-detail-row"));
  if (movable.length < 2) return;
  movable
    .map((row) => ({ row, key: superSortKey(row.cells[columnIndex].textContent) }))
    .sort((left, right) => superCompare(left.key, right.key, direction))
    .forEach(({ row }) => body.appendChild(row));
}

function superMakeSortable(table) {
  const head = table.tHead;
  if (!head || !head.rows.length) return;
  Array.from(head.rows[0].cells).forEach((cell, index) => {
    // The actions column holds buttons, not data; sorting by it is meaningless.
    if (/^\s*(actions?)\s*$/i.test(cell.textContent || "")) return;
    cell.classList.add("super-sortable");
    cell.setAttribute("aria-sort", "none");
    cell.tabIndex = 0;
    cell.setAttribute("role", "columnheader");
    cell.title = "Sort by this column";
    const activate = () => {
      const current = cell.getAttribute("aria-sort");
      const direction = current === "ascending" ? "desc" : "asc";
      Array.from(head.rows[0].cells).forEach((other) => {
        if (other !== cell) other.setAttribute("aria-sort", "none");
      });
      cell.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
      superSortTable(table, index, direction);
    };
    cell.addEventListener("click", activate);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function superInitSortableTables() {
  // The User directory is excluded on purpose: it already sorts server-side
  // across all pages, and a client-side sort of the visible 25 rows would
  // quietly disagree with the dropdown that says how the data is ordered.
  document.querySelectorAll("table").forEach((table) => {
    if (table.closest("#page-users")) return;
    // A day chart's table runs sideways - one column per day, in day order, under its bars - so
    // sorting its columns would only scramble the axis (DS10).
    if (table.classList.contains("day-chart__table")) return;
    if (table.dataset.superSortable === "1") return;
    table.dataset.superSortable = "1";
    superMakeSortable(table);
  });
}

function superInitNavigation() {
  if (!document.querySelector(".sidebar")) return;
  // Every page loads its own data the first time it is opened (DS10). Before sign-in is confirmed
  // superLoadPage does nothing; initSuperPage loads the page on screen once it is.
  superLoadPage(superShowPage(window.location.hash || `#${SUPER_DEFAULT_PAGE}`));
  window.addEventListener("hashchange", () => {
    superLoadPage(superShowPage(window.location.hash));
    // Landing on a section should start at its top, not wherever the previous
    // section happened to be scrolled to. The page scrolls, not .content (it never had a
    // height to scroll within), so its scrollTop reset did nothing (found in DS25).
    window.scrollTo(0, 0);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  superInitNavigation();
  // Rows arrive from several independent loaders, so headers are wired once
  // the first paint has settled and again on later mutations.
  setTimeout(superInitSortableTables, 0);
  const main = document.querySelector(".content") || document.body;
  const observer = new MutationObserver(() => superInitSortableTables());
  observer.observe(main, { childList: true, subtree: true });
});
