import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";

const SUPER_ADMIN_EMAIL = "saifullahfaizan786@gmail.com";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REMOVED_MEMBER_MESSAGE = "You are no longer a member of this workspace";

function reject(req, res, status, error) {
  return res.status(status).json({
    ok: false,
    error,
    requestId: req.id || "",
  });
}

// Models are injected so the authority matrix (non-member, removed member,
// read-only member, member, firm admin, super admin) can be tested without a
// database connection.
export function createFirmAuthorization({
  FirmModel = Firm,
  MembershipModel = FirmMembership,
} = {}) {
  function findMembership(userId, firmId, fields) {
    return MembershipModel.findOne({ userId, firmId }).select(fields).lean();
  }

  function rejectWithoutActiveMembership(req, res, membership) {
    return reject(
      req,
      res,
      403,
      membership ? REMOVED_MEMBER_MESSAGE : "Firm membership required",
    );
  }

  async function requireActiveFirm(req, res, next, { adminOnly = false } = {}) {
    try {
      if (!req.user) return reject(req, res, 401, "Unauthorized");
      if (!req.user.firmId) {
        return reject(req, res, 403, "Firm membership required");
      }

      const [firm, membership] = await Promise.all([
        FirmModel.findOne({ _id: req.user.firmId, isActive: true })
          .select("_id ownerUserId kind")
          .lean(),
        findMembership(req.user.id, req.user.firmId, "role status"),
      ]);
      if (!firm) {
        return reject(req, res, 403, "Firm is inactive or unavailable");
      }

      const hasActiveMembership = membership?.status === "ACTIVE";
      const isOwner =
        String(firm.ownerUserId || "") === String(req.user.id) &&
        hasActiveMembership &&
        membership.role === "OWNER";
      const isFirmAdmin = hasActiveMembership && membership.role === "ADMIN";
      const isSuperAdmin = req.user.role === "SUPER_ADMIN";

      if (!isOwner && !isSuperAdmin && firm.kind === "PERSONAL") {
        return reject(req, res, 403, "Firm membership required");
      }

      // SUPER_ADMIN remains the only explicit global bypass. Firm ownership
      // requires both ownerUserId and an ACTIVE OWNER membership to agree.
      if (!isOwner && !isSuperAdmin && !hasActiveMembership) {
        return rejectWithoutActiveMembership(req, res, membership);
      }

      if (adminOnly && !isOwner && !isSuperAdmin && !isFirmAdmin) {
        return reject(req, res, 403, "Firm admin only");
      }

      req.firm = firm;
      req.firmMembership = membership || null;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  // Production route chains run requireFirmMember first. Mutations deliberately
  // query again so membership removal, firm deactivation, and firm-local role
  // changes are rechecked immediately before write policy is applied.
  async function requireFirmWriteAccess(req, res, next) {
    if (!MUTATING_METHODS.has(req.method)) return next();

    try {
      if (!req.user) return reject(req, res, 401, "Unauthorized");
      if (!req.user.firmId) {
        return reject(req, res, 403, "Firm membership required");
      }

      const [firm, membership] = await Promise.all([
        FirmModel.findOne({ _id: req.user.firmId, isActive: true })
          .select("_id ownerUserId kind memberAccess")
          .lean(),
        findMembership(req.user.id, req.user.firmId, "role status"),
      ]);
      if (!firm) {
        return reject(req, res, 403, "Firm is inactive or unavailable");
      }

      const hasActiveMembership = membership?.status === "ACTIVE";
      const isOwner =
        String(firm.ownerUserId || "") === String(req.user.id) &&
        hasActiveMembership &&
        membership.role === "OWNER";
      const isFirmAdmin = hasActiveMembership && membership.role === "ADMIN";
      const isSuperAdmin = req.user.role === "SUPER_ADMIN";

      if (!isOwner && !isSuperAdmin && firm.kind === "PERSONAL") {
        return reject(req, res, 403, "Firm membership required");
      }
      if (isOwner || isSuperAdmin) {
        req.firm = firm;
        req.firmMembership = membership || null;
        return next();
      }

      if (!hasActiveMembership) {
        return rejectWithoutActiveMembership(req, res, membership);
      }

      // ADMIN remains a firm-local bypass. A stale OWNER row belonging to a
      // non-owner follows ordinary member write policy instead.
      if (isFirmAdmin) {
        req.firm = firm;
        req.firmMembership = membership;
        return next();
      }

      // Absent on legacy firms means EDIT. Only an explicit READ_ONLY policy
      // blocks an ACTIVE plain member.
      if (firm.memberAccess === "READ_ONLY") {
        return reject(
          req,
          res,
          403,
          "This workspace is read-only for you. Ask the firm owner to allow member edits.",
        );
      }

      req.firm = firm;
      req.firmMembership = membership;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  return {
    requireFirmMember: (req, res, next) => requireActiveFirm(req, res, next),
    requireFirmAdmin: (req, res, next) =>
      requireActiveFirm(req, res, next, { adminOnly: true }),
    requireFirmWriteAccess,
  };
}

const firmAuthorization = createFirmAuthorization();

export const requireFirmMember = firmAuthorization.requireFirmMember;
export const requireFirmAdmin = firmAuthorization.requireFirmAdmin;
export const requireFirmWriteAccess = firmAuthorization.requireFirmWriteAccess;

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return reject(req, res, 401, "Unauthorized");
  const email = String(req.user.email || "")
    .trim()
    .toLowerCase();
  if (req.user.role !== "SUPER_ADMIN" || email !== SUPER_ADMIN_EMAIL) {
    return reject(req, res, 403, "Super admin only");
  }
  return next();
}

export { SUPER_ADMIN_EMAIL };
