// src/controllers/appconfig.controller.js
import AppConfig from "../models/AppConfig.js";
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
    return res.json({
      ok: true,
      config: {
        maintenanceMode: !!cfg.maintenanceMode,
        maintenanceMessage: cfg.maintenanceMessage || "",
        welcomeAnnouncement: cfg.welcomeAnnouncement || null,
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
      { $set: { welcomeSeenVersion: version } }
    );

    return res.json({ ok: true, welcomeSeenVersion: version });
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
    if (typeof maintenanceMode === "boolean") update.maintenanceMode = maintenanceMode;
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
      { upsert: true, new: true }
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
    if (typeof title === "string") update["welcomeAnnouncement.title"] = title.trim().slice(0, 200);
    if (typeof body === "string") update["welcomeAnnouncement.body"] = body.trim().slice(0, 1500);
    if (typeof enabled === "boolean") update["welcomeAnnouncement.enabled"] = enabled;
    update["welcomeAnnouncement.updatedAt"] = new Date();
    update.updatedBy = req.user.id;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    await AppConfig.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { upsert: true, new: true }
    );
    AppConfig.invalidateCache();

    const fresh = await AppConfig.getInstance();
    return res.json({ ok: true, welcomeAnnouncement: fresh.welcomeAnnouncement });
  } catch (err) {
    next(err);
  }
};
