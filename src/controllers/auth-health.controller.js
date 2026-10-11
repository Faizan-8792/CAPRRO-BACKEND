// Controller: GET /api/super/auth-health?days=30 (super admin only).
//
// The Authentication & Session Health feed for the admin panel (PHASE 8
// section D). Everything here is aggregate: counts by day, kind, reason and
// platform, plus a bounded session-duration distribution. No user rows, no
// identifiers, no tokens - the underlying collection cannot hold them.

import { authHealthSummary } from "../services/auth-health.service.js";

export const getAuthHealth = async (req, res, next) => {
  try {
    const days = Number(req.query?.days) || 30;
    const summary = await authHealthSummary({ days });
    return res.json({ ok: true, ...summary });
  } catch (err) {
    next(err);
  }
};
