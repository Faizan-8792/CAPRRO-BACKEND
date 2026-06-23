// src/middleware/sanitize.middleware.js
// Basic input sanitization to prevent XSS and injection attacks

/**
 * Recursively sanitize string values in an object:
 * - Trim whitespace
 * - Strip HTML tags
 * - Remove null bytes
 */
function sanitizeValue(value) {
  if (typeof value === "string") {
    return value
      .trim()
      .replace(/\0/g, "")          // Remove null bytes
      .replace(/<[^>]*>/g, "")     // Strip HTML tags
      .replace(/javascript:/gi, "") // Remove javascript: URIs
      .replace(/on\w+\s*=/gi, ""); // Remove inline event handlers
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return sanitizeObject(value);
  }
  return value;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const cleaned = {};
  for (const [key, val] of Object.entries(obj)) {
    // Skip keys with suspicious patterns
    if (key.startsWith("$") || key.includes("..")) continue;
    cleaned[key] = sanitizeValue(val);
  }
  return cleaned;
}

/**
 * Express middleware: sanitizes req.body, req.query, and req.params
 */
export function sanitizeInputs(req, res, next) {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === "object") {
    req.query = sanitizeObject(req.query);
  }
  if (req.params && typeof req.params === "object") {
    req.params = sanitizeObject(req.params);
  }
  next();
}

/**
 * Validate MongoDB ObjectId format
 */
export function isValidObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Middleware to validate :id params as valid ObjectIds
 */
export function validateIdParam(paramName = "id") {
  return (req, res, next) => {
    const id = req.params[paramName];
    if (id && !isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: `Invalid ${paramName} format` });
    }
    next();
  };
}
