// tools/check-admin-token.mjs
//
// Reports the expiry state of the CAPRO_SUPER_ADMIN_JWT stored in capro-backend/.env,
// without ever printing the token itself.
//
//   node tools/check-admin-token.mjs             # human-readable status, always exit 0
//   node tools/check-admin-token.mjs --strict    # exit 1 when missing, expired, or < 7 days left
//
// WHY THIS EXISTS
// ---------------
// The super-admin panel has no sign-in form: it reads its bearer token from localStorage, and the
// token in .env is placed there by tools/mint-admin-token.mjs, which needs an OTP from the owner's
// mailbox. The stored token quietly expired on 2026-09-15 and the owner stayed locked out of the
// panel for almost two weeks before anyone noticed (IMPROVEMENT-PLAN-V2-2026-09-28 Part 5 Phase 0
// item 1). This script is the reminder: run it before panel-dependent work, or with --strict as a
// precondition check anywhere tokens matter.
//
// Re-minting is owner work (the OTP). When this reports EXPIRED, the ask is:
//   node tools/mint-admin-token.mjs   # OTP arrives in the super-admin mailbox
import "dotenv/config";

const raw = process.env.CAPRO_SUPER_ADMIN_JWT;
const strict = process.argv.includes("--strict");

if (!raw) {
  console.log("ADMIN TOKEN: MISSING — no CAPRO_SUPER_ADMIN_JWT in capro-backend/.env");
  console.log("Fix (owner): node tools/mint-admin-token.mjs");
  process.exit(strict ? 1 : 0);
}

const parts = raw.split(".");
let verdict = "UNREADABLE";
let detail = "the stored value is not a three-part JWT";
let daysLeft = null;

if (parts.length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.exp) {
      const exp = new Date(payload.exp * 1000);
      const msLeft = exp.getTime() - Date.now();
      daysLeft = msLeft / 86_400_000;
      if (msLeft <= 0) {
        verdict = "EXPIRED";
        detail = `expired ${exp.toISOString()} (${Math.abs(daysLeft).toFixed(1)} days ago)`;
      } else {
        verdict = daysLeft < 7 ? "EXPIRING" : "OK";
        detail = `expires ${exp.toISOString()} (${daysLeft.toFixed(1)} days left)`;
      }
    } else {
      verdict = "NO_EXP";
      detail = "the token payload carries no exp claim";
    }
  } catch {
    // verdict stays UNREADABLE
  }
}

console.log(`ADMIN TOKEN: ${verdict} — ${detail}`);
if (verdict === "EXPIRED" || verdict === "EXPIRING" || verdict === "MISSING" || verdict === "UNREADABLE" || verdict === "NO_EXP") {
  console.log("Fix (owner): node tools/mint-admin-token.mjs  # needs the OTP from the super-admin mailbox");
}
process.exit(strict && verdict !== "OK" ? 1 : 0);
