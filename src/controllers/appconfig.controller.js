// src/controllers/appconfig.controller.js
import { randomUUID } from "node:crypto";
import AppConfig, { DEFAULT_FEATURE_FLAGS } from "../models/AppConfig.js";
import { validateDesktopReleasePatch } from "../services/desktop-release.service.js";
import { assertCaseIndexesReady } from "../services/case-index-readiness.service.js";
import { assertEngagementIndexesReady } from "../services/engagement-index-readiness.service.js";
import { describeRetentionPolicy } from "../services/data-retention.service.js";
import User from "../models/User.js";

const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

function assertSuper(user) {
  if (!user || user.role !== "SUPER_ADMIN" || user.email !== SUPER_EMAIL) {
    const err = new Error("Super admin only");
    err.statusCode = 403;
    throw err;
  }
}

// Additive key #2 on this route (see the comment on dataRetention below for #1). Returns null
// unless the operator has actually finished and enabled an announcement -- a half-filled draft
// (missing a version, a URL or the server-stamped announcementId) is served as null so a client
// gets exactly one unambiguous "nothing announced" value rather than an object with a broken URL
// in it. enabled and updatedAt are deliberately omitted from the public shape: a block that
// reaches a client is by definition announced, so shipping enabled invites branching on a second,
// redundant flag, and updatedAt is operator bookkeeping with no client use.
function publishableDesktopRelease(release) {
  if (
    !release ||
    release.enabled !== true ||
    typeof release.latestVersion !== "string" ||
    release.latestVersion.length === 0 ||
    typeof release.downloadUrl !== "string" ||
    release.downloadUrl.length === 0 ||
    typeof release.announcementId !== "string" ||
    release.announcementId.length === 0
  ) {
    return null;
  }
  return {
    latestVersion: release.latestVersion,
    minSupportedVersion: release.minSupportedVersion || "",
    downloadUrl: release.downloadUrl,
    releaseNotes: release.releaseNotes || "",
    mandatory: release.mandatory === true,
    announcementId: release.announcementId,
    announcedAt: release.announcedAt || null,
    sha256: release.sha256 || "",
    sizeBytes: Number.isSafeInteger(release.sizeBytes) ? release.sizeBytes : 0,
  };
}

// Public-ish: returns safe app config (no auth required so even logged-out clients can detect maintenance).
export const getAppConfig = async (req, res, next) => {
  try {
    const cfg = await AppConfig.getInstance();
    const featureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      ...(cfg.featureFlags || {}),
    };

    return res.json({
      ok: true,
      config: {
        maintenanceMode: !!cfg.maintenanceMode,
        maintenanceMessage: cfg.maintenanceMessage || "",
        welcomeAnnouncement: cfg.welcomeAnnouncement || null,
        // Additive, third key of this kind on the route (dataRetention above is the first,
        // desktopRelease below the second): existing consumers read named keys
        // (maintenanceMode, welcomeAnnouncement, featureFlags), so an extra key is inert for
        // them (grep -rn "app-config" audit-nlp-extension/*.js confirms this). This route is
        // already public and already fetched by desktop and extension on launch, and a
        // signed-out shell must be able to learn its build is unsupported, so the update
        // announcement rides here rather than on a new authenticated route.
        desktopRelease: publishableDesktopRelease(cfg.desktopRelease),
        featureFlags,
        // Additive, and deliberately served from here rather than hardcoded in each
        // client. Both the desktop and the extension must state the same retention
        // rule, and two hardcoded copies drift; one source cannot. This route is
        // public and already fetched by both, so neither needs a new call.
        // Existing consumers read named keys, so an extra key is inert for them.
        dataRetention: describeRetentionPolicy(),
        updatedAt: cfg.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Authenticated: marks the current welcome version as seen for the user.
export const dismissWelcome = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const cfg = await AppConfig.getInstance();
    const version = cfg.welcomeAnnouncement?.version || "v1";

    await User.updateOne(
      { _id: req.user.id },
      { $set: { welcomeSeenVersion: version } },
    );

    return res.json({ ok: true, welcomeSeenVersion: version });
  } catch (err) {
    next(err);
  }
};

// Authenticated: dismisses the CURRENT desktop update announcement for this user, by
// announcement id rather than by version (see the comment on User.desktopUpdateSeenAnnouncementId
// for why). A mandatory update cannot be dismissed server-side at all.
export const dismissDesktopUpdate = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const cfg = await AppConfig.getInstance();
    const release = cfg.desktopRelease || {};

    if (!release.announcementId) {
      return res
        .status(409)
        .json({ ok: false, error: "There is no update announcement to dismiss." });
    }

    if (release.mandatory === true) {
      return res.status(409).json({
        ok: false,
        code: "MANDATORY_UPDATE",
        error: "This update is required, so it cannot be dismissed.",
      });
    }

    await User.updateOne(
      { _id: req.user.id },
      { $set: { desktopUpdateSeenAnnouncementId: release.announcementId } },
    );

    return res.json({
      ok: true,
      desktopUpdateSeenAnnouncementId: release.announcementId,
    });
  } catch (err) {
    next(err);
  }
};

// Super-only: update rollout flags without replacing unspecified values.
export const updateFeatureFlags = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const { featureFlags } = req.body || {};

    if (
      !featureFlags ||
      typeof featureFlags !== "object" ||
      Array.isArray(featureFlags)
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "featureFlags object is required" });
    }

    const unknownKeys = Object.keys(featureFlags).filter(
      (key) =>
        !Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, key),
    );
    if (unknownKeys.length) {
      return res.status(400).json({
        ok: false,
        error: `Unknown feature flags: ${unknownKeys.join(", ")}`,
      });
    }

    const update = {};
    for (const key of Object.keys(DEFAULT_FEATURE_FLAGS)) {
      if (Object.prototype.hasOwnProperty.call(featureFlags, key)) {
        if (typeof featureFlags[key] !== "boolean") {
          return res.status(400).json({
            ok: false,
            error: `Feature flag ${key} must be boolean`,
          });
        }
        update[`featureFlags.${key}`] = featureFlags[key];
      }
    }

    if (!Object.keys(update).length) {
      return res
        .status(400)
        .json({ ok: false, error: "No feature flags to update" });
    }

    if (featureFlags.noticeCases === true) {
      await assertCaseIndexesReady();
    }
    if (featureFlags.assuranceEngagements === true) {
      await assertEngagementIndexesReady();
    }
    if (featureFlags.auditWorkingPapers === true) {
      const { assertAuditWorkingPaperIndexesReady } =
        await import("../services/audit-working-paper-index-readiness.service.js");
      await assertAuditWorkingPaperIndexesReady();
    }

    const versionIncrements = {};
    if (Object.prototype.hasOwnProperty.call(featureFlags, "tdsHealth")) {
      versionIncrements["featureFlagVersions.tdsHealth"] = 1;
    }
    if (Object.prototype.hasOwnProperty.call(featureFlags, "noticeCases")) {
      versionIncrements["featureFlagVersions.noticeCases"] = 1;
      update["featureFlagPublicationFences.noticeCases"] = randomUUID();
    }
    if (
      Object.prototype.hasOwnProperty.call(featureFlags, "assuranceEngagements")
    ) {
      versionIncrements["featureFlagVersions.assuranceEngagements"] = 1;
      update["featureFlagPublicationFences.assuranceEngagements"] =
        randomUUID();
    }
    if (
      Object.prototype.hasOwnProperty.call(featureFlags, "auditWorkingPapers")
    ) {
      versionIncrements["featureFlagVersions.auditWorkingPapers"] = 1;
      update["featureFlagPublicationFences.auditWorkingPapers"] = randomUUID();
    }
    update.updatedBy = req.user.id;
    await AppConfig.findByIdAndUpdate(
      "singleton",
      {
        $set: update,
        ...(Object.keys(versionIncrements).length
          ? { $inc: versionIncrements }
          : {}),
      },
      { upsert: true, new: true },
    );
    AppConfig.invalidateCache();

    return res.json({
      ok: true,
      featureFlags: await AppConfig.getFeatureFlags(),
    });
  } catch (err) {
    next(err);
  }
};

// Super-only: toggle maintenance mode
export const updateMaintenance = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const { maintenanceMode, maintenanceMessage } = req.body || {};

    const update = {};
    if (typeof maintenanceMode === "boolean")
      update.maintenanceMode = maintenanceMode;
    if (typeof maintenanceMessage === "string") {
      update.maintenanceMessage = maintenanceMessage.slice(0, 500).trim();
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }
    update.updatedBy = req.user.id;

    await AppConfig.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { upsert: true, new: true },
    );
    AppConfig.invalidateCache();

    const fresh = await AppConfig.getInstance();
    return res.json({
      ok: true,
      maintenanceMode: fresh.maintenanceMode,
      maintenanceMessage: fresh.maintenanceMessage,
    });
  } catch (err) {
    next(err);
  }
};

// Super-only: update welcome announcement (bumping version makes everyone see it again)
export const updateWelcomeAnnouncement = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const { version, title, body, enabled } = req.body || {};

    const update = {};
    if (typeof version === "string" && version.trim()) {
      update["welcomeAnnouncement.version"] = version.trim().slice(0, 80);
    }
    if (typeof title === "string")
      update["welcomeAnnouncement.title"] = title.trim().slice(0, 200);
    if (typeof body === "string")
      update["welcomeAnnouncement.body"] = body.trim().slice(0, 1500);
    if (typeof enabled === "boolean")
      update["welcomeAnnouncement.enabled"] = enabled;
    update["welcomeAnnouncement.updatedAt"] = new Date();
    update.updatedBy = req.user.id;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    await AppConfig.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { upsert: true, new: true },
    );
    AppConfig.invalidateCache();

    const fresh = await AppConfig.getInstance();
    return res.json({
      ok: true,
      welcomeAnnouncement: fresh.welcomeAnnouncement,
    });
  } catch (err) {
    next(err);
  }
};

// Super-only: saves the draft desktop release block. Never writes announcementId or
// announcedAt -- saving is not announcing, so a save can be revised any number of times
// before notifyDesktopRelease (below) makes it visible to any client.
export const updateDesktopRelease = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const current = await AppConfig.getDesktopRelease();
    const result = validateDesktopReleasePatch(req.body || {}, current);
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
      });
    }

    const update = { ...result.update };
    update["desktopRelease.updatedAt"] = new Date();
    update.updatedBy = req.user.id;

    await AppConfig.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { upsert: true, new: true },
    );
    AppConfig.invalidateCache();

    const fresh = await AppConfig.getDesktopRelease();
    return res.json({ ok: true, desktopRelease: fresh });
  } catch (err) {
    next(err);
  }
};

// Super-only: makes the currently-saved draft visible to every client via GET /api/app-config.
// There is NO fan-out, NO email, NO per-user write here -- delivery is pull-based (every client
// already polls /api/app-config on launch), which is why this cannot time out or partially fail
// on a large user base the way a broadcast send could.
export const notifyDesktopRelease = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const current = await AppConfig.getDesktopRelease();
    const hasValidSha256 = typeof current.sha256 === "string" && /^[0-9a-f]{64}$/.test(current.sha256);
    const hasValidSize =
      Number.isSafeInteger(current.sizeBytes) && current.sizeBytes >= 1 && current.sizeBytes <= 524288000;
    if (
      typeof current.latestVersion !== "string" ||
      current.latestVersion.length === 0 ||
      typeof current.downloadUrl !== "string" ||
      current.downloadUrl.length === 0 ||
      !hasValidSha256 ||
      !hasValidSize
    ) {
      return res.status(409).json({
        ok: false,
        code: "RELEASE_INCOMPLETE",
        error:
          "Save a complete release (latestVersion, downloadUrl, sha256, sizeBytes) before notifying.",
      });
    }

    const update = {
      "desktopRelease.announcementId": randomUUID(),
      "desktopRelease.announcedAt": new Date(),
      "desktopRelease.enabled": true,
      "desktopRelease.updatedAt": new Date(),
      updatedBy: req.user.id,
    };
    await AppConfig.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { upsert: true, new: true },
    );
    AppConfig.invalidateCache();

    const fresh = await AppConfig.getDesktopRelease();
    return res.json({ ok: true, notified: true, desktopRelease: fresh });
  } catch (err) {
    next(err);
  }
};

// Super-only: the raw stored block (including enabled/updatedAt), so the admin panel can render
// a saved-but-not-yet-announced release. The public read (getAppConfig) serves null for a draft;
// this route is how the panel itself sees what is actually saved.
export const getDesktopReleaseDraft = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const desktopRelease = await AppConfig.getDesktopRelease();
    return res.json({ ok: true, desktopRelease });
  } catch (err) {
    next(err);
  }
};
