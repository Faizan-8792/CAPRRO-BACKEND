// src/controllers/super.controller.js

import mongoose from "mongoose";
import User from "../models/User.js";
import Firm from "../models/Firm.js";
import Task from "../models/Task.js";
import Reminder from "../models/Reminder.js";
import FirmMembership from "../models/FirmMembership.js";
import WorkflowUsage from "../models/WorkflowUsage.js";
import EmailDelivery from "../models/EmailDelivery.js";
import EmailSuppression from "../models/EmailSuppression.js";
import {
  getDeepSelfTestRun,
  getLatestDeepSelfTestRun,
  startDeepSelfTest,
} from "../services/self-test.service.js";
import { sendTestEmail } from "../services/email.service.js";
import { safeRecordActivity } from "../services/activity.service.js";
import {
  eraseFirm,
  buildErasurePlan,
  getErasureReceipt,
} from "../services/firm-erasure.service.js";
import {
  STRATEGY,
  userTombstone,
  userNeedsTombstone,
} from "../services/erasure-classification.js";
import { sendTestDigestNow } from "../services/digest.service.js";
import { deliveryHealth } from "./reminder.controller.js";
import AppConfig from "../models/AppConfig.js";
import ProviderUsage, {
  GLOBAL_USAGE_USER_ID,
  dailyPeriodKey,
  monthlyPeriodKey,
} from "../models/ProviderUsage.js";

const PROVIDER_USAGE_PROVIDERS = ["DEEPSEEK", "OCR_SPACE"];

const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

// One definition of "pending firm-admin request", so the queue and the dashboard
// count cannot drift apart. The first clause is the current marker; the second
// keeps accounts created under the older isActive convention visible.
const PENDING_FIRM_ADMIN_FILTER = {
  $or: [
    { firmAdminRequestedAt: { $ne: null } },
    { role: "FIRM_ADMIN", isActive: false },
  ],
};

function assertSuper(user) {
  if (!user || user.role !== "SUPER_ADMIN" || user.email !== SUPER_EMAIL) {
    const err = new Error("Super admin only");
    err.statusCode = 403;
    throw err;
  }
}

function serializeFirmForSuper(firm) {
  const serializedFirm =
    typeof firm?.toJSON === "function"
      ? firm.toJSON()
      : typeof firm?.toObject === "function"
        ? firm.toObject()
        : firm;
  const responseFirm = { ...serializedFirm };
  const isExplicitShared =
    firm?.kind === "SHARED" &&
    !(typeof firm?.$isDefault === "function" && firm.$isDefault("kind"));
  if (!isExplicitShared) delete responseFirm.joinCode;
  return responseFirm;
}

// 0a) Usage analytics. Two bases, stated plainly (PLAN.md §27.2 caption discipline):
//
// 1. LEGACY `dau/wau/mau/dailyActivity/topUsers` derive from User.lastActiveAt and the
//    throttled totalApiCalls counter. lastActiveAt can never be activation evidence (§27.3) and
//    the dailyActivity series only buckets a user onto their LAST active day, so these are
//    returned unchanged for continuity but flagged `basis: "lastActiveAt-approximate"`.
//
// 2. NEW client-split analytics read WorkflowUsage (IMPROVEMENT-PLAN-V2-2026-09-28 Part 3):
//    real per-day distinct-user series per client type (desktop/extension), DAU/WAU/MAU per
//    client type, per-workflow actives, and the per-user table (super-admin only by route guard)
//    that answers "who uses more, who uses less". Content-free by model contract: counts only.
export const getUsageStats = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const oneDay = new Date(now.getTime() - dayMs);
    const sevenDay = new Date(now.getTime() - 7 * dayMs);
    const thirtyDay = new Date(now.getTime() - 30 * dayMs);
    const ninetyDay = new Date(now.getTime() - 90 * dayMs);

    // UTC day strings matching WorkflowUsage.periodDay, inclusive window.
    const dayKey = (date) => date.toISOString().slice(0, 10);
    const todayKey = dayKey(now);
    const weekAgoKey = dayKey(new Date(now.getTime() - 6 * dayMs)); // 7 calendar days incl. today
    const monthAgoKey = dayKey(new Date(now.getTime() - 29 * dayMs)); // 30 incl. today
    const fourteenAgoKey = dayKey(new Date(now.getTime() - 13 * dayMs));
    const perUserWindowKey = dayKey(new Date(now.getTime() - 29 * dayMs));

    const [dau, wau, mau, qau, totalEverActive, totalUsers, totalApiCallsAgg] =
      await Promise.all([
        User.countDocuments({ lastActiveAt: { $gte: oneDay } }),
        User.countDocuments({ lastActiveAt: { $gte: sevenDay } }),
        User.countDocuments({ lastActiveAt: { $gte: thirtyDay } }),
        User.countDocuments({ lastActiveAt: { $gte: ninetyDay } }),
        User.countDocuments({ lastActiveAt: { $ne: null } }),
        User.countDocuments({}),
        User.aggregate([
          { $group: { _id: null, total: { $sum: "$totalApiCalls" } } },
        ]),
      ]);

    const totalApiCalls = totalApiCallsAgg[0]?.total || 0;

    // Activity by day for last 14 days
    const dailyActivity = await User.aggregate([
      {
        $match: {
          lastActiveAt: { $gte: new Date(now.getTime() - 14 * dayMs) },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$lastActiveAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Top 5 most active users (highest API calls)
    const topUsers = await User.find({ totalApiCalls: { $gt: 0 } })
      .select("email name role totalApiCalls lastActiveAt firmId")
      .sort({ totalApiCalls: -1 })
      .limit(5)
      .populate("firmId", "displayName handle")
      .lean();

    // ── Client-split analytics from WorkflowUsage (real per-workflow recording) ──

    // Distinct users per client type per period: a user active on both clients
    // in one day counts once under each — that is the split, not a dedupe.
    const activesByClient = async (fromKey) => {
      const rows = await WorkflowUsage.aggregate([
        { $match: { periodDay: { $gte: fromKey } } },
        {
          $group: {
            _id: { client: "$client", userId: "$userId" },
          },
        },
        { $group: { _id: "$_id.client", users: { $sum: 1 } } },
      ]);
      const out = { desktop: 0, extension: 0 };
      for (const row of rows) out[row._id] = row.users;
      return out;
    };

    const [dauByClient, wauByClient, mauByClient] = await Promise.all([
      activesByClient(todayKey),
      activesByClient(weekAgoKey),
      activesByClient(monthAgoKey),
    ]);

    // Real 14-day per-day series: distinct users recorded per day per client.
    const dailyActivityByClientRows = await WorkflowUsage.aggregate([
      { $match: { periodDay: { $gte: fourteenAgoKey } } },
      {
        $group: {
          _id: { day: "$periodDay", client: "$client" },
          users: { $addToSet: "$userId" },
        },
      },
      { $project: { _id: 0, day: "$_id.day", client: "$_id.client", count: { $size: "$users" } } },
      { $sort: { day: 1 } },
    ]);
    const dailyByClientMap = new Map();
    for (const row of dailyActivityByClientRows) {
      if (!dailyByClientMap.has(row.day)) {
        dailyByClientMap.set(row.day, { _id: row.day, desktop: 0, extension: 0 });
      }
      dailyByClientMap.get(row.day)[row.client] = row.count;
    }
    const dailyActivityByClient = [...dailyByClientMap.values()];

    // Per-workflow actives and volume over the 30-day window.
    const workflowBreakdown = await WorkflowUsage.aggregate([
      { $match: { periodDay: { $gte: monthAgoKey } } },
      {
        $group: {
          _id: "$workflow",
          users: { $addToSet: "$userId" },
          totalCounts: { $sum: "$count" },
          errorCounts: { $sum: "$outcomeCounts.error" },
        },
      },
      {
        $project: {
          _id: 0,
          workflow: "$_id",
          weekActive: { $size: "$users" },
          totalCounts: 1,
          errorCounts: 1,
        },
      },
      { $sort: { totalCounts: -1 } },
    ]);

    // Per-user usage (owner's "who uses more, who uses less"), 30-day window,
    // biggest first. Super-admin-only endpoint: firm admins never receive this
    // (PLAN.md forbids employee ranking), and that is enforced by the route
    // guard, not by UI absence.
    const perUserRows = await WorkflowUsage.aggregate([
      { $match: { periodDay: { $gte: perUserWindowKey } } },
      {
        $group: {
          _id: { userId: "$userId", client: "$client" },
          count: { $sum: "$count" },
          lastSeenAt: { $max: "$lastSeenAt" },
          workflows: { $addToSet: "$workflow" },
        },
      },
      {
        $group: {
          _id: "$_id.userId",
          desktopCount: {
            $sum: { $cond: [{ $eq: ["$_id.client", "desktop"] }, "$count", 0] },
          },
          extensionCount: {
            $sum: { $cond: [{ $eq: ["$_id.client", "extension"] }, "$count", 0] },
          },
          lastSeenAt: { $max: "$lastSeenAt" },
          workflows: { $addToSet: "$workflows" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          email: "$user.email",
          name: "$user.name",
          desktopCount: 1,
          extensionCount: 1,
          totalCount: { $add: ["$desktopCount", "$extensionCount"] },
          workflows: {
            $size: {
              $reduce: {
                input: "$workflows",
                initialValue: [],
                in: { $setUnion: ["$$value", "$$this"] },
              },
            },
          },
          lastSeenAt: 1,
        },
      },
      { $sort: { totalCount: -1, lastSeenAt: -1 } },
      { $limit: 100 },
    ]);

    return res.json({
      ok: true,
      usage: {
        basis: "mixed — legacy fields are lastActiveAt-approximate; clientSplit/dailyActivityByClient/workflowBreakdown/perUser are WorkflowUsage counters (server-verified)",
        dau,
        wau,
        mau,
        qau,
        totalEverActive,
        totalUsers,
        totalApiCalls,
        activationRate:
          totalUsers > 0 ? Math.round((totalEverActive / totalUsers) * 100) : 0,
        retentionRate:
          totalEverActive > 0 ? Math.round((wau / totalEverActive) * 100) : 0,
        dailyActivity,
        topUsers,
        clientSplit: { daily: dauByClient, weekly: wauByClient, monthly: mauByClient },
        dailyActivityByClient,
        workflowBreakdown,
        perUser: perUserRows,
        perUserWindowDays: 30,
      },
    });
  } catch (err) {
    next(err);
  }
};

// 0b) O10: paid-provider (DeepSeek / OCR.space) spend meter -- today's and this
// month's call counts per provider, plus the top users by call count today, so
// the owner can see who is actually driving the bill behind the per-user/
// monthly/global caps enforced in deepseek-provider.service.js and
// ocr-space.service.js. Excludes the internal global-ceiling sentinel row
// (GLOBAL_USAGE_USER_ID) from every total and from the top-users list -- that
// row is bookkeeping for the global cap, never a real user's usage.
export const getProviderUsageStats = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const dayKey = dailyPeriodKey();
    const monthKey = monthlyPeriodKey();
    const realUserFilter = { userId: { $ne: GLOBAL_USAGE_USER_ID } };

    const totalsByProvider = (rows) =>
      Object.fromEntries(
        PROVIDER_USAGE_PROVIDERS.map((provider) => [
          provider,
          rows.find((row) => row._id === provider)?.total || 0,
        ]),
      );

    const [dailyTotalsRaw, monthlyTotalsRaw, topUsersByProvider] =
      await Promise.all([
        ProviderUsage.aggregate([
          { $match: { ...realUserFilter, periodKey: dayKey } },
          { $group: { _id: "$provider", total: { $sum: "$calls" } } },
        ]),
        ProviderUsage.aggregate([
          { $match: { ...realUserFilter, periodKey: monthKey } },
          { $group: { _id: "$provider", total: { $sum: "$calls" } } },
        ]),
        Promise.all(
          PROVIDER_USAGE_PROVIDERS.map((provider) =>
            ProviderUsage.find({ ...realUserFilter, provider, periodKey: dayKey })
              .sort({ calls: -1 })
              .limit(5)
              .populate("userId", "email name")
              .lean(),
          ),
        ),
      ]);

    const topUsersToday = Object.fromEntries(
      PROVIDER_USAGE_PROVIDERS.map((provider, index) => [
        provider,
        topUsersByProvider[index].map((row) => ({
          userId: String(row.userId?._id || row.userId || ""),
          email: row.userId?.email || "(deleted user)",
          name: row.userId?.name || "",
          calls: row.calls,
        })),
      ]),
    );

    return res.json({
      ok: true,
      usage: {
        today: totalsByProvider(dailyTotalsRaw),
        thisMonth: totalsByProvider(monthlyTotalsRaw),
        topUsersToday,
      },
    });
  } catch (err) {
    next(err);
  }
};

// 0c) T1 (.kiro/PLAN.md): fleet-wide reminder delivery-failure visibility.
// reliableReminderDelivery's retry loop already records a per-attempt status
// on every Reminder document (reminder.controller.js's deliveryAttempts
// field); nothing anywhere previously aggregated that into something an
// operator could see without opening MongoDB by hand. Reuses deliveryHealth/
// getAttemptEntries directly from reminder.controller.js so "what counts as
// a delivery problem" has exactly one definition, not a second one that
// could drift from it.
const DELIVERY_STAT_CANDIDATE_LIMIT = 5000;
const DELIVERY_STAT_SAMPLE_LIMIT = 20;

export const getReminderDeliveryHealthStats = async (req, res, next) => {
  try {
    assertSuper(req.user);

    // Cheap pre-filter: only reminders that have ever recorded an attempt can
    // possibly be unhealthy. deliveryAttempts defaults to {} until the first
    // send is attempted, so this excludes reminders nobody has tried yet.
    const candidates = await Reminder.find({
      isActive: true,
      deliveryAttempts: { $ne: {} },
    })
      .select("userId firmId typeId clientLabel dueDateISO scheduleVersion deliveryAttempts")
      .limit(DELIVERY_STAT_CANDIDATE_LIMIT)
      .lean();

    const now = new Date();
    const unhealthy = [];
    for (const reminder of candidates) {
      const health = deliveryHealth(reminder, now);
      if (health.status !== "HEALTHY") unhealthy.push({ reminder, health });
    }
    unhealthy.sort(
      (a, b) => new Date(a.reminder.dueDateISO) - new Date(b.reminder.dueDateISO)
    );

    const sample = unhealthy.slice(0, DELIVERY_STAT_SAMPLE_LIMIT).map(({ reminder, health }) => ({
      reminderId: String(reminder._id),
      userId: reminder.userId ? String(reminder.userId) : null,
      firmId: reminder.firmId ? String(reminder.firmId) : null,
      typeId: reminder.typeId || null,
      clientLabel: reminder.clientLabel || "",
      dueDateISO: reminder.dueDateISO || null,
      status: health.status,
      issueCount: health.issueCount,
      issues: health.issues.map((issue) => ({
        key: issue.key,
        status: issue.status,
        attemptCount: issue.attemptCount,
        lastError: issue.lastError,
        nextAttemptAt: issue.nextAttemptAt,
      })),
    }));

    return res.json({
      ok: true,
      delivery: {
        issueCount: unhealthy.length,
        sample,
        sampleTruncated: unhealthy.length > sample.length,
        candidatesScanned: candidates.length,
        candidatesScanTruncated: candidates.length === DELIVERY_STAT_CANDIDATE_LIMIT,
        generatedAt: now.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 0) Super Admin Dashboard Stats
export const getSuperDashboardStats = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      firmAdmins,
      totalFirms,
      activeFirms,
      totalTasks,
      activeTasks,
      pendingAdmins,
      totalReminders,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ isActive: false }),
      User.countDocuments({ role: "FIRM_ADMIN" }),
      Firm.countDocuments({}),
      Firm.countDocuments({ isActive: true }),
      Task.countDocuments({}),
      Task.countDocuments({ isActive: true }),
      User.countDocuments(PENDING_FIRM_ADMIN_FILTER),
      Reminder.countDocuments({}),
    ]);

    // Collaboration signals: shared firms vs personal workspaces, and total
    // active memberships (a firm with more than one member is collaborating).
    const [sharedFirms, personalFirms, totalMemberships, collaboratingFirms] =
      await Promise.all([
        Firm.countDocuments({ kind: "SHARED" }),
        Firm.countDocuments({ kind: "PERSONAL" }),
        FirmMembership.countDocuments({ status: "ACTIVE" }),
        FirmMembership.aggregate([
          { $match: { status: "ACTIVE" } },
          { $group: { _id: "$firmId", members: { $sum: 1 } } },
          { $match: { members: { $gt: 1 } } },
          { $count: "count" },
        ]),
      ]);

    // Task status breakdown
    const taskStatusBreakdown = await Task.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // Recent signups (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentSignups = await User.countDocuments({
      createdAt: { $gte: sevenDaysAgo },
    });

    // Recent tasks (last 7 days)
    const recentTasks = await Task.countDocuments({
      createdAt: { $gte: sevenDaysAgo },
    });

    // Service type breakdown
    const serviceBreakdown = await Task.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$serviceType", count: { $sum: 1 } } },
    ]);

    return res.json({
      ok: true,
      stats: {
        users: {
          total: totalUsers,
          active: activeUsers,
          inactive: inactiveUsers,
          firmAdmins,
          pendingAdmins,
          recentSignups,
        },
        firms: {
          total: totalFirms,
          active: activeFirms,
          accessModel: "FREE",
          premium: 0,
          free: totalFirms,
          shared: sharedFirms,
          personal: personalFirms,
        },
        collaboration: {
          memberships: totalMemberships,
          collaboratingFirms: collaboratingFirms[0]?.count || 0,
        },
        tasks: {
          total: totalTasks,
          active: activeTasks,
          recentTasks,
          statusBreakdown: taskStatusBreakdown,
          serviceBreakdown,
        },
        reminders: {
          total: totalReminders,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// 0b) Full user directory (who signed up, when, last seen, activity, firm)
// GET /api/super/users?page=&limit=&search=&activity=&role=&sort=
export const listAllUsers = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25),
    );
    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();
    const activity = String(req.query.activity || "")
      .trim()
      .toLowerCase();
    const role = String(req.query.role || "")
      .trim()
      .toUpperCase();
    const sort = String(req.query.sort || "recent")
      .trim()
      .toLowerCase();

    const filter = {};
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      filter.$or = [{ email: rx }, { name: rx }];
    }
    if (["USER", "FIRM_ADMIN", "SUPER_ADMIN"].includes(role)) {
      filter.role = role;
    }

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    if (activity === "active") {
      // Active in the last 30 days.
      filter.lastActiveAt = { $gte: new Date(now - 30 * dayMs) };
    } else if (activity === "dormant") {
      // Signed in at least once, but not in the last 30 days.
      filter.lastActiveAt = { $ne: null, $lt: new Date(now - 30 * dayMs) };
    } else if (activity === "never") {
      filter.lastActiveAt = null;
    }

    const sortSpec =
      sort === "signup"
        ? { createdAt: -1 }
        : sort === "usage"
          ? { totalApiCalls: -1 }
          : { lastActiveAt: -1, createdAt: -1 };

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(
          "email name role accountType isActive firmId personalFirmId lastActiveAt lastSeenIp totalApiCalls createdAt",
        )
        .sort(sortSpec)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Enrich with active firm summary and how many workspaces each user belongs to.
    const firmIds = [
      ...new Set(
        users
          .map((u) => u.firmId)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const firms = await Firm.find({ _id: { $in: firmIds } })
      .select("displayName handle kind")
      .lean();
    const firmById = new Map(firms.map((f) => [String(f._id), f]));

    const userIds = users.map((u) => u._id);
    const membershipCounts = await FirmMembership.aggregate([
      { $match: { userId: { $in: userIds }, status: "ACTIVE" } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);
    const workspaceCountByUser = new Map(
      membershipCounts.map((m) => [String(m._id), m.count]),
    );

    const rows = users.map((u) => {
      const firm = u.firmId ? firmById.get(String(u.firmId)) : null;
      const lastActiveAt = u.lastActiveAt || null;
      const daysSinceActive = lastActiveAt
        ? Math.floor((now - new Date(lastActiveAt).getTime()) / dayMs)
        : null;
      return {
        id: u._id,
        email: u.email,
        name: u.name || null,
        role: u.role,
        accountType: u.accountType,
        isActive: u.isActive !== false,
        createdAt: u.createdAt,
        lastActiveAt,
        daysSinceActive,
        lastSeenIp: u.lastSeenIp || null,
        totalApiCalls: u.totalApiCalls || 0,
        workspaceCount: workspaceCountByUser.get(String(u._id)) || 0,
        activeFirm: firm
          ? {
              id: u.firmId,
              displayName: firm.displayName,
              handle: firm.handle,
              kind: firm.kind || "SHARED",
            }
          : null,
      };
    });

    return res.json({
      ok: true,
      users: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: skip + users.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
};

// 1) Pending firm admins list
export const listPendingAdmins = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const users = await User.find(PENDING_FIRM_ADMIN_FILTER)
      .select("email name firmId createdAt firmAdminRequestedAt isActive role")
      .sort({ createdAt: -1 })
      .lean();

    // The legacy shape cannot distinguish a pending request from a suspension,
    // so it is labelled rather than treated as an approvable request.
    return res.json({
      ok: true,
      users: users.map((user) => ({
        ...user,
        requestShape: user.firmAdminRequestedAt
          ? "REQUESTED"
          : "LEGACY_INACTIVE",
      })),
    });
  } catch (err) {
    next(err);
  }
};

// 2) Approve firm admin
export const approveAdmin = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { userId } = req.params;
    const user = await User.findById(userId);

    if (!user) {
      return res
        .status(404)
        .json({ ok: false, error: "Firm admin request not found" });
    }

    if (user.role === "FIRM_ADMIN" && user.isActive !== false) {
      return res.status(400).json({ ok: false, error: "Already approved" });
    }

    // Only an explicit request can be approved. An inactive FIRM_ADMIN without
    // one is indistinguishable from a suspended account, and approving it would
    // silently lift that suspension.
    if (!user.firmAdminRequestedAt) {
      return res.status(409).json({
        ok: false,
        error:
          "This account has no recorded firm-admin request. It may be suspended rather than pending. Set its role and active status directly instead.",
      });
    }

    user.role = "FIRM_ADMIN";
    user.accountType = "FIRM_USER";
    user.firmAdminRequestedAt = null;
    await user.save();

    return res.json({
      ok: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isActive: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

// 3) Revoke firm admin -> normal user
export const revokeAdmin = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { userId } = req.params;
    const user = await User.findById(userId);

    // Also covers declining a request that was never approved.
    if (!user || (user.role !== "FIRM_ADMIN" && !user.firmAdminRequestedAt)) {
      return res.status(404).json({ ok: false, error: "Firm admin not found" });
    }

    // Activation is deliberately untouched: demoting or declining must not lift
    // a suspension that was applied separately.
    user.role = "USER";
    user.accountType = "INDIVIDUAL";
    user.firmAdminRequestedAt = null;
    user.firmId = null;

    await user.save();

    return res.json({
      ok: true,
      user: { id: user._id, email: user.email, role: "USER" },
    });
  } catch (err) {
    next(err);
  }
};

// 4) List all firms + owner admin summary
export const listFirms = async (req, res, next) => {
  try {
    assertSuper(req.user);

    // Bounded deliberately. This was an unbounded Firm.find({}), so the super
    // panel rendered every firm in the database in one shot and grew without
    // limit as the product did - the panel's own "why is this page so long"
    // problem starts here, not in the markup. 200 is far above the current
    // count and is reported to the client so the panel can say plainly that
    // it is showing a capped list rather than implying it is showing all of
    // them.
    const FIRM_LIST_LIMIT = 200;
    const totalFirms = await Firm.countDocuments({});
    const firms = await Firm.find({})
      .sort({ createdAt: -1 })
      .limit(FIRM_LIST_LIMIT)
      .lean();

    const ownerIds = firms.map((f) => f.ownerUserId);
    const owners = await User.find({ _id: { $in: ownerIds } })
      .select("email name role isActive firmId")
      .lean();

    const ownersById = new Map();
    owners.forEach((u) => ownersById.set(String(u._id), u));

    const enriched = firms.map((firm) => ({
      ...serializeFirmForSuper(firm),
      // Legacy plan values remain in storage for backward compatibility only.
      // Product access is free and does not expire for every firm.
      planType: "FREE",
      planExpiry: null,
      accessModel: "FREE",
      owner: ownersById.get(String(firm.ownerUserId)) || null,
    }));

    // Additive keys, so an older panel that ignores them keeps working. The
    // count is the real total, not the returned length, so the panel can say
    // "showing 200 of 340" rather than silently presenting a truncated list
    // as if it were complete.
    return res.json({
      ok: true,
      firms: enriched,
      totalFirms,
      returnedFirms: enriched.length,
      truncated: totalFirms > enriched.length,
      limit: FIRM_LIST_LIMIT,
    });
  } catch (err) {
    next(err);
  }
};

// 5) List all users of a firm (for super admin)
export const listFirmUsersForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId } = req.params;

    const firm = await Firm.findById(firmId).lean();
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    const memberships = await FirmMembership.find({
      firmId,
      status: "ACTIVE",
    })
      .select("userId")
      .lean();
    const memberUserIds = memberships.map((membership) => membership.userId);
    const users = await User.find({ _id: { $in: memberUserIds } })
      .select("email name role accountType isActive createdAt")
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      ok: true,
      firm: serializeFirmForSuper(firm),
      users,
    });
  } catch (err) {
    next(err);
  }
};

// 6) Update firm operational access. Product features are free for every firm.
// The legacy /plan route name remains temporarily for client compatibility.
export const updateFirmPlan = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId } = req.params;
    const { isActive } = req.body || {};

    const firm = await Firm.findById(firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    // Retain legacy fields without allowing them to restrict product access.
    firm.planType = "FREE";
    firm.planExpiry = null;
    if (typeof isActive === "boolean") {
      firm.isActive = isActive;
    }

    await firm.save();

    return res.json({
      ok: true,
      firm: {
        ...serializeFirmForSuper(firm),
        planType: "FREE",
        planExpiry: null,
        accessModel: "FREE",
      },
    });
  } catch (err) {
    next(err);
  }
};

// Resolves a user through their membership row in the *target firm from the
// request* — the multi-firm source of truth. Any status qualifies: the roster
// lists ACTIVE members only, but a super admin may still need to tombstone the
// account of a previously removed member.
async function findUserScopedToFirm(firmId, userId) {
  const membership = await FirmMembership.findOne({ firmId, userId })
    .select("_id")
    .lean();
  if (!membership) return null;
  return User.findOne({ _id: userId }).select("_id email role isActive");
}

// 7) Update a user's role / active flag inside a firm (super admin only)
export const updateFirmUserForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId, userId } = req.params;
    const { role, isActive } = req.body || {};

    // Membership is the multi-firm source of truth (listFirmUsersForSuper reads the
    // same table). The legacy User.firmId only reflects one workspace, so scoping on
    // it 404'd any member whose membership points at this firm while their embedded
    // workspace field holds another firm — exactly the cross-firm edit this route
    // exists for.
    const user = await findUserScopedToFirm(firmId, userId);
    if (!user) {
      return res
        .status(404)
        .json({ ok: false, error: "User not found in firm" });
    }

    if (role && ["USER", "FIRM_ADMIN", "SUPER_ADMIN"].includes(role)) {
      user.role = role;
    }

    if (typeof isActive === "boolean") {
      user.isActive = isActive;
    }

    await user.save();

    return res.json({
      ok: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    });
  } catch (err) {
    next(err);
  }
};

// 8) Delete a user inside a firm (super admin only)
export const deleteFirmUserForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId, userId } = req.params;

    // Same membership-scoped lookup as the update route above.
    const user = await findUserScopedToFirm(firmId, userId);
    if (!user) {
      return res
        .status(404)
        .json({ ok: false, error: "User not found in firm" });
    }

    if (user.role === "SUPER_ADMIN") {
      return res
        .status(400)
        .json({ ok: false, error: "Cannot delete super admin account" });
    }

    // Tombstone rather than hard-delete. ActivityEvent rows and retained work product hold this
    // user's _id, so removing the row leaves them pointing at nothing — the same reason the firm
    // cascade classifies User as PSEUDONYMISE rather than PURGE. The tombstone clears every
    // identifying field, frees the original email for reuse, and bumps tokenVersion so any live
    // session stops authenticating immediately.
    //
    // Neutralise the account first. Removing memberships first would, if this step then failed,
    // leave a live account pointing at a firm with no membership rows, which firm guards read as
    // a legacy account rather than a removal.
    await User.updateOne({ _id: user._id, ...userNeedsTombstone() }, userTombstone(user._id));
    await FirmMembership.deleteMany({ userId: user._id });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// 9) Erase a firm and everything scoped to it (super admin only).
//
// This previously detached users and deleted Task and Reminder: 3 of the 33 firm-scoped
// collections. The other 30 were left behind, orphaned and unreachable, which is the defect L12
// exists to close. It now drives the classified plan in firm-erasure.service.js — the same list
// the coverage gate enforces, so the two cannot drift apart.
export const deleteFirmForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId } = req.params;

    const firm = await Firm.findById(firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    // Explicit confirmation. This endpoint used to do far less, and it is now irreversible across
    // 33 collections — an old habit or a stale script must not trigger it by accident.
    if (req.body?.confirmation !== "ERASE_FIRM_DATA") {
      const plan = buildErasurePlan();
      const count = (strategy) => plan.filter((r) => r.strategy === strategy).length;
      return res.status(400).json({
        ok: false,
        error:
          'Confirmation required. Send { "confirmation": "ERASE_FIRM_DATA" } to erase this firm. This cannot be undone.',
        plan: {
          collections: plan.length,
          purge: count(STRATEGY.PURGE),
          pseudonymise: count(STRATEGY.PSEUDONYMISE),
          retain: count(STRATEGY.RETAIN),
        },
      });
    }

    // Deterministic by default, so retrying an interrupted erasure RESUMES the existing receipt
    // rather than starting a second cascade and a second, competing record of the same event.
    const supplied = typeof req.body?.operationId === "string" ? req.body.operationId.trim() : "";
    const operationId = supplied || `firm-erasure-${firmId}`;

    const receipt = await eraseFirm({
      operationId,
      firmId: firm._id,
      firmDisplayName: firm.name || "",
      authorisedByUserId: req.user.id,
      requestReference:
        typeof req.body?.requestReference === "string" ? req.body.requestReference.trim() : "",
    });

    // Drop the firm row only once the cascade is complete. An interrupted erasure deliberately
    // leaves it in place: a firm row with its data already gone is recoverable by re-running,
    // whereas a deleted firm row with live data still behind it is orphaned for good.
    if (receipt.status === "COMPLETED") {
      await firm.deleteOne();
    }

    return res.json({ ok: receipt.status === "COMPLETED", receipt });
  } catch (err) {
    next(err);
  }
};

// The outstanding erasure requests (L12 step 6). A request set through PATCH /api/auth/me lands
// here; nothing is erased until a super administrator acts on it, which is the whole point of
// keeping the two apart. Mirrors the pending firm-admin queue above rather than inventing a shape.
export const listErasureRequestsForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const users = await User.find({ erasureRequestedAt: { $ne: null } })
      .select("email name role firmId erasureRequestedAt")
      .sort({ erasureRequestedAt: 1 })
      .lean();

    return res.json({
      ok: true,
      count: users.length,
      requests: users.map((u) => ({
        userId: String(u._id),
        email: u.email,
        name: u.name,
        role: u.role,
        firmId: u.firmId ? String(u.firmId) : null,
        requestedAt: u.erasureRequestedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// Read an erasure receipt back after the fact. The receipt is returned by the erasure itself, but
// an audit record nobody can re-read afterwards is not much of an audit record.
export const getErasureReceiptForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const receipt = await getErasureReceipt(req.params.operationId);
    if (!receipt) {
      return res.status(404).json({ ok: false, error: "Erasure receipt not found" });
    }
    return res.json({ ok: true, receipt });
  } catch (err) {
    next(err);
  }
};

// Force-logout a user on every device by bumping their tokenVersion. Every JWT
// issued before this instant immediately fails authentication — the response
// for a compromised/leaked token or a "sign out everywhere" request.
export const forceLogoutUser = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res.json({
      ok: true,
      user: {
        id: user._id,
        email: user.email,
        tokenVersion: user.tokenVersion,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Start an isolated, asynchronous deep-system review. The runner seeds only
// dedicated synthetic records, verifies section outputs, removes every seeded
// record, and sends the synthetic evidence summary to DeepSeek for an advisory
// semantic cross-check. Real email delivery remains a separate explicit probe.
export const runSystemSelfTest = async (req, res, next) => {
  try {
    assertSuper(req.user);
    if (req.body?.confirmation !== "RUN_ISOLATED_DEEP_TEST") {
      return res.status(400).json({
        ok: false,
        code: "SYSTEM_TEST_CONFIRMATION_REQUIRED",
        error: "Explicit deep-test confirmation is required",
      });
    }
    const run = await startDeepSelfTest({ requestedBy: req.user.id });
    return res.status(202).json({ ok: true, run });
  } catch (err) {
    if (err?.code === "SYSTEM_TEST_ALREADY_RUNNING") {
      return res.status(409).json({
        ok: false,
        code: err.code,
        error: err.message,
        runId: err.runId,
      });
    }
    return next(err);
  }
};

export const getSystemSelfTestRun = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const run = await getDeepSelfTestRun(req.params.runId);
    return res.json({ ok: true, run });
  } catch (err) {
    return next(err);
  }
};

export const getLatestSystemSelfTestRun = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const run = await getLatestDeepSelfTestRun();
    return res.json({ ok: true, run });
  } catch (err) {
    return next(err);
  }
};

// Super-admin only: send a real test email to the admin's own address to
// confirm the email pipeline (Resend) is delivering.
export const sendSuperTestEmail = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const to = req.user.email;
    try {
      const result = await sendTestEmail(to);
      return res.json({
        ok: true,
        to,
        id: result?.providerMessageId || "",
      });
    } catch (mailErr) {
      // Surface the real provider error to the admin diagnostic instead of a 500,
      // so "is email working?" gets a precise answer (rate limit, domain, key, etc.).
      return res.json({
        ok: false,
        to,
        error: String(mailErr?.message || mailErr).slice(0, 500),
      });
    }
  } catch (err) {
    return next(err);
  }
};

// Super-admin only: compute the current digest live and email it once to the
// admin, to confirm the digest email (content + delivery) is working. This does
// NOT create or alter any DigestDelivery, so it never affects the weekly dedup.
// Body: { kind?: "WEEKLY_FIRM" | "DAILY_PERSONAL" } (defaults to WEEKLY_FIRM).
export const sendTestDigest = async (req, res, next) => {
  try {
    assertSuper(req.user);
    if (!req.user.firmId) {
      return res.status(400).json({
        ok: false,
        error: "No active firm to summarize. Switch to a firm workspace first.",
      });
    }
    const kind = String(req.body?.kind || "WEEKLY_FIRM").toUpperCase();
    try {
      const result = await sendTestDigestNow({
        userId: req.user.id,
        firmId: req.user.firmId,
        role: req.user.role,
        toEmail: req.user.email,
        kind,
      });
      return res.json({
        ok: true,
        sentTo: req.user.email,
        kind,
        periodKey: result.summary.periodKey,
        counts: result.summary.counts,
        providerMessageId: result.providerMessageId,
      });
    } catch (sendErr) {
      // A DigestError carries a status/code; surface it precisely. Otherwise
      // report the provider error so the diagnostic stays informative.
      const status = sendErr?.status || sendErr?.statusCode || 400;
      return res.status(status).json({
        ok: false,
        error: String(sendErr?.message || sendErr).slice(0, 500),
        code: sendErr?.code || null,
      });
    }
  } catch (err) {
    return next(err);
  }
};

// 16) Email observability (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).
//
// One request returns the filtered list AND the summary for the same window:
// the panel loads the whole page with a single call (superLimiter budget).
// Recipient addresses exist only as sha256 hashes — the client hashes an
// exact-address search input before sending it, so a raw address never
// reaches the server for search and none is stored for display.

function parseEmailDateBoundary(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed);
}

const EMAILS_PAGE_LIMIT = 25;
const EMAILS_MAX_LIMIT = 100;

export const listEmailDeliveriesForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = parseEmailDateBoundary(req.query.from, defaultFrom);
    const toRaw = parseEmailDateBoundary(req.query.to, now);
    const to = new Date(Math.min(toRaw.getTime(), now.getTime()));

    const filter = { sentAt: { $gte: from, $lte: to } };
    const types = String(req.query.types || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (types.length) filter.type = { $in: types };
    const statuses = String(req.query.statuses || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length) filter.status = { $in: statuses };
    if (req.query.firmId && mongoose.isValidObjectId(req.query.firmId)) {
      filter.firmId = req.query.firmId;
    }
    // Exact-address search: the client hashes the address (sha256 of the
    // lowercased trimmed value) so no raw address is sent or stored.
    const hash = String(req.query.recipientHash || "").trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hash)) filter.recipientEmailHash = hash;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(EMAILS_MAX_LIMIT, Math.max(1, Number(req.query.limit) || EMAILS_PAGE_LIMIT));

    const [rows, total, summaryRows] = await Promise.all([
      EmailDelivery.find(filter)
        .sort({ sentAt: -1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // recipientEmailHash is deliberately excluded: the panel computes the hash
        // client-side for search and never needs it back, so the list carries one less
        // pseudonymous identifier (the detail endpoint excludes it the same way).
        .select("type recipientEmailLast4 subjectTemplateName providerMessageId status errorClass sentAt deliveredAt lastEventAt firmId userId meta backfilled createdAt")
        .populate("firmId", "displayName handle")
        .lean(),
      EmailDelivery.countDocuments(filter),
      EmailDelivery.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const summary = { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, queued: 0 };
    for (const row of summaryRows) {
      if (row._id in summary) summary[row._id] = row.count;
    }
    const attempts = summary.sent + summary.delivered + summary.bounced + summary.complained;
    const bounceRate = attempts > 0 ? Math.round(((summary.bounced + summary.complained) / attempts) * 100) : 0;

    return res.json({
      ok: true,
      emails: rows,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
      summary: { ...summary, bounceRate, window: { from: from.toISOString(), to: to.toISOString() } },
    });
  } catch (err) {
    next(err);
  }
};

export const getEmailDeliveryForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ ok: false, error: "Email delivery not found" });
    }
    const row = await EmailDelivery.findById(id)
      .select("-recipientEmailHash")
      .populate("firmId", "displayName handle")
      .lean();
    if (!row) {
      return res.status(404).json({ ok: false, error: "Email delivery not found" });
    }
    // The timeline is the row's own lifecycle — no provider call is made here.
    const timeline = [];
    if (row.backfilled) timeline.push({ event: "backfilled", at: row.sentAt || row.createdAt });
    if (row.sentAt) timeline.push({ event: "sent", at: row.sentAt });
    if (row.deliveredAt) timeline.push({ event: "delivered", at: row.deliveredAt });
    if (row.status === "bounced" || row.status === "complained" || row.status === "failed") {
      timeline.push({ event: row.status, at: row.lastEventAt || row.updatedAt });
    }
    return res.json({ ok: true, email: { ...row, timeline } });
  } catch (err) {
    next(err);
  }
};

export const listEmailSuppressionsForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const rows = await EmailSuppression.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json({
      ok: true,
      // The hash is the row's key, not a display value; the client shows the
      // reason, date, and a removable id only.
      suppressions: rows.map((row) => ({
        id: row._id,
        reason: row.reason,
        firmId: row.firmId || null,
        createdBy: row.createdBy || null,
        createdAt: row.createdAt,
      })),
      truncated: rows.length >= 200,
    });
  } catch (err) {
    next(err);
  }
};

export const deleteEmailSuppressionForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ ok: false, error: "Suppression not found" });
    }
    const removed = await EmailSuppression.findByIdAndDelete(id);
    if (!removed) {
      return res.status(404).json({ ok: false, error: "Suppression not found" });
    }
    // Audited: ActivityEvent keeps the operational trail for super-admin actions.
    // source SUPER_ADMIN is the one value recordActivity accepts with no tenant
    // firmId; the previous "super-panel" value failed that validation, so the
    // promised audit row for removals was silently never written.
    await safeRecordActivity({
      userId: req.user.id,
      firmId: null,
      action: "EMAIL_SUPPRESSION_REMOVED",
      entityType: "EmailSuppression",
      entityId: String(id),
      beforeSummary: null,
      afterSummary: "Super admin removed a do-not-email record",
      source: "SUPER_ADMIN",
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// PUT /api/super/config/resend-webhook-secret — store the Resend webhook
// signing secret (the Svix whsec value from the Resend dashboard). Write-only:
// the stored value is never returned, in this response or any other. The
// environment's RESEND_WEBHOOK_SECRET keeps precedence, so this field is the
// fallback the hosting platform's unmanageable environment leaves room for.
// Audited like the removal of a suppression: an ActivityEvent names the
// action, never the value.
export const configureResendWebhookSecret = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const secret = typeof req.body?.secret === "string" ? req.body.secret : "";
    const result = await AppConfig.setResendWebhookSecret(secret);
    await safeRecordActivity({
      userId: req.user.id,
      firmId: null,
      action: "RESEND_WEBHOOK_SECRET_CONFIGURED",
      entityType: "AppConfig",
      entityId: "singleton",
      beforeSummary: null,
      afterSummary: result.configured
        ? "Super admin stored a Resend webhook signing secret"
        : "Super admin cleared the Resend webhook signing secret",
      source: "SUPER_ADMIN",
    }).catch(() => {});
    return res.json({ ok: true, configured: result.configured });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ ok: false, error: err.message });
    next(err);
  }
};

export const clearResendWebhookSecret = async (req, res, next) => {
  try {
    assertSuper(req.user);
    await AppConfig.setResendWebhookSecret(null);
    await safeRecordActivity({
      userId: req.user.id,
      firmId: null,
      action: "RESEND_WEBHOOK_SECRET_CLEARED",
      entityType: "AppConfig",
      entityId: "singleton",
      beforeSummary: null,
      afterSummary: "Super admin cleared the Resend webhook signing secret",
      source: "SUPER_ADMIN",
    }).catch(() => {});
    return res.json({ ok: true, configured: false });
  } catch (err) {
    next(err);
  }
};

export const getResendWebhookSecretState = async (req, res, next) => {
  try {
    assertSuper(req.user);
    const stored = await AppConfig.getResendWebhookSecret();
    return res.json({
      ok: true,
      configured: Boolean(stored) || Boolean(process.env.RESEND_WEBHOOK_SECRET),
      source: process.env.RESEND_WEBHOOK_SECRET ? "environment" : stored ? "appconfig" : "none",
    });
  } catch (err) {
    next(err);
  }
};
