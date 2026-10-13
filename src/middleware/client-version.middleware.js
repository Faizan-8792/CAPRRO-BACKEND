// src/middleware/client-version.middleware.js
//
// O11: enforce a minimum supported desktop-client version, additively and
// fail-open. Installed desktops call fixed routes with no auto-update
// (W1/W2's decision to ship an unpackaged .exe), so once a build is in the
// field it persists indefinitely; the first backend contract change makes an
// old client fail in whatever confusing way the mismatch happens to produce.
// This gives the backend a safe way to say "please update" instead.
//
// FAIL-OPEN IS THE RULE THAT MUST NOT BE SOFTENED: every desktop already in
// the field today sends no X-CaPro-Client-Version header at all, so a
// middleware that rejected headerless requests would take the entire
// installed base offline the moment it deployed. Absent or unparseable ->
// always next(), forever -- this is not a temporary bootstrap allowance, it
// is the permanent behaviour for any request this backend cannot identify.
//
// The floor itself is NOT a new AppConfig key. W2/U3 already added
// desktopRelease.minSupportedVersion to the same AppConfig singleton (see
// models/AppConfig.js and appconfig.controller.js's updateDesktopRelease),
// and O11 step 1 requires consuming it rather than adding a second,
// independently-drifting version key. Read RAW here (AppConfig.getInstance(),
// not appconfig.controller.js's publishableDesktopRelease gate) rather than
// through the public/announced view: publishableDesktopRelease returns null
// for the whole desktopRelease block until enabled:true (i.e. until an
// operator calls notify), but the floor is a backend-compatibility control
// that must take effect as soon as it is SAVED (PATCH .../desktop-release),
// independent of whether a release has been announced yet -- an operator
// raising the floor from the admin panel expects it enforced immediately,
// not only after also clicking "notify".
import AppConfig from "../models/AppConfig.js";
import { compareVersions, parseVersion } from "../services/desktop-release.service.js";

// Same allowlist reasoning as maintenance.middleware.js's ALLOW_PREFIXES, but
// deliberately narrower (this task's own Steps name exactly these three): the
// public config route must stay reachable so a stranded client can still
// learn it needs to update; /health so the O7 monitor is never blocked by a
// client-identification rule; and every /api/auth/* route so a user is never
// locked out of signing in before they can even be told why. A version gate
// that blocked the route carrying the update instruction would be a deadlock.
const ALLOW_PREFIXES = ["/api/auth/", "/api/app-config", "/health"];

function isAllowed(path) {
  return ALLOW_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Exported for tests: the pure decision, with no Express/Mongo in it, mirrors
// this codebase's existing pattern of keeping the branchy rule unit-testable
// (compare validateDesktopReleasePatch in desktop-release.service.js).
export function evaluateClientVersion(headerValue, minSupportedVersion) {
  const clientVersion = parseVersion(headerValue);
  // Absent or unparseable ("not-a-version", empty, etc.) -- fail open. Also
  // covers an unset/blank floor (parseVersion("") is null), which is the
  // correct behaviour on a fresh/un-migrated singleton: no floor configured
  // means nothing is ever rejected.
  if (!clientVersion) return { blocked: false };
  const floor = parseVersion(minSupportedVersion);
  if (!floor) return { blocked: false };

  const comparison = compareVersions(headerValue, minSupportedVersion);
  // compareVersions returns null only when a side fails to parse, which is
  // already excluded above, so this is defensive rather than reachable.
  if (comparison === null) return { blocked: false };
  // Strictly below the floor is blocked; equal to the floor is allowed (the
  // floor is inclusive) and above the floor is allowed.
  if (comparison < 0) return { blocked: true };
  return { blocked: false };
}

export async function clientVersionGate(req, res, next) {
  try {
    if (!req.path.startsWith("/api/") && req.path !== "/health") return next();
    if (isAllowed(req.path)) return next();

    const headerValue = req.get("X-CaPro-Client-Version");
    if (!headerValue) return next();

    const cfg = await AppConfig.getInstance();
    const minSupportedVersion = cfg?.desktopRelease?.minSupportedVersion || "";
    if (!minSupportedVersion) return next();

    const { blocked } = evaluateClientVersion(headerValue, minSupportedVersion);
    if (!blocked) return next();

    return res.status(426).json({
      ok: false,
      error:
        "This copy of CA PRO is too old to use with the current server. Download the latest version from caprotoolkit.in.",
      code: "CLIENT_UPDATE_REQUIRED",
      minSupportedVersion,
      requestId: req.id || "",
    });
  } catch {
    // Fail OPEN on any unexpected error (e.g. a DB blip reading AppConfig) --
    // the same rule maintenanceGate follows: never block traffic on an
    // infrastructure hiccup unrelated to the client's own version.
    return next();
  }
}

export default clientVersionGate;
