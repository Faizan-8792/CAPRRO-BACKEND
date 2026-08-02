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

  async function requireActiveFirm(req, res, next, { adminOnly = false } = {}) {
    try {
      if (!req.user) return reject(req, res, 401, "Unauthorized");
      if (!req.user.firmId) {
        return reject(req, res, 403, "Firm membership required");
      }

      const [firm, membership] = await Promise.all([
        FirmModel.findOne({ _id: req.user.firmId, isActive: true })
          .select("_id ownerUserId")
          .lean(),
        findMembership(req.user.id, req.user.firmId, "role status"),
      ]);
      if (!firm) {
        return reject(req, res, 403, "Firm is inactive or unavailable");
      }

      const isOwner = String(firm.ownerUserId || "") === String(req.user.id);
      const isSuperAdmin = req.user.role === "SUPER_ADMIN";

      // FirmMembership is the source of truth for which firms a user may act
      // in. User.firmId can still point at a firm the user was removed from,
      // either because removal raced a workspace switch or because the pointer
      // was not repointed, so a REMOVED membership is refused on every request.
      if (
        membership &&
        membership.status !== "ACTIVE" &&
        !isOwner &&
        !isSuperAdmin
      ) {
        return reject(req, res, 403, REMOVED_MEMBER_MESSAGE);
      }

      if (adminOnly) {
        // Firm-admin authority comes from this firm: owning it, or holding an
        // OWNER/ADMIN membership in it. The global role is only consulted for
        // accounts that predate memberships, so a stale FIRM_ADMIN pointer can
        // never elevate someone recorded as a plain MEMBER here.
        const membershipRole =
          membership && membership.status === "ACTIVE" ? membership.role : null;
        const elevatedInFirm =
          membershipRole === "OWNER" || membershipRole === "ADMIN";
        const legacyElevated = !membership && req.user.role === "FIRM_ADMIN";

        if (!isOwner && !isSuperAdmin && !elevatedInFirm && !legacyElevated) {
          return reject(req, res, 403, "Firm admin only");
        }
      }

      req.firm = firm;
      req.firmMembership = membership || null;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  // Blocks write requests from plain members when the active firm is READ_ONLY,
  // and from members whose membership is no longer ACTIVE. Non-mutating
  // methods, users without a firm, missing firms, and the firm owner pass
  // through unchanged.
  async function requireFirmWriteAccess(req, res, next) {
    try {
      if (!MUTATING_METHODS.has(req.method)) return next();
      if (!req.user || !req.user.firmId) return next();

      const firm = await FirmModel.findOne({ _id: req.user.firmId })
        .select("_id ownerUserId memberAccess")
        .lean();
      if (!firm) return next();
      const isOwner = String(firm.ownerUserId || "") === String(req.user.id);
      if (isOwner) return next();
      if (req.user.role === "SUPER_ADMIN") return next();

      // A removed member keeps no write access, whatever their global role says.
      const membership = await findMembership(
        req.user.id,
        req.user.firmId,
        "role status",
      );
      if (membership && membership.status !== "ACTIVE") {
        return reject(req, res, 403, REMOVED_MEMBER_MESSAGE);
      }

      // Elevation is decided by authority in this firm, matching
      // requireFirmAdmin. A stale global FIRM_ADMIN pointer must not let a plain
      // member write in a read-only workspace; it is honoured only for accounts
      // that predate memberships.
      const membershipRole =
        membership && membership.status === "ACTIVE" ? membership.role : null;
      const elevatedInFirm =
        membershipRole === "OWNER" || membershipRole === "ADMIN";
      const legacyElevated = !membership && req.user.role === "FIRM_ADMIN";
      if (elevatedInFirm || legacyElevated) return next();

      if (firm.memberAccess === "READ_ONLY") {
        return reject(
          req,
          res,
          403,
          "This workspace is read-only for you. Ask the firm owner to allow member edits.",
        );
      }
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
