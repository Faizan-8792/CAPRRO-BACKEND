// src/controllers/auth-session-events.controller.js
//
// POST /api/auth/session-event (PHASE 8 section D, the client half).
//
// Some authentication facts only the client knows: the user pressed sign
// out, the session was recovered from the persisted copy after a browser
// restart, a refresh had to retry after a network drop. This route accepts
// exactly those three, authenticated, and nothing else:
//
//   - kind is one of signed_out | session_restored | refresh_retry
//   - reason, when present, is matched against a fixed vocabulary - free
//     text from a client never enters the analytics store
//   - no token, cookie, or identifier beyond the authenticated user is read
//
// Best-effort by design: callers fire this and move on. It is also
// authenticated-only: a signed-out client cannot report anything (there is
// nothing to trust), so the extension reports signed_out BEFORE purging its
// local copy.

import { recordAuthHealth } from "../services/auth-health.service.js";

const CLIENT_KINDS = new Set(["signed_out", "session_restored", "refresh_retry"]);
const CLIENT_REASONS = new Set([
  "signed_out",
  "restart",
  "network",
  "server_error",
  "rate_limited",
  "race",
  "unknown",
]);

export const postSessionEvent = async (req, res) => {
  const kind = String(req.body?.kind || "");
  if (!CLIENT_KINDS.has(kind)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported session event.",
      requestId: req.id || "",
    });
  }
  const reasonInput = String(req.body?.reason || "unknown");
  recordAuthHealth({
    kind,
    reason: CLIENT_REASONS.has(reasonInput) ? reasonInput : "unknown",
    platform: req.user?.client === "desktop" ? "desktop" : "extension",
    appVersion: req.clientMeta?.version || "",
    userId: req.user?.id || null,
  });
  return res.json({ ok: true });
};
