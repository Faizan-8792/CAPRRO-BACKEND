import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";
import { resolveFirmAuthority } from "../services/firm-authority.service.js";

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
// read-only member, viewer, member, firm admin, super admin) can be tested
// without a database connection.
//
// THE LADDER ITSELF IS NOT HERE. It lives in services/firm-authority.service.js,
// which is the single named accessor every authority decision in the product
// goes through. This file owns two things and only two: the order the questions
// are asked in, and the wording of each refusal. Those are presentation, and
// keeping them here is what let the ladder be centralised without any refusal
// changing its text.
//
// tests/firm-role-tier-contract.mjs pins that: it evaluates all 216 combinations
// through this chain and through the accessor and requires them to agree.
export function createFirmAuthorization({
  FirmModel = Firm,
  MembershipModel = FirmMembership,
} = {}) {
  function findMembership(userId, firmId, fields) {
    return MembershipModel.findOne({ userId, firmId }).select(fields).lean();
  }

  function rejectWithoutActiveMembership(req, res, authority) {
    return reject(
      req,
      res,
      403,
      // A retained removal row and never having been a member are different
      // facts, and a member who was removed is owed the sentence that says so.
      authority.wasRemoved
        ? REMOVED_MEMBER_MESSAGE
        : "Firm membership required",
    );
  }

  /**
   * Loads the firm and the caller's membership, then asks the accessor.
   *
   * `select` differs between the two guards below and is passed through rather
   * than unified: the write guard needs memberAccess, the read guard does not,
   * and widening a projection to tidy up a signature would fetch a field one
   * caller has no business reading.
   */
  async function loadAuthority(req, firmSelection) {
    const [firm, membership] = await Promise.all([
      FirmModel.findOne({ _id: req.user.firmId, isActive: true })
        .select(firmSelection)
        .lean(),
      findMembership(req.user.id, req.user.firmId, "role status"),
    ]);
    return {
      firm,
      membership,
      authority: resolveFirmAuthority({ user: req.user, firm, membership }),
    };
  }

  async function requireActiveFirm(req, res, next, { adminOnly = false } = {}) {
    try {
      if (!req.user) return reject(req, res, 401, "Unauthorized");
      if (!req.user.firmId) {
        return reject(req, res, 403, "Firm membership required");
      }

      const { firm, membership, authority } = await loadAuthority(
        req,
        "_id ownerUserId kind",
      );
      if (!firm) {
        return reject(req, res, 403, "Firm is inactive or unavailable");
      }

      // Somebody else's personal workspace is answered as though it were not
      // theirs to be a member of, which is exactly what it is.
      if (authority.isForeignPersonalWorkspace) {
        return reject(req, res, 403, "Firm membership required");
      }

      if (!authority.canRead) {
        return rejectWithoutActiveMembership(req, res, authority);
      }

      if (adminOnly && !authority.canAdminister) {
        return reject(req, res, 403, "Firm admin only");
      }

      req.firm = firm;
      req.firmMembership = membership || null;
      req.firmAuthority = authority;
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

      const { firm, membership, authority } = await loadAuthority(
        req,
        "_id ownerUserId kind memberAccess",
      );
      if (!firm) {
        return reject(req, res, 403, "Firm is inactive or unavailable");
      }
      if (authority.isForeignPersonalWorkspace) {
        return reject(req, res, 403, "Firm membership required");
      }

      if (authority.canWrite) {
        req.firm = firm;
        req.firmMembership = membership || null;
        req.firmAuthority = authority;
        return next();
      }

      // Below here the write is refused, and the three refusals say three
      // different things because they have three different remedies: rejoin,
      // ask the owner to allow member edits, or ask for a higher tier.
      if (!authority.canRead) {
        return rejectWithoutActiveMembership(req, res, authority);
      }

      // A VIEWER by firm-wide policy and a VIEWER by their own membership row
      // land on the same rung but need different sentences: one names a switch
      // the owner can flip, the other names a tier only the owner can raise.
      // Naming the wrong remedy sends somebody to ask for the wrong thing.
      if (
        firm.memberAccess === "READ_ONLY" &&
        String(membership?.role || "") !== "VIEWER"
      ) {
        return reject(
          req,
          res,
          403,
          "This workspace is read-only for you. Ask the firm owner to allow member edits.",
        );
      }

      return reject(
        req,
        res,
        403,
        "Your access to this workspace is view-only. A firm administrator can change it.",
      );
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
