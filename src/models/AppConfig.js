// src/models/AppConfig.js
// Singleton document holding global app settings:
// - Maintenance mode toggle + message
// - Current welcome announcement (version + title + body)
// Use AppConfig.getInstance() to fetch with built-in caching.

import mongoose from "mongoose";

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
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, _id: false }
);

// In-process cache (30s TTL) — avoids DB hit per request.
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
    // Create with defaults
    doc = await this.create({ _id: "singleton" });
    doc = doc.toObject();
  }
  _cache = doc;
  _cacheAt = now;
  return doc;
};

AppConfigSchema.statics.invalidateCache = function () {
  _cache = null;
  _cacheAt = 0;
};

const AppConfig = mongoose.model("AppConfig", AppConfigSchema);
export default AppConfig;
