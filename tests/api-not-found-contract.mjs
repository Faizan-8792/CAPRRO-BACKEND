// tests/api-not-found-contract.mjs
//
// Ledger task O22. A signed-in request to an /api path that no route matches passed the
// authenticated catch-all and fell through to Express's default HTML 404 ("Cannot GET /api/..."),
// while every other API error is the JSON envelope {ok:false, error, category, requestId}. This
// boots the REAL app in production mode against a scratch database, signs a real session token
// for a seeded user, and pins:
//   - an unknown /api path, GET and POST, signed in -> 404 JSON with code NOT_FOUND and a
//     requestId, and the body never echoes the path;
//   - the same path signed out -> still the catch-all's 401 (the control-path check after a
//     deploy depends on it);
//   - a known route is unaffected.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-... node tests/api-not-found-contract.mjs

const uri = process.env.MONGODB_URI || "";
// The suite runs inside runSuite(), which RETURNS the exit code, and the guard sets process.exitCode
// and lets Node finish. process.exit() after a fetch aborts Node 24 on Windows (V32).
if (!/\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri) || !uri.includes("scratch")) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exitCode = 1;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "api-not-found-contract-only-not-a-real-secret";
  for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) {
    process.env[outbound] = "";
  }

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const { default: User } = await import("../src/models/User.js");
  const { default: app } = await import("../src/app.js");

  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass, detail });
  const MISSING = "/api/definitely-not-a-real-route-o22";

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { token, method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, type: response.headers.get("content-type") || "", json, text };
  }

  try {
    await User.deleteMany({});
    const user = await User.create({ email: "o22@example.com", name: "O22 Contract", role: "USER", accountType: "INDIVIDUAL" });
    const token = jwt.sign(
      { id: String(user._id), email: user.email, role: user.role, accountType: user.accountType, firmId: null, isActive: true, tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );

    for (const method of ["GET", "POST"]) {
      const missing = await call(MISSING, { token, method, body: method === "POST" ? { any: 1 } : undefined });
      check(`${method} of an unknown /api path, signed in, answers 404`, missing.status === 404, `status ${missing.status}`);
      check(`${method}: the answer is the JSON envelope, not an HTML page`, /application\/json/.test(missing.type) && missing.json !== null && !/<html|<pre>/i.test(missing.text), missing.type);
      check(
        `${method}: ok false, category and code NOT_FOUND, a request id`,
        missing.json?.ok === false && missing.json?.category === "NOT_FOUND" && missing.json?.code === "NOT_FOUND" && typeof missing.json?.requestId === "string" && missing.json.requestId.length > 0,
        JSON.stringify(missing.json),
      );
      check(`${method}: the body never echoes the path`, !missing.text.includes("definitely-not-a-real-route-o22"), "");
    }

    // Under a mounted router whose only guard is sign-in, an unmatched sub-path falls through to the
    // same answer. (A router with its own role guard, like /api/tasks, answers that guard first -
    // which is its business, not this one's.)
    const nested = await call("/api/gst-portal-map/1/definitely-not-a-real-route-o22", { token });
    check("an unknown path under a mounted router is the same JSON 404", nested.status === 404 && nested.json?.code === "NOT_FOUND", `status ${nested.status}`);

    const signedOut = await call(MISSING);
    check(
      "signed out, the same path is still the catch-all's 401",
      signedOut.status === 401 && signedOut.json?.error === "Missing or invalid Authorization header",
      `status ${signedOut.status} ${signedOut.json?.error || ""}`,
    );

    const me = await call("/api/auth/me", { token });
    check("a known route is unaffected", me.status === 200 && me.json?.ok === true && me.json?.user?.email === "o22@example.com", `status ${me.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { await mongoose.connection.dropDatabase(); } catch { /* scratch only */ }
    await mongoose.disconnect();
  }

  let passed = 0;
  for (const entry of checks) {
    if (entry.pass) passed += 1;
    console.log(`[${entry.pass ? "PASS" : "FAIL"}] ${entry.name}${entry.detail ? ` - ${entry.detail}` : ""}`);
  }
  console.log(`api-not-found-contract: ${passed}/${checks.length} checks passed`);
  return passed === checks.length ? 0 : 1;
}
