import Firm from "../models/Firm.js";

const SUPER_ADMIN_EMAIL = "saifullahfaizan786@gmail.com";

function reject(req, res, status, error) {
  return res.status(status).json({
    ok: false,
    error,
    requestId: req.id || "",
  });
}

async function requireActiveFirm(req, res, next, { adminOnly = false } = {}) {
  try {
    if (!req.user) return reject(req, res, 401, "Unauthorized");
    if (!req.user.firmId) {
      return reject(req, res, 403, "Firm membership required");
    }
    if (adminOnly && req.user.role !== "FIRM_ADMIN") {
      return reject(req, res, 403, "Firm admin only");
    }

    const firm = await Firm.findOne({
      _id: req.user.firmId,
      isActive: true,
    })
      .select("_id ownerUserId")
      .lean();
    if (!firm) {
      return reject(req, res, 403, "Firm is inactive or unavailable");
    }

    req.firm = firm;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireFirmMember(req, res, next) {
  return requireActiveFirm(req, res, next);
}

export function requireFirmAdmin(req, res, next) {
  return requireActiveFirm(req, res, next, { adminOnly: true });
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return reject(req, res, 401, "Unauthorized");
  const email = String(req.user.email || "").trim().toLowerCase();
  if (req.user.role !== "SUPER_ADMIN" || email !== SUPER_ADMIN_EMAIL) {
    return reject(req, res, 403, "Super admin only");
  }
  return next();
}

export { SUPER_ADMIN_EMAIL };
