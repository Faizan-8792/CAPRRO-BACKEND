// src/controllers/super.controller.js

import User from "../models/User.js";
import Firm from "../models/Firm.js";
import Task from "../models/Task.js";
import Reminder from "../models/Reminder.js";
import FirmMembership from "../models/FirmMembership.js";
import {
  getDeepSelfTestRun,
  getLatestDeepSelfTestRun,
  startDeepSelfTest,
} from "../services/self-test.service.js";
import { sendTestEmail } from "../services/email.service.js";
import { sendTestDigestNow } from "../services/digest.service.js";
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

// 0a) Extension Usage Analytics (DAU/WAU/MAU)
export const getUsageStats = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const oneDay = new Date(now.getTime() - dayMs);
    const sevenDay = new Date(now.getTime() - 7 * dayMs);
    const thirtyDay = new Date(now.getTime() - 30 * dayMs);
    const ninetyDay = new Date(now.getTime() - 90 * dayMs);

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

    return res.json({
      ok: true,
      usage: {
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

    const firms = await Firm.find({}).sort({ createdAt: -1 }).lean();

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

    return res.json({ ok: true, firms: enriched });
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

// 7) Update a user's role / active flag inside a firm (super admin only)
export const updateFirmUserForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId, userId } = req.params;
    const { role, isActive } = req.body || {};

    const user = await User.findOne({ _id: userId, firmId });
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

    const user = await User.findOne({ _id: userId, firmId });
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

    // Delete the account first. Removing memberships first would, if this step
    // then failed, leave a live account pointing at a firm with no membership
    // rows, which firm guards read as a legacy account rather than a removal.
    await user.deleteOne();
    await FirmMembership.deleteMany({ userId: user._id });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// 9) Delete a firm (and detach its users)
export const deleteFirmForSuper = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId } = req.params;

    const firm = await Firm.findById(firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    // Detach all users whose ACTIVE workspace is this firm: they fall back to
    // their personal workspace on next login (getMe heals firmId).
    await User.updateMany(
      { firmId: firm._id },
      {
        $set: {
          firmId: null,
          role: "USER",
          accountType: "INDIVIDUAL",
        },
      },
    );

    // Remove all memberships for this firm so no orphan rows remain.
    await FirmMembership.deleteMany({ firmId: firm._id });

    // Cascade delete: remove all tasks and reminders belonging to this firm
    await Task.deleteMany({ firmId: firm._id });
    await Reminder.deleteMany({ firmId: firm._id });

    await firm.deleteOne();

    return res.json({ ok: true });
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
        id: result?.data?.id || result?.id || "",
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
