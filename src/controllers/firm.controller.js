// src/controllers/firm.controller.js
import Firm from "../models/Firm.js";
import User from "../models/User.js";

async function assertFirmAdmin(userId, firmId) {
  const firm = await Firm.findById(firmId);
  if (!firm) {
    const err = new Error("Firm not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(firm.ownerUserId) !== String(userId)) {
    const err = new Error("Not authorized for this firm");
    err.statusCode = 403;
    throw err;
  }

  return firm;
}

// POST /api/firms
export const createFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { displayName, handle, description, practiceAreas } = req.body || {};

    if (!displayName || !handle) {
      return res
        .status(400)
        .json({ ok: false, error: "displayName and handle are required" });
    }

    const normalizedHandle = String(handle).trim().toLowerCase();
    const existing = await Firm.findOne({ handle: normalizedHandle });
    if (existing) {
      return res.status(409).json({ ok: false, error: "Firm handle already taken" });
    }

    let joinCode;
    while (true) {
      joinCode = Firm.generateJoinCode();
      const clash = await Firm.findOne({ joinCode });
      if (!clash) break;
    }

    const firm = await Firm.create({
      displayName: displayName.trim(),
      handle: normalizedHandle,
      ownerUserId: userId,
      description: description || "",
      practiceAreas: Array.isArray(practiceAreas) ? practiceAreas : [],
      joinCode,
      planType: "FREE",
      planExpiry: null,
      isActive: true,
    });

    // owner becomes FIRM_ADMIN but INACTIVE until Super Admin approves
    await User.findByIdAndUpdate(
      userId,
      {
        role: "FIRM_ADMIN",
        accountType: "FIRM_USER",
        firmId: firm._id,
        isActive: false,  // PENDING APPROVAL
      },
      { new: true }
    );

    return res.status(201).json({ ok: true, firm });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/me
export const getMyFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user || !user.firmId) {
      return res.status(404).json({ ok: false, error: "User is not linked to any firm" });
    }

    const firm = await Firm.findById(user.firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    return res.json({ ok: true, firm });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/:firmId
export const getFirmById = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);
    return res.json({ ok: true, firm });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/firms/:firmId
export const updateFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    const { displayName, description, practiceAreas, joinCode } = req.body || {};
    
    // Update basic fields
    if (displayName !== undefined) firm.displayName = displayName.trim();
    if (description !== undefined) firm.description = description || "";
    if (Array.isArray(practiceAreas)) firm.practiceAreas = practiceAreas;

    // Handle custom join code update
    if (joinCode) {
      const normalizedCode = String(joinCode).trim().toUpperCase();
      
      // Validate length
      if (normalizedCode.length < 4 || normalizedCode.length > 10) {
        return res.status(400).json({ 
          ok: false, 
          error: "Join code must be 4-10 characters" 
        });
      }

      // Check for clashes with other firms
      const clash = await Firm.findOne({ 
        joinCode: normalizedCode,
        _id: { $ne: firmId }
      });
      
      if (clash) {
        return res.status(409).json({ 
          ok: false, 
          error: "Join code already taken by another firm" 
        });
      }

      firm.joinCode = normalizedCode;
    }

    await firm.save();
    return res.json({ ok: true, firm });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/:firmId/join-code/rotate
export const rotateJoinCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    // Generate unique join code
    let joinCode;
    while (true) {
      joinCode = Firm.generateJoinCode();
      const clash = await Firm.findOne({ 
        joinCode,
        _id: { $ne: firmId }
      });
      if (!clash) break;
    }

    firm.joinCode = joinCode;
    await firm.save();

    return res.json({ ok: true, joinCode: firm.joinCode });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/join
export const joinFirmByCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { joinCode } = req.body || {};

    if (!joinCode) {
      return res.status(400).json({ ok: false, error: "joinCode is required" });
    }

    const firm = await Firm.findOne({
      joinCode: String(joinCode).trim().toUpperCase(),
    });

    if (!firm || !firm.isActive) {
      return res.status(404).json({ ok: false, error: "Invalid or inactive join code" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    user.firmId = firm._id;
    user.accountType = "FIRM_USER";
    await user.save();

    // ✅ FIX: Return UPDATED USER with firmId for popup.js
    const updatedUser = await User.findById(userId).select('firmId accountType role name email');

    return res.json({
      ok: true,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
      },
      user: updatedUser  // ✅ This fixes popup.js
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/:firmId/users
export const listFirmUsers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    const users = await User.find({ firmId: firm._id }).select(
      "email name role accountType createdAt isActive"
    );

    return res.json({
      ok: true,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
      },
      users,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/request-admin
// Current user wants to become FIRM_ADMIN of their linked firm
export const requestFirmAdmin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (!user.firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    // Agar already firm admin hai
    if (user.role === "FIRM_ADMIN") {
      if (user.isActive) {
        return res.json({
          ok: true,
          alreadyAdmin: true,
          message: "Already an approved Firm Admin",
        });
      }
      return res.json({
        ok: true,
        alreadyPending: true,
        message: "Firm Admin approval is already pending",
      });
    }

    // Yahin pe request create karte hain:
    user.role = "FIRM_ADMIN";
    user.accountType = "FIRM_USER";
    user.isActive = false; // pending approval
    await user.save();

    return res.json({
      ok: true,
      message: "Firm Admin request created. Wait for Super Admin approval.",
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/firms/:firmId/users/:userId
// Firm owner can delete firm members (not self)
export const deleteFirmUser = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId, userId: targetUserId } = req.params;
    
    const firm = await assertFirmAdmin(userId, firmId);
    if (!firm) return res.status(404).json({ ok: false, error: "Firm not found" });

    // Cannot delete self
    if (String(targetUserId) === String(userId)) {
      return res.status(400).json({ ok: false, error: "Cannot delete yourself" });
    }

    // Delete user from firm (set firmId null)
    await User.findByIdAndUpdate(targetUserId, {
      firmId: null,
      accountType: "INDIVIDUAL",
      role: "USER"
    });

    // Return updated user list
    const users = await User.find({ firmId: firm._id }).select(
      "email name role accountType createdAt isActive"
    );

    return res.json({
      ok: true,
      firm: { id: firm._id, displayName: firm.displayName, handle: firm.handle },
      users
    });
  } catch (err) {
    next(err);
  }
};

export default {
  createFirm,
  getMyFirm,
  getFirmById,
  updateFirm,
  rotateJoinCode,
  joinFirmByCode,
  listFirmUsers,
  requestFirmAdmin,
  deleteFirmUser  // ✅ ADD
};