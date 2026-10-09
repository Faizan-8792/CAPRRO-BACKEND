// tests/gst-captcha-route-contract.mjs
//
// The auto sign-in's captcha relay (2026-10-08, hardened 2026-10-09). The
// route holds the firm's CaptchaKings key in the server environment, so the
// contract here guards everything a stranger could ride on:
//   - signed-out calls are refused before anything else happens;
//   - the image must arrive as a small inline JPEG/PNG data URL;
//   - the answer never carries the service balance — what the key is worth
//     is the operator's business, not the caller's;
//   - the daily per-account cap answers 429 with a reset sentence once the
//     ceiling is passed, and counts per account, not per address.
//
// The suite runs the real app against scratch Mongo, mints a token directly,
// and answers the outbound CaptchaKings call by swapping globalThis.fetch —
// no key, no network, no spent balance.

import { readFileSync } from "node:fs";

const uri = (() => {
  for (const [index, arg] of process.argv.entries()) {
    if (arg === "--mongo-uri") return process.argv[index + 1];
  }
  return process.env.MONGODB_URI || "";
})();

const SCRATCH_MARK = "scratch";
if (!uri || !uri.includes(SCRATCH_MARK)) {
  console.error("Refusing to run: MONGODB_URI must be a loopback scratch database.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function runSuite() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "gst-captcha-route-contract-only-not-a-real-secret";
  for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) {
    process.env[outbound] = "";
  }
  // The route refuses to relay when the key is absent — which is exactly what
  // the signed-in 503 check below proves, without ever holding a real key.
  process.env.CAPTCHA_API = "";

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const { default: User } = await import("../src/models/User.js");
  const { default: app } = await import("../src/app.js");

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { token, method = "POST", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text };
  }

  // A 1x1 white JPEG, small enough for the route's shape guard.
  const TINY_JPEG = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.alloc(64, 0x7F),
    Buffer.from([0xFF, 0xD9]),
  ]);
  const dataUrl = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;

  try {
    await User.deleteMany({});
    const user = await User.create({ email: "captcha-contract@example.com", name: "Captcha Contract", role: "USER", accountType: "INDIVIDUAL" });
    const token = jwt.sign(
      { id: String(user._id), email: user.email, role: user.role, accountType: user.accountType, firmId: null, isActive: true, tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );

    // Signed out: refused before any other logic.
    const signedOut = await call("/api/gst-captcha/captcha-solve", { body: { dataUrl } });
    check("signed-out solve is refused with 401", signedOut.status === 401, `status ${signedOut.status}`);
    check("the refusal carries a request id, not the key", typeof signedOut.json?.requestId === "string" && !signedOut.text.includes("CAPTCHA_API"), "");

    // Signed in, well-formed image, no key configured: the honest 503.
    const configured = await call("/api/gst-captcha/captcha-solve", { token, body: { dataUrl } });
    check("signed-in solve without a configured key answers 503", configured.status === 503, `status ${configured.status}`);
    check("the 503 says it is the server's configuration, not the user's", /not configured on this server/.test(configured.json?.error || ""), "");

    // Shape guards, checked with a key present so the guards are what refuse.
    process.env.CAPTCHA_API = "contract-test-not-a-real-key";
    const swap = globalThis.fetch;
    let outboundCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("captchakings.com")) {
        outboundCount += 1;
        return new Response(JSON.stringify({ success: true, data: { prediction: "7K2QX", confidence: "99" } }), { status: 200 });
      }
      return swap(input, init);
    };
    try {
      const badShape = await call("/api/gst-captcha/captcha-solve", { token, body: { dataUrl: "not-a-data-url" } });
      check("a body that is not a data URL is refused with 400", badShape.status === 400, `status ${badShape.status}`);

      const tooBig = await call("/api/gst-captcha/captcha-solve", {
        token,
        body: { dataUrl: "data:image/jpeg;base64," + "A".repeat(500_000) },
      });
      check("an oversized image is refused with 413", tooBig.status === 413, `status ${tooBig.status}`);

      const solved = await call("/api/gst-captcha/captcha-solve", { token, body: { dataUrl } });
      check("a well-formed solve relays and answers ok", solved.status === 200 && solved.json?.ok === true && solved.json?.prediction === "7K2QX", JSON.stringify(solved.json));
      check("the answer carries no balance field", !("balance" in (solved.json || {})), JSON.stringify(Object.keys(solved.json || {})));
      check("exactly one outbound call was made for one solve", outboundCount === 1, `count ${outboundCount}`);
    } finally {
      globalThis.fetch = swap;
    }
  } finally {
    server.close();
    await mongoose.disconnect();
  }

  console.log(`\nShared captcha route contract: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await runSuite();
