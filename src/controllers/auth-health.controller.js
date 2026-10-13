// Controller: GET /api/super/auth-health?days=30 (super admin only).
//
// The Authentication & Session Health feed for the admin panel (PHASE 8
// section D). Everything here is aggregate: counts by day, kind, reason and
// platform, plus a bounded session-duration distribution. No user rows, no
// identifiers, no tokens - the underlying collection cannot hold them.
//
// DS43: events of the owner's own accounts are left out unless the panel asks
// for them (?includeOwn=1); `ownAccounts` names the owner's addresses so the
// panel can say what was left out. An event with no account (a sign-in that
// failed before anyone was identified) cannot be told apart and is always counted.

import { authHealthSummary } from "../services/auth-health.service.js";
import { reportScope } from "../services/owner-accounts.service.js";

export const getAuthHealth = async (req, res, next) => {
  try {
    const days = Number(req.query?.days) || 30;
    const scope = await reportScope(req);
    const summary = await authHealthSummary({ days, excludeUserIds: scope.userIds });
    return res.json({ ok: true, ...summary, ownAccounts: scope.note });
  } catch (err) {
    next(err);
  }
};
