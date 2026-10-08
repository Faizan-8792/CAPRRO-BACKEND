// tests/audit-llm-failure-wording.mjs
//
// Closes W02 from agenttesting.md §24.1:
//
//   W02  `reason` on /api/audit/* can carry `LLM HTTP 429: <raw upstream body>`
//        verbatim into a user-facing field, bypassing the error handler that
//        exists to stop exactly this (OCR_PROVIDER_ERROR was already
//        generalised for the same reason on the OCR surface; this channel
//        was missed). A chartered accountant reading a status code or a
//        provider name beside a statutory working paper loses confidence in
//        the figures next to it, and the desktop's own AuditAssistPolicy
//        translation layer only covers the transport-failure path, not this
//        200-OK-with-generated:false domain path.
//
// Exercises all four model-backed routes (refine, insights, reminder-message,
// standard-guidance) against a stubbed fetch that returns a real DeepSeek-style
// HTTP failure, a rate limit, and a raw provider error body - the exact shapes
// deepseek-provider.service.js composes into `reason`. Asserts the client-facing
// `reason` field never carries a status code, "LLM", "DEEPSEEK", "HTTP", or the
// raw upstream text, while still answering usefully.

process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "test-key-not-used";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// One shared banned-substring assertion, since every route must satisfy the
// same contract: no status code, no provider name, no raw upstream text.
const FORBIDDEN = [
  "HTTP",
  "401",
  "403",
  "429",
  "500",
  "502",
  "503",
  "504",
  "LLM ",
  "DEEPSEEK",
  "deepseek",
  "rate limit reached",
  "invalid api key",
];

function assertClean(routeName, reason) {
  const text = String(reason ?? "");
  check(
    `${routeName}: a reason was actually returned`,
    text.length > 0,
    text,
  );
  for (const banned of FORBIDDEN) {
    check(
      `${routeName}: reason does not contain "${banned}"`,
      !text.includes(banned),
      text,
    );
  }
}

// ─── Stub callDeepSeek's only external dependency: fetch ────────────
//
// Same convention as audit-insights-grounding.mjs: stub at the transport
// boundary so the real retry/fallback/status-mapping logic in
// deepseek-provider.service.js actually runs, rather than mocking around it.

let nextFetchResponse = null;

globalThis.fetch = async () => {
  const response = nextFetchResponse;
  if (!response) {
    throw new Error(
      "test forgot to set nextFetchResponse before calling the controller",
    );
  }
  return response;
};

function rateLimitedResponse() {
  return {
    ok: false,
    status: 429,
    text: async () =>
      '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_error"}}',
  };
}

function unauthorizedResponse() {
  return {
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"Invalid API key provided"}}',
  };
}

const {
  refineAuditClassification,
  generateInsights,
  generateReminderMessage,
  generateStandardGuidance,
} = await import("../src/controllers/audit.controller.js");

// O10 added a per-user/monthly/global spend quota at the callDeepSeek choke
// point (ProviderUsage.reserveProviderCall), backed by a real MongoDB
// collection there is no live connection to here. This suite tests failure
// WORDING, not quota, so the increment is stubbed to always succeed -- see
// tests/provider-quota-contract.mjs for the quota logic itself.
const { default: ProviderUsage } = await import("../src/models/ProviderUsage.js");
ProviderUsage.findOneAndUpdate = async (_filter, update) => ({ calls: update?.$inc?.calls ?? 1 });
ProviderUsage.updateOne = async () => ({ matchedCount: 1 });

function fakeReqRes(body) {
  const state = { status: 200, body: null };
  // O10 made userId a required param on callDeepSeek (metered per user), and
  // this controller now reads it from req.user.id -- a fake req needs one too.
  const req = { body, user: { id: "6512ab00ab00ab00ab00ab99" } };
  const res = {
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.body = payload;
      return res;
    },
  };
  return { req, res, state };
}

async function call(handler, body) {
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await handler(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

// ─── refine: a 429 must not leak into the classifier's reason ───

{
  nextFetchResponse = rateLimitedResponse();
  const result = await call(refineAuditClassification, {
    rawText: "Revenue recognised on dispatch, per company policy note 4.",
  });

  check("refine: still answers 200", result.status === 200);
  check("refine: refined is false", result.body?.refined === false);
  assertClean("refine (429)", result.body?.reason);
}

// ─── refine: a 401 (bad key) must not leak the provider's own message ───

{
  nextFetchResponse = unauthorizedResponse();
  const result = await call(refineAuditClassification, {
    rawText: "Revenue recognised on dispatch, per company policy note 4.",
  });

  assertClean("refine (401)", result.body?.reason);
}

// ─── insights: a 429 must not leak into the generated:false reason ───

{
  nextFetchResponse = rateLimitedResponse();
  const result = await call(generateInsights, {
    rawText:
      "The company recognised revenue of Rs 42 lakh on goods dispatched before year-end.",
  });

  check("insights: still answers 200", result.status === 200);
  check("insights: generated is false", result.body?.generated === false);
  check(
    "insights: insights array is empty, not the mandatory block, on a hard failure",
    Array.isArray(result.body?.insights) && result.body.insights.length === 0,
  );
  assertClean("insights (429)", result.body?.reason);
}

// ─── reminder-message: a 429 must not leak, and a usable fallback still ships ───

{
  nextFetchResponse = rateLimitedResponse();
  const result = await call(generateReminderMessage, {
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    daysPending: 5,
  });

  check("reminder-message: still answers 200", result.status === 200);
  check(
    "reminder-message: generated is false",
    result.body?.generated === false,
  );
  check(
    "reminder-message: a usable template message still ships despite the LLM failure",
    typeof result.body?.message === "string" && result.body.message.length > 0,
    result.body?.message,
  );
  assertClean("reminder-message (429)", result.body?.reason);
}

// ─── standard-guidance: a 429 must not leak ───

{
  nextFetchResponse = rateLimitedResponse();
  const result = await call(generateStandardGuidance, { code: "SA 240" });

  check("standard-guidance: still answers 200", result.status === 200);
  check(
    "standard-guidance: generated is false",
    result.body?.generated === false,
  );
  assertClean("standard-guidance (429)", result.body?.reason);
}

// ─── the wording is actually recognised, not just scrubbed to a blank ───

{
  nextFetchResponse = rateLimitedResponse();
  const result = await call(generateInsights, {
    rawText: "Some audit-relevant text about revenue recognition timing.",
  });

  check(
    "a rate limit is worded as a rate limit, not the generic fallback",
    /too many requests|handling too many/i.test(result.body?.reason || ""),
    result.body?.reason,
  );
}

// ─── report ───

const failed = checks.filter((c) => !c.pass);
for (const c of checks) {
  console.log(
    `[${c.pass ? "PASS" : "FAIL"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
  );
}
console.log(`\nAudit LLM failure wording: ${checks.length - failed.length}/${checks.length}`);
if (failed.length > 0) {
  process.exit(1);
}
