// src/middleware/request-id.middleware.js
// Attaches a unique request ID to every incoming request for traceability.
// Uses incoming X-Request-Id header if provided, else generates a fresh UUID.

import { randomUUID } from "node:crypto";

export function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && /^[\w-]{8,128}$/.test(incoming)
      ? incoming
      : randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
