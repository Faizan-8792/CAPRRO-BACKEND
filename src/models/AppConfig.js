// src/models/AppConfig.js
// Singleton document holding global app settings.

import mongoose from "mongoose";

export const DEFAULT_FEATURE_FLAGS = Object.freeze({
  zeroApprovalFirmCreation: false,
  unrestrictedTasks: false,
  fullReminderOffsets: false,
  reliableReminderDelivery: false,
  fullTabWorkspace: false,
  sampleWorkspace: false,
  homeWorkspace: false,
  clientComplianceProfile: false,
  complianceGenerationShadow: false,
  complianceGenerationLive: false,
  gstReconciliation: false,
  tdsHealth: false,
  noticeCases: false,
  assuranceEngagements: false,
  filingDashboard: false,
  teamWorkload: false,
  auditWorkingPapers: false,
  dailyDigest: false,
  weeklySummary: false,
});


const AppConfigSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: {
      type: String,
      default: "We are doing some quick maintenance. Please check back in a few minutes.",
    },
    welcomeAnnouncement: {
      version: { type: String, default: "v1-ai-launch" },
      title: { type: String, default: "Welcome to CA PRO Toolkit" },
      body: {
        type: String,
        default:
          "We have just integrated AI for smarter audit analysis, instant insights, and personalised client reminders. Try the AI Audit Scan and Tax Work Tracker for the best results!",
      },
      enabled: { type: Boolean, default: true },
      updatedAt: { type: Date, default: Date.now },
    },
    // Every default below is empty/false/0, so a singleton that predates this field reads as
    // "nothing announced" -- never as "an update is required". This matters because
    // AppConfigSchema.statics.getInstance (below) synthesises a fresh doc via
    // `new this({_id:"singleton"}).toObject()` when none exists, so these defaults ARE the live
    // values on a cold database.
    //
    // announcementId is deliberately NOT operator-supplied and defaults to "": it is stamped
    // server-side with randomUUID() only by the notify route. An operator-typed id would let a
    // typo either re-notify everyone or silently notify nobody.
    desktopRelease: {
      latestVersion: { type: String, trim: true, maxlength: 32, default: "" },
      minSupportedVersion: { type: String, trim: true, maxlength: 32, default: "" },
      downloadUrl: { type: String, trim: true, maxlength: 500, default: "" },
      releaseNotes: { type: String, trim: true, maxlength: 4000, default: "" },
      mandatory: { type: Boolean, default: false },
      announcementId: { type: String, trim: true, maxlength: 64, default: "" },
      announcedAt: { type: Date, default: null },
      sha256: { type: String, trim: true, lowercase: true, maxlength: 64, default: "" },
      sizeBytes: { type: Number, min: 0, max: 524288000, default: 0 },
      enabled: { type: Boolean, default: false },
      updatedAt: { type: Date, default: null },
    },
    featureFlags: {
      zeroApprovalFirmCreation: { type: Boolean, default: false },
      unrestrictedTasks: { type: Boolean, default: false },
      fullReminderOffsets: { type: Boolean, default: false },
      reliableReminderDelivery: { type: Boolean, default: false },
      fullTabWorkspace: { type: Boolean, default: false },
      sampleWorkspace: { type: Boolean, default: false },
      homeWorkspace: { type: Boolean, default: false },
      clientComplianceProfile: { type: Boolean, default: false },
      complianceGenerationShadow: { type: Boolean, default: false },
      complianceGenerationLive: { type: Boolean, default: false },
      gstReconciliation: { type: Boolean, default: false },
      tdsHealth: { type: Boolean, default: false },
      noticeCases: { type: Boolean, default: false },
      assuranceEngagements: { type: Boolean, default: false },
      filingDashboard: { type: Boolean, default: false },
      teamWorkload: { type: Boolean, default: false },
      auditWorkingPapers: { type: Boolean, default: false },
      dailyDigest: { type: Boolean, default: false },
      weeklySummary: { type: Boolean, default: false },
    },
    featureFlagVersions: {
      tdsHealth: { type: Number, min: 0, default: 0 },
      noticeCases: { type: Number, min: 0, default: 0 },
      assuranceEngagements: { type: Number, min: 0, default: 0 },
      auditWorkingPapers: { type: Number, min: 0, default: 0 },
    },
    featureFlagPublicationFences: {
      tdsHealth: { type: String, trim: true, maxlength: 80, default: "" },
      noticeCases: { type: String, trim: true, maxlength: 80, default: "" },
      assuranceEngagements: { type: String, trim: true, maxlength: 80, default: "" },
      auditWorkingPapers: { type: String, trim: true, maxlength: 80, default: "" },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // T3 (.kiro/PLAN.md): durable state for
    // reminder-delivery-alert.service.js's re-alert throttle, so a server
    // restart does not forget the last time the owner was emailed and
    // re-fire immediately. Scheduler bookkeeping, not user- or admin-facing
    // configuration -- deliberately not folded into featureFlags/desktopRelease.
    reminderDeliveryAlert: {
      lastAlertAt: { type: Date, default: null },
      lastAlertIssueCount: { type: Number, min: 0, default: 0 },
    },
  },
  { timestamps: true, _id: false }
);

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 30_000;

AppConfigSchema.statics.getInstance = async function () {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) {
    return _cache;
  }
  let doc = await this.findById("singleton").lean();
  if (!doc) {
    doc = new this({ _id: "singleton" }).toObject();
  }
  _cache = doc;
  _cacheAt = now;
  return doc;
};

AppConfigSchema.statics.getFeatureFlags = async function () {
  const config = await this.getInstance();
  return {
    ...DEFAULT_FEATURE_FLAGS,
    ...(config.featureFlags || {}),
  };
};

AppConfigSchema.statics.getDesktopRelease = async function () {
  const cfg = await this.getInstance();
  return cfg.desktopRelease || {};
};

AppConfigSchema.statics.getFeatureFlagState = async function (
  flagName,
  { fresh = false } = {}
) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, flagName)) {
    throw new Error(`Unknown feature flag: ${flagName}`);
  }
  const config = fresh
    ? await this.findById("singleton")
        .select(
          `featureFlags.${flagName} featureFlagVersions.${flagName} featureFlagPublicationFences.${flagName}`
        )
        .lean()
    : await this.getInstance();
  return {
    enabled: config?.featureFlags?.[flagName] === true,
    version: Number.isSafeInteger(config?.featureFlagVersions?.[flagName])
      ? config.featureFlagVersions[flagName]
      : 0,
    publicationFence:
      typeof config?.featureFlagPublicationFences?.[flagName] === "string"
        ? config.featureFlagPublicationFences[flagName]
        : "",
  };
};

AppConfigSchema.statics.isFeatureEnabled = async function (
  flagName,
  { fresh = false } = {}
) {
  const state = await this.getFeatureFlagState(flagName, { fresh });
  return state.enabled;
};

AppConfigSchema.statics.assertFeatureFlagVersion = async function (
  flagName,
  expectedVersion,
  expectedPublicationFence = null
) {
  const state = await this.getFeatureFlagState(flagName, { fresh: true });
  const fenceChanged =
    expectedPublicationFence != null &&
    state.publicationFence !== expectedPublicationFence;
  if (!state.enabled || state.version !== expectedVersion || fenceChanged) {
    const error = new Error(`${flagName} rollout changed while the request was running`);
    error.statusCode = 409;
    error.code = "FEATURE_ROLLOUT_CHANGED";
    error.featureFlag = flagName;
    throw error;
  }
  return state;
};

AppConfigSchema.statics.invalidateCache = function () {
  _cache = null;
  _cacheAt = 0;
};

const AppConfig = mongoose.model("AppConfig", AppConfigSchema);
export default AppConfig;
