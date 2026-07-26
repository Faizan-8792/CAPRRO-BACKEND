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

    const firm = await Firm.findOne({
      _id: req.user.firmId,
      isActive: true,
    })
      .select("_id ownerUserId")
      .lean();
    if (!firm) {
      return reject(req, res, 403, "Firm is inactive or unavailable");
    }

    if (adminOnly) {
      // Firm-admin authority is granted by global role (FIRM_ADMIN/SUPER_ADMIN)
      // or by owning the active firm. Owning the firm is authoritative even if
      // the global role pointer has drifted after a workspace switch.
      const isOwner = String(firm.ownerUserId || "") === String(req.user.id);
      const elevatedRole =
        req.user.role === "FIRM_ADMIN" || req.user.role === "SUPER_ADMIN";
      if (!isOwner && !elevatedRole) {
        return reject(req, res, 403, "Firm admin only");
      }
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

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Blocks write requests from plain members when the active firm is READ_ONLY.
// Deliberately lenient/surgical: it only ever ADDS a block for the specific
// read-only case. It passes non-mutating methods, users without a firm, missing
// firms, the firm owner, and elevated roles (FIRM_ADMIN/SUPER_ADMIN) untouched,
// so it can be mounted on a router without changing any existing behaviour.
export async function requireFirmWriteAccess(req, res, next) {
  try {
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (!req.user || !req.user.firmId) return next();
    const elevated =
      req.user.role === "FIRM_ADMIN" || req.user.role === "SUPER_ADMIN";
    if (elevated) return next();
    const firm = await Firm.findOne({ _id: req.user.firmId })
      .select("_id ownerUserId memberAccess")
      .lean();
    if (!firm) return next();
    const isOwner = String(firm.ownerUserId || "") === String(req.user.id);
    if (isOwner) return next();
    if (firm.memberAccess === "READ_ONLY") {
      return reject(
        req,
        res,
        403,
        "This workspace is read-only for you. Ask the firm owner to allow member edits."
      );
    }
    return next();
  } catch (error) {
    return next(error);
  }
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
