// tools/verify-resend-webhook.mjs
//
// Production verification for POST /api/webhooks/resend, run the moment
// RESEND_WEBHOOK_SECRET is configured (the endpoint is fail-closed 503 until
// then — see src/controllers/webhook.controller.js). Everything here is
// derived from the SAME Svix scheme the controller verifies, so a pass means
// the deployed endpoint accepts what Resend will actually send and refuses
// what an attacker would send.
//
// What it proves, against the LIVE endpoint:
//   1. unconfigured → 503; configured → 401 on unsigned input (no longer 503)
//   2. a validly signed event with an unknown email id → 200 {ok,transitioned:false}
//      (synthetic id: no production row is touched)
//   3. replaying the identical signed request → same answer (idempotent, no 500)
//   4. a tampered payload under the original signature → 401
//   5. a stale timestamp (>5 min) with a valid signature → 401
//   6. a signed event of a type outside the four modelled ones → 200 {ignored}
//
//   node tools/verify-resend-webhook.mjs [--base https://api.caprotoolkit.in]
//
// The signing secret is read from RESEND_WEBHOOK_SECRET in .env or the
// environment and is never printed. Exit 0 only if every check passes.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const argBase = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : null;
const BASE = (argBase || "https://api.caprotoolkit.in").replace(/\/$/, "");
const URL_ = `${BASE}/api/webhooks/resend`;

function readSecret() {
  if (process.env.RESEND_WEBHOOK_SECRET) return process.env.RESEND_WEBHOOK_SECRET;
  try {
    const env = readFileSync(join(here, "..", ".env"), "utf8");
    const m = env.match(/^RESEND_WEBHOOK_SECRET=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const SECRET = readSecret();

let pass = 0;
let fail = 0;
const check = (id, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${id}  ${detail}`);
  }
};

// Sign exactly as Resend/Svix does: `v1,<base64(hmac_sha256(base64secret-part, id.ts.payload))>`.
function signedHeaders({ secret, id, timestamp, payload }) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${sig}`,
  };
}

async function post(body, headers) {
  const res = await fetch(URL_, { method: "POST", headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body is a finding, not a crash */
  }
  return { status: res.status, json };
}

console.log(`=== Resend webhook verification against ${URL_} ===`);

// --- 1. configured vs fail-closed ------------------------------------------
const unsigned = await post("{}", { "content-type": "application/json" });
if (SECRET) {
  check(
    "configured: unsigned input is refused 401 (not 503)",
    unsigned.status === 401,
    `got ${unsigned.status} ${JSON.stringify(unsigned.json)}`,
  );
  await checkSignedEvents();
  console.log(`\nwebhook verify: ${pass} passed, ${fail} failed`);
} else {
  check(
    "unconfigured: unsigned input is fail-closed 503",
    unsigned.status === 503,
    `got ${unsigned.status} ${JSON.stringify(unsigned.json)}`,
  );
  console.log("\nRESEND_WEBHOOK_SECRET is not set — the endpoint is fail-closed by design.");
  console.log("Set the Resend dashboard signing secret in .env, redeploy, and re-run this tool.");
}

// Checks 2-6, which need the signing secret. A function rather than a flat run of statements so the
// unconfigured case can stop here without calling process.exit() (see the end of this file).
async function checkSignedEvents() {
  const now = Math.floor(Date.now() / 1000);
  const syntheticId = `evt_test_${randomUUID()}`;
  const sentPayload = JSON.stringify({
    type: "email.sent",
    created_at: new Date().toISOString(),
    data: { email_id: syntheticId, to: ["webhook-verify@example.com"], from: "verify@caprotoolkit.in" },
  });

  // --- 2. valid signature, unknown id → accepted, nothing transitions --------
  const goodHeaders = signedHeaders({ secret: SECRET, id: randomUUID(), timestamp: now, payload: sentPayload });
  const accepted = await post(sentPayload, goodHeaders);
  check(
    "signed event (unknown id) accepted 200, transitioned:false",
    accepted.status === 200 && accepted.json?.ok === true && accepted.json?.transitioned === false,
    `got ${accepted.status} ${JSON.stringify(accepted.json)}`,
  );

  // --- 3. replay → identical, idempotent -------------------------------------
  const replay = await post(sentPayload, goodHeaders);
  check(
    "replayed identical request stays 200 (idempotent)",
    replay.status === 200 && replay.json?.ok === true && replay.json?.transitioned === false,
    `got ${replay.status} ${JSON.stringify(replay.json)}`,
  );

  // --- 4. tampered payload → 401 ----------------------------------------------
  const tamperedPayload = JSON.stringify({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: syntheticId, to: ["webhook-verify@example.com"] },
  });
  const tampered = await post(tamperedPayload, goodHeaders);
  check(
    "tampered payload under the original signature refused 401",
    tampered.status === 401,
    `got ${tampered.status} ${JSON.stringify(tampered.json)}`,
  );

  // --- 5. stale timestamp → 401 ------------------------------------------------
  const staleHeaders = signedHeaders({
    secret: SECRET,
    id: randomUUID(),
    timestamp: now - 6 * 60,
    payload: sentPayload,
  });
  const stale = await post(sentPayload, staleHeaders);
  check(
    "stale timestamp (>5 min) refused 401 despite valid signature",
    stale.status === 401,
    `got ${stale.status} ${JSON.stringify(stale.json)}`,
  );

  // --- 6. out-of-model type → acknowledged, ignored ----------------------------
  const otherPayload = JSON.stringify({
    type: "email.opened",
    created_at: new Date().toISOString(),
    data: { email_id: syntheticId },
  });
  const other = await post(
    otherPayload,
    signedHeaders({ secret: SECRET, id: randomUUID(), timestamp: now, payload: otherPayload }),
  );
  check(
    "out-of-model event type acknowledged as ignored",
    other.status === 200 && other.json?.ok === true && other.json?.ignored === "email.opened",
    `got ${other.status} ${JSON.stringify(other.json)}`,
  );
}

// process.exitCode, not process.exit(): exiting after a fetch aborts Node 24 on Windows (V32).
process.exitCode = fail > 0 ? 1 : 0;
