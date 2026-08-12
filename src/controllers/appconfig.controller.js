// src/controllers/appconfig.controller.js
import { randomUUID } from "node:crypto";
import AppConfig, { DEFAULT_FEATURE_FLAGS } from "../models/AppConfig.js";
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
