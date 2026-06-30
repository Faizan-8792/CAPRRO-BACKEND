// src/controllers/super.controller.js

import User from "../models/User.js";
import Firm from "../models/Firm.js";
import Task from "../models/Task.js";
import Reminder from "../models/Reminder.js";

const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

function assertSuper(user) {
  if (!user || user.role !== "SUPER_ADMIN" || user.email !== SUPER_EMAIL) {
    const err = new Error("Super admin only");
    err.statusCode = 403;
    throw err;
  }
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
        $match: { lastActiveAt: { $gte: new Date(now.getTime() - 14 * dayMs) } },
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
          totalUsers > 0
            ? Math.round((totalEverActive / totalUsers) * 100)
            : 0,
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
      premiumFirms,
      freeFirms,
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
      Firm.countDocuments({ planType: "PREMIUM" }),
      Firm.countDocuments({ planType: "FREE" }),
      Task.countDocuments({}),
      Task.countDocuments({ isActive: true }),
      User.countDocuments({ role: "FIRM_ADMIN", isActive: false }),
      Reminder.countDocuments({}),
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
          premium: premiumFirms,
          free: freeFirms,
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

// 1) Pending firm admins list
export const listPendingAdmins = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const users = await User.find({
      role: "FIRM_ADMIN",
      isActive: false,
    })
      .select("email name firmId createdAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, users });
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

    if (!user || user.role !== "FIRM_ADMIN") {
      return res
        .status(404)
        .json({ ok: false, error: "Firm admin not found" });
    }

    if (user.isActive) {
      return res
        .status(400)
        .json({ ok: false, error: "Already approved" });
    }

    user.isActive = true;
    await user.save();

    return res.json({
      ok: true,
      user: { id: user._id, email: user.email, isActive: true },
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

    if (!user || user.role !== "FIRM_ADMIN") {
      return res
        .status(404)
        .json({ ok: false, error: "Firm admin not found" });
    }

    user.role = "USER";
    user.accountType = "INDIVIDUAL";
    user.isActive = true;
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

    const firms = await Firm.find({})
      .sort({ createdAt: -1 })
      .lean();

    const ownerIds = firms.map((f) => f.ownerUserId);
    const owners = await User.find({ _id: { $in: ownerIds } })
      .select("email name role isActive firmId")
      .lean();

    const ownersById = new Map();
    owners.forEach((u) => ownersById.set(String(u._id), u));

    const enriched = firms.map((f) => ({
      ...f,
      owner: ownersById.get(String(f.ownerUserId)) || null,
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

    const users = await User.find({ firmId })
      .select("email name role accountType isActive createdAt")
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      ok: true,
      firm,
      users,
    });
  } catch (err) {
    next(err);
  }
};

// 6) Update firm plan (FREE / PREMIUM) + expiry + active flag
export const updateFirmPlan = async (req, res, next) => {
  try {
    assertSuper(req.user);

    const { firmId } = req.params;
    const { planType, planExpiry, isActive } = req.body || {};

    const firm = await Firm.findById(firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    if (planType && ["FREE", "PREMIUM"].includes(planType)) {
      firm.planType = planType;
    }

    if (planExpiry === null) {
      firm.planExpiry = null;
    } else if (planExpiry) {
      const d = new Date(planExpiry);
      if (!Number.isNaN(d.getTime())) {
        firm.planExpiry = d;
      }
    }

    if (typeof isActive === "boolean") {
      firm.isActive = isActive;
    }

    await firm.save();

    return res.json({ ok: true, firm });
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
      return res.status(404).json({ ok: false, error: "User not found in firm" });
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
      return res.status(404).json({ ok: false, error: "User not found in firm" });
    }

    if (user.role === "SUPER_ADMIN") {
      return res
        .status(400)
        .json({ ok: false, error: "Cannot delete super admin account" });
    }

    await user.deleteOne();

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

    // Detach all users from this firm: back to normal USER
    await User.updateMany(
      { firmId: firm._id },
      {
        $set: {
          firmId: null,
          role: "USER",
          accountType: "INDIVIDUAL",
        },
      }
    );

    // Cascade delete: remove all tasks and reminders belonging to this firm
    await Task.deleteMany({ firmId: firm._id });
    await Reminder.deleteMany({ firmId: firm._id });

    await firm.deleteOne();

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};