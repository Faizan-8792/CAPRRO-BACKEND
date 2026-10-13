// Google identity checks for sign-in, with failures that say what actually went wrong.
//
// DS44 (2026-10-14, the owner: "check there is multiple login fails to sara fix karo"). Before this,
// every failed Google sign-in was recorded as one reason, "invalid", from an "unknown" app: a token
// Google had expired, a token for another app, Google's keys rotating, the server failing to reach
// Google, and a forged token all looked the same on the admin panel's Sign-in health page, so none of
// them could be told apart, let alone fixed. Two of them were also not the user's fault and failed
// for no good reason:
//   - a moment when the server could not reach Google (fetching Google's signing keys failed or timed
//     out) refused the sign-in as "Invalid Google token" (401);
//   - Google rotating its signing keys left a cached key set without the new key ("No pem found"),
//     refusing a genuine token until the cache expired.
// Both are now retried once (with fresh keys for the second); if Google stays unreachable the answer
// is 502 "Google could not be reached. Try again." - the answer the desktop's code exchange already
// gives for the same trouble, which both apps show as try-again, not as a bad account.
//
// google-auth-library puts the whole token, or its decoded payload, into some error messages. Nothing
// here logs or stores a message, a token, an email or an address; messages are only matched by their
// fixed opening words, so a name inside a payload can never change the verdict.

import { OAuth2Client } from "google-auth-library";

// Errors raised before or while a request travelled to Google: nothing about the token is known.
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  // gaxios names a timed-out or aborted request by its DOMException's name.
  "TimeoutError",
  "AbortError",
]);

// Errors raised before a connection was made, so the request certainly never reached Google. Only
// these make a second try of a one-time sign-in code safe: Google may already have used up a code
// whose request failed later.
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// google-auth-library's own refusals of a token, by their opening words (oauth2client.js,
// verifySignedJwtWithCertsAsync). The signature is checked before the times and the audience.
const MALFORMED_OR_FORGED = /^(Wrong number of segments|Can't parse token|Invalid token signature|No issue time|No expiration time|iat field|exp field|Expiration time too far|Invalid issuer)/;

// The first error code along the chain of causes: gaxios wraps undici's TypeError("fetch failed"),
// which wraps the socket error that carries the code.
function codeOf(err) {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = e.cause || e.error, depth += 1) {
    if (typeof e.code === "string" && e.code) return e.code;
    if (e.name === "TimeoutError" || e.name === "AbortError") return e.name;
  }
  return "";
}

function statusOf(err) {
  return Number(err?.response?.status || err?.status || 0);
}

/** True when a failed request to Google never left this server, so trying again is safe. */
export function isConnectError(err) {
  return CONNECT_CODES.has(codeOf(err));
}

/**
 * What a failed Google check means: an auth-health reason, the HTTP answer, and whether a second
 * try can help. reason is one of AuthHealthEvent's reasons.
 */
export function classifyGoogleError(err) {
  const message = String(err?.message || "");
  const status = statusOf(err);
  if (NETWORK_CODES.has(codeOf(err)) || status >= 500) {
    return unreachable();
  }
  if (/^No pem found for envelope/.test(message)) {
    // Google rotated its keys after this server cached them: fresh keys, then once more.
    return { reason: "invalid", status: 401, retry: true, freshKeys: true, error: "Invalid Google token" };
  }
  if (/^Token used too late/.test(message)) {
    return { reason: "google_expired", status: 401, retry: false, error: "Invalid Google token" };
  }
  if (/^Token used too early/.test(message)) {
    // Google dated the token after this server's clock: the server's clock is behind.
    return { reason: "clock", status: 401, retry: false, error: "Invalid Google token" };
  }
  if (/^Wrong recipient/.test(message)) {
    return { reason: "audience", status: 401, retry: false, error: "Google token audience mismatch" };
  }
  if (MALFORMED_OR_FORGED.test(message)) {
    return { reason: "invalid", status: 401, retry: false, error: "Invalid Google token" };
  }
  if (status === 400 || status === 401) {
    // Google's tokeninfo answers 400 for an access token that is expired, revoked or not a token.
    return { reason: "google_expired", status: 401, retry: false, error: "Invalid Google token" };
  }
  if (/^(fetch failed|request to \S+ failed|socket hang up)/i.test(message)) {
    return unreachable();
  }
  return { reason: "invalid", status: 401, retry: false, error: "Invalid Google token" };
}

function unreachable() {
  return {
    reason: "google_unreachable",
    status: 502,
    code: "GOOGLE_UNREACHABLE",
    retry: true,
    error: "Google could not be reached. Try again.",
  };
}

/**
 * The app a Google ID token was issued to, read from its audience: "desktop" for the desktop app's
 * client, "extension" for any other client this server accepts, "unknown" for anything else. The
 * token is NOT verified here - this only labels the Sign-in health record - so nothing about who is
 * signing in is ever taken from it.
 */
export function platformFromGoogleToken(idToken, { desktopClientId = "", clientIds = [] } = {}) {
  try {
    const part = String(idToken || "").split(".")[1];
    if (!part) return "unknown";
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const aud = String(payload?.aud || "");
    if (!aud) return "unknown";
    if (aud === desktopClientId) return "desktop";
    return clientIds.includes(aud) ? "extension" : "unknown";
  } catch {
    return "unknown";
  }
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A verifier that tries once more after a passing trouble. makeClient builds a fresh OAuth2Client,
 * and with it a fresh key cache. Returns the token's payload, or throws the last error.
 */
export function createGoogleVerifier({ makeClient = () => new OAuth2Client(), wait = pause, retryDelayMs = 400 } = {}) {
  let client = makeClient();
  async function attempt(fn) {
    try {
      return await fn(client);
    } catch (err) {
      const verdict = classifyGoogleError(err);
      if (!verdict.retry) throw err;
      if (verdict.freshKeys) client = makeClient();
      else await wait(retryDelayMs);
      return fn(client);
    }
  }
  return {
    verifyIdToken: (idToken, audience) =>
      attempt(async (c) => (await c.verifyIdToken({ idToken, audience })).getPayload()),
    getTokenInfo: (accessToken) => attempt((c) => c.getTokenInfo(accessToken)),
  };
}
