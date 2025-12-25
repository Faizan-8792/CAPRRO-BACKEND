// src/controllers/super.controller.js

import User from "../models/User.js";
import Firm from "../models/Firm.js";

const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

function assertSuper(user) {
  if (!user || user.role !== "SUPER_ADMIN" || user.email !== SUPER_EMAIL) {
    const err = new Error("Super admin only");
    err.statusCode = 403;
    throw err;
  }
}

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

    await firm.deleteOne();

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};