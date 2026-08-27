// tests/provider-quota-contract.mjs
//
// O10: DeepSeek and OCR.space are billed per call and reached from the backend
// on behalf of any signed-in user, with no per-account spend control anywhere
// in the codebase. This proves the fix: a per-user daily/monthly cap plus a
// provider-wide daily ceiling, enforced atomically at the two paid-provider
// choke points (callDeepSeek in deepseek-provider.service.js,
// extractTextWithOcrSpace in ocr-space.service.js) via
// ProviderUsage.reserveProviderCall.
//
// No live MongoDB and no real paid-provider call. Same convention as
// audit-llm-failure-wording.mjs (stub fetch at the transport boundary so the
// real service/controller logic runs) and case-ocr-route-behaviour.mjs (stub
// the model layer, not the business logic). Here the model layer being stubbed
// is ProviderUsage.findOneAndUpdate / .updateOne, replaced with a tiny
// in-memory store that reproduces real MongoDB unique-index/upsert semantics
// (including a real E11000 on an upsert that collides with an existing
// at-cap row) closely enough to exercise the REAL, unmodified
// ProviderUsage.tryIncrement / releaseReservation / reserveProviderCall.
//
// Caps are set small via env (2/day, 3/month, 5/day-global for both
// providers) so a handful of calls can reach every tier without waiting for a
// real day or month boundary.

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "test-key-not-used";
process.env.OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || "test-key-not-used";
process.env.DEEPSEEK_DAILY_CALL_CAP_PER_USER = "2";
process.env.DEEPSEEK_MONTHLY_CALL_CAP_PER_USER = "3";
process.env.DEEPSEEK_GLOBAL_DAILY_CALL_CAP = "5";
process.env.OCR_SPACE_DAILY_CALL_CAP_PER_USER = "2";
process.env.OCR_SPACE_MONTHLY_CALL_CAP_PER_USER = "3";
process.env.OCR_SPACE_GLOBAL_DAILY_CALL_CAP = "5";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Stub fetch at the transport boundary, like audit-llm-failure-wording.mjs
// and audit-insights-grounding.mjs. Tracks call counts so "the refused call
// never reached the provider" is a real assertion, not an assumption. ─────
let fetchCallCount = 0;
globalThis.fetch = async () => {
  fetchCallCount += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      // Shape both callers actually read: DeepSeek's choices[0].message.content,
      // OCR.space's ParsedResults[].ParsedText.
      choices: [{ message: { content: '{"ok":true}' } }],
      IsErroredOnProcessing: false,
      ParsedResults: [{ ParsedText: "synthetic OCR text" }],
    }),
    text: async () => "",
  };
};

const { default: ProviderUsage, GLOBAL_USAGE_USER_ID, dailyPeriodKey, monthlyPeriodKey } =
  await import("../src/models/ProviderUsage.js");
const { callDeepSeek } = await import("../src/services/deepseek-provider.service.js");
const { extractTextWithOcrSpace } = await import("../src/services/ocr-space.service.js");
const { refineAuditClassification } = await import("../src/controllers/audit.controller.js");
const { previewCaseOcr } = await import("../src/controllers/case.controller.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");

// Captured BEFORE Part A installs any fake store below, so PART E (live
// MongoDB concurrency proof) can restore the REAL, unmodified statics even
// though every other part in this file monkey-patches them permanently for
// the rest of the process.
const REAL_PROVIDER_USAGE_STATICS = {
  find: ProviderUsage.find.bind(ProviderUsage),
  findOne: ProviderUsage.findOne.bind(ProviderUsage),
  findOneAndUpdate: ProviderUsage.findOneAndUpdate.bind(ProviderUsage),
  updateOne: ProviderUsage.updateOne.bind(ProviderUsage),
  deleteMany: ProviderUsage.deleteMany.bind(ProviderUsage),
};

// previewCaseOcr's first line (assertNoticeRequestCurrent) checks the
// noticeCases feature-flag version via a real AppConfig.findById query --
// unrelated to provider quota, but a real Mongoose call this test must stub
// to even reach the quota gate. Stubbed at the same low level (findById /
// getInstance) as case-ocr-route-behaviour.mjs, for the same reason: the real
// version/fence comparison logic in AppConfig.assertFeatureFlagVersion still
// runs, only the document read is faked.
function appConfigChain(value) {
  return { select: () => appConfigChain(value), lean: async () => value };
}
const NOTICE_CASES_APP_CONFIG_DOC = {
  featureFlags: { noticeCases: true },
  featureFlagVersions: { noticeCases: 0 },
  featureFlagPublicationFences: { noticeCases: "" },
};
AppConfig.getInstance = async () => NOTICE_CASES_APP_CONFIG_DOC;
AppConfig.findById = () => appConfigChain(NOTICE_CASES_APP_CONFIG_DOC);

// ─── Fake ProviderUsage persistence: reproduces real MongoDB semantics for
// exactly the two operations reserveProviderCall issues, so the REAL,
// unmodified model statics run against it. ───────────────────────────────
function usageKey(userId, provider, periodKey) {
  return `${String(userId)}|${provider}|${periodKey}`;
}

function installFakeProviderUsageStore() {
  const rows = new Map(); // key -> { calls }
  const findOneAndUpdateCalls = [];
  const readCalls = []; // any read-style method invoked before a write, if ever

  ProviderUsage.find = () => {
    readCalls.push("find");
    throw new Error("test: find() should never be called by the quota path");
  };
  ProviderUsage.findOne = () => {
    readCalls.push("findOne");
    throw new Error("test: findOne() should never be called by the quota path");
  };

  ProviderUsage.findOneAndUpdate = async (filter, update, options) => {
    findOneAndUpdateCalls.push({ filter, update, options });
    const key = usageKey(filter.userId, filter.provider, filter.periodKey);
    const cap = filter.calls?.$lt;
    const incBy = update?.$inc?.calls ?? 0;
    const existing = rows.get(key);

    if (existing && existing.calls < cap) {
      existing.calls += incBy;
      return { ...existing };
    }
    if (existing) {
      // Filter (calls < cap) does not match the existing row, so Mongo would
      // attempt the upsert's implicit insert -- which collides with the real
      // unique index on {userId, provider, periodKey} exactly like it would
      // in MongoDB, and throws E11000 without ever touching that row.
      const error = new Error("E11000 duplicate key error collection");
      error.code = 11000;
      throw error;
    }
    if (options?.upsert) {
      const created = { calls: incBy };
      rows.set(key, created);
      return { ...created };
    }
    return null;
  };

  ProviderUsage.updateOne = async (filter, update) => {
    const key = usageKey(filter.userId, filter.provider, filter.periodKey);
    const existing = rows.get(key);
    const gt = filter.calls?.$gt;
    if (!existing) return { matchedCount: 0, modifiedCount: 0 };
    if (gt !== undefined && !(existing.calls > gt)) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    existing.calls += update?.$inc?.calls ?? 0;
    return { matchedCount: 1, modifiedCount: 1 };
  };

  return {
    peek: (userId, provider, periodKey) => rows.get(usageKey(userId, provider, periodKey))?.calls ?? 0,
    findOneAndUpdateCalls,
    readCalls,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PART A — ProviderUsage model: atomic reservation + rollback, in isolation
// ═══════════════════════════════════════════════════════════════════════

// A1/A2 — tryIncrement itself: allowed under cap, denied at cap.
{
  const store = installFakeProviderUsageStore();
  const userId = "a1a1a1a1a1a1a1a1a1a1a1a1";
  const first = await ProviderUsage.tryIncrement({
    userId, provider: "DEEPSEEK", periodKey: "2026-08-21", cap: 2,
  });
  check("A1: first call under cap is allowed", first.allowed === true && first.calls === 1);

  const second = await ProviderUsage.tryIncrement({
    userId, provider: "DEEPSEEK", periodKey: "2026-08-21", cap: 2,
  });
  check("A1: second call reaches but does not exceed the cap", second.allowed === true && second.calls === 2);

  const third = await ProviderUsage.tryIncrement({
    userId, provider: "DEEPSEEK", periodKey: "2026-08-21", cap: 2,
  });
  check("A2: third call at cap is denied", third.allowed === false);
  check(
    "A2: a denied call never touched the stored count",
    store.peek(userId, "DEEPSEEK", "2026-08-21") === 2,
  );
}

// A3 — a monthly-tier refusal rolls back the daily increment that already happened.
{
  const store = installFakeProviderUsageStore();
  const userId = "a3a3a3a3a3a3a3a3a3a3a3a3";
  const now = new Date("2026-08-21T10:00:00.000Z");
  const dayKey = dailyPeriodKey(now);
  const monthKey = monthlyPeriodKey(now);

  // Saturate the monthly counter directly (as if 3 earlier calls this month
  // already used it up), independent of today's daily row.
  for (let i = 0; i < 3; i++) {
    await ProviderUsage.tryIncrement({ userId, provider: "DEEPSEEK", periodKey: monthKey, cap: 3 });
  }

  const reservation = await ProviderUsage.reserveProviderCall({
    userId, provider: "DEEPSEEK",
    dailyCapPerUser: 5, monthlyCapPerUser: 3, globalDailyCap: 50,
    now,
  });

  check("A3: refused, and the reason names the monthly tier", reservation.allowed === false && /monthly/i.test(reservation.reason));
  check(
    "A3: the daily row was rolled back to 0, not left incremented for a call that never happened",
    store.peek(userId, "DEEPSEEK", dayKey) === 0,
  );
  check(
    "A3: the monthly row stayed exactly at its cap, not pushed over by the refused attempt",
    store.peek(userId, "DEEPSEEK", monthKey) === 3,
  );
}

// A4 — a global-ceiling refusal rolls back BOTH the daily and monthly
// increments for this user's own (otherwise-under-cap) reservation.
{
  const store = installFakeProviderUsageStore();
  const userId = "a4a4a4a4a4a4a4a4a4a4a4a4";
  const now = new Date("2026-08-21T10:00:00.000Z");
  const dayKey = dailyPeriodKey(now);
  const monthKey = monthlyPeriodKey(now);

  // Saturate the provider-wide sentinel row for today, as if other users
  // already used up the whole day's global budget.
  for (let i = 0; i < 2; i++) {
    await ProviderUsage.tryIncrement({
      userId: GLOBAL_USAGE_USER_ID, provider: "DEEPSEEK", periodKey: dayKey, cap: 2,
    });
  }

  const reservation = await ProviderUsage.reserveProviderCall({
    userId, provider: "DEEPSEEK",
    dailyCapPerUser: 10, monthlyCapPerUser: 10, globalDailyCap: 2,
    now,
  });

  check(
    "A4: a user comfortably under their OWN per-user caps is still refused once the global ceiling is hit",
    reservation.allowed === false && /provider-wide|volume limit/i.test(reservation.reason),
  );
  check("A4: this user's daily row was rolled back to 0", store.peek(userId, "DEEPSEEK", dayKey) === 0);
  check("A4: this user's monthly row was rolled back to 0", store.peek(userId, "DEEPSEEK", monthKey) === 0);
}

// A5 — a new period restores capacity for a user who was at the previous period's cap.
{
  const store = installFakeProviderUsageStore();
  const userId = "a5a5a5a5a5a5a5a5a5a5a5a5";
  const day1 = new Date("2026-08-21T10:00:00.000Z");
  const day2 = new Date("2026-08-22T10:00:00.000Z");

  const first = await ProviderUsage.reserveProviderCall({
    userId, provider: "OCR_SPACE",
    dailyCapPerUser: 1, monthlyCapPerUser: 10, globalDailyCap: 10,
    now: day1,
  });
  const secondSameDay = await ProviderUsage.reserveProviderCall({
    userId, provider: "OCR_SPACE",
    dailyCapPerUser: 1, monthlyCapPerUser: 10, globalDailyCap: 10,
    now: day1,
  });
  const nextDay = await ProviderUsage.reserveProviderCall({
    userId, provider: "OCR_SPACE",
    dailyCapPerUser: 1, monthlyCapPerUser: 10, globalDailyCap: 10,
    now: day2,
  });

  check("A5: first call on day 1 is allowed", first.allowed === true);
  check("A5: a second call on the SAME day 1 is refused (daily cap 1)", secondSameDay.allowed === false);
  check(
    "A5: the very next day, the same user can call again -- the daily cap reset with the new period",
    nextDay.allowed === true,
  );
}

// A6 — concurrency proof (unit-level, since no live MongoDB is available here
// to fire real concurrent requests against -- see honestGaps): the increment
// is issued as ONE findOneAndUpdate call carrying upsert + $inc + a calls:{$lt}
// guard in its filter, never a separate read followed by a write.
{
  const store = installFakeProviderUsageStore();
  const userId = "a6a6a6a6a6a6a6a6a6a6a6a6";
  await ProviderUsage.tryIncrement({ userId, provider: "DEEPSEEK", periodKey: "2026-08-21", cap: 5 });

  check("A6: exactly one findOneAndUpdate call was issued for one reservation", store.findOneAndUpdateCalls.length === 1);
  check("A6: no separate read (find/findOne) preceded the write", store.readCalls.length === 0);
  const [{ filter, update, options }] = store.findOneAndUpdateCalls;
  check("A6: the write is a single atomic upsert", options?.upsert === true);
  check("A6: the write increments by exactly 1", update?.$inc?.calls === 1);
  check(
    "A6: the guard against exceeding the cap lives IN the same atomic filter (calls:{$lt:cap}), not a prior read",
    filter?.calls && filter.calls.$lt === 5,
  );
}

// A7 — two different users interleaved against the SAME store never share a
// counter: reaching one user's cap must not affect the other's, and each
// user's own count must reflect only their own calls, not the pair's total.
{
  const store = installFakeProviderUsageStore();
  const userA = "a7a7a7a7a7a7a7a7a7a7a7a1";
  const userB = "a7a7a7a7a7a7a7a7a7a7a7b2";
  const periodKey = "2026-08-27";

  await ProviderUsage.tryIncrement({ userId: userA, provider: "DEEPSEEK", periodKey, cap: 2 });
  await ProviderUsage.tryIncrement({ userId: userA, provider: "DEEPSEEK", periodKey, cap: 2 });
  const userAThird = await ProviderUsage.tryIncrement({
    userId: userA, provider: "DEEPSEEK", periodKey, cap: 2,
  });
  check("A7: user A is refused once THEIR OWN count reaches the cap", userAThird.allowed === false);

  const userBFirst = await ProviderUsage.tryIncrement({
    userId: userB, provider: "DEEPSEEK", periodKey, cap: 2,
  });
  check(
    "A7: user B, never having called before, is unaffected by user A already being at cap",
    userBFirst.allowed === true && userBFirst.calls === 1,
  );
  check("A7: user A's stored count is exactly their own 2 calls, not a shared total", store.peek(userA, "DEEPSEEK", periodKey) === 2);
  check("A7: user B's stored count is exactly their own 1 call, not a shared total", store.peek(userB, "DEEPSEEK", periodKey) === 1);
}

// ═══════════════════════════════════════════════════════════════════════
// PART B — callDeepSeek's own quota gate (the real choke point)
// ═══════════════════════════════════════════════════════════════════════

// B1/B2 — a user already at their daily cap gets a quota-shaped refusal;
// the refused call never reaches the provider and never increments further.
{
  installFakeProviderUsageStore();
  const userId = "b1b1b1b1b1b1b1b1b1b1b1b1";
  const callArgs = { system: "s", prompt: "p", userId };

  const first = await callDeepSeek(callArgs);
  const second = await callDeepSeek(callArgs);
  check("B1: two calls under the daily cap of 2 both reach the provider", first.ok === true && second.ok === true);
  const countAfterTwo = fetchCallCount;

  const third = await callDeepSeek(callArgs);
  check(
    "B1: the third call (over the daily cap) is refused, quota-shaped, and does not throw",
    third.ok === false && /quota/i.test(third.reason || ""),
  );
  check(
    "B1: the refused call never reached the provider (fetch call count did not increase)",
    fetchCallCount === countAfterTwo,
  );
}

// B3 — userId is a required parameter: a call site that forgets it cannot
// silently escape metering.
{
  installFakeProviderUsageStore();
  let threw = null;
  try {
    await callDeepSeek({ system: "s", prompt: "p" });
  } catch (error) {
    threw = error;
  }
  check(
    "B3: calling callDeepSeek without userId throws rather than silently skipping metering",
    threw !== null && /userId/i.test(threw.message || ""),
  );
}

// B4 — the global daily ceiling refuses even a brand-new user who is
// comfortably under their own personal caps.
{
  installFakeProviderUsageStore();
  const dayKey = dailyPeriodKey();
  // Saturate the global sentinel row for DEEPSEEK/today directly, as if 5
  // OTHER users already spent the whole day's shared budget.
  for (let i = 0; i < 5; i++) {
    await ProviderUsage.tryIncrement({
      userId: GLOBAL_USAGE_USER_ID, provider: "DEEPSEEK", periodKey: dayKey, cap: 5,
    });
  }

  const freshUserId = "b4b4b4b4b4b4b4b4b4b4b4b4";
  const beforeFetchCount = fetchCallCount;
  const result = await callDeepSeek({ system: "s", prompt: "p", userId: freshUserId });

  check(
    "B4: a first-ever call from a fresh user (0/2 daily, 0/3 monthly) is still refused once the global ceiling is spent",
    result.ok === false && /provider-wide|volume limit/i.test(result.reason || ""),
  );
  check("B4: that refusal never reached the provider", fetchCallCount === beforeFetchCount);
}

// ═══════════════════════════════════════════════════════════════════════
// PART C — extractTextWithOcrSpace's own quota gate
// ═══════════════════════════════════════════════════════════════════════

const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n");

// C1/C2 — same shape as B1/B2, but OCR's choke point THROWS (matching its
// existing convention) rather than returning {ok:false}.
{
  installFakeProviderUsageStore();
  const userId = "c1c1c1c1c1c1c1c1c1c1c1c1";
  const callArgs = { buffer: PDF_BYTES, mimeType: "application/pdf", fileName: "n.pdf", consent: true, userId };

  const first = await extractTextWithOcrSpace(callArgs);
  const second = await extractTextWithOcrSpace(callArgs);
  check("C1: two calls under the daily cap of 2 both succeed", !!first.text && !!second.text);
  const countAfterTwo = fetchCallCount;

  let thirdError = null;
  try {
    await extractTextWithOcrSpace(callArgs);
  } catch (error) {
    thirdError = error;
  }

  check(
    "C1: the third call (over the daily cap) throws a 429 OCR_QUOTA_EXCEEDED, not a 500",
    thirdError?.statusCode === 429 && thirdError?.code === "OCR_QUOTA_EXCEEDED",
  );
  check(
    "C1: the refused call never reached the provider",
    fetchCallCount === countAfterTwo,
  );
}

// C3 — the global daily ceiling refuses a brand-new OCR user under their own cap.
{
  installFakeProviderUsageStore();
  const dayKey = dailyPeriodKey();
  for (let i = 0; i < 5; i++) {
    await ProviderUsage.tryIncrement({
      userId: GLOBAL_USAGE_USER_ID, provider: "OCR_SPACE", periodKey: dayKey, cap: 5,
    });
  }
  const freshUserId = "c3c3c3c3c3c3c3c3c3c3c3c3";
  let error = null;
  try {
    await extractTextWithOcrSpace({
      buffer: PDF_BYTES, mimeType: "application/pdf", fileName: "n.pdf", consent: true, userId: freshUserId,
    });
  } catch (err) {
    error = err;
  }
  check(
    "C3: a fresh OCR user is still refused (429) once the provider-wide daily ceiling is spent",
    error?.statusCode === 429 && /provider-wide|volume limit/i.test(error?.message || ""),
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PART D — through the real controllers: what does the client actually see?
// ═══════════════════════════════════════════════════════════════════════
// Same fakeReqRes/call() convention as audit-llm-failure-wording.mjs: call the
// real exported controller function directly with a minimal req/res, so the
// real controller logic (including its own reason-classification) runs.

function fakeReqRes(body, user) {
  const state = { status: 200, body: null };
  const req = { body, user, file: body?.__file };
  const res = {
    status(code) { state.status = code; return res; },
    json(payload) { state.body = payload; return res; },
  };
  return { req, res, state };
}

async function callController(handler, body, user) {
  const { req, res, state } = fakeReqRes(body, user);
  let nextErr = null;
  await handler(req, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return state;
}

// D1 — /api/audit/refine for a user already at the DeepSeek daily cap.
//
// IMPORTANT, and a documented discrepancy from this task's own brief (see
// honestGaps in the O10 report): the brief assumed a quota-shaped refusal
// "reaches the client as a 429... through that EXISTING classification".
// Reading audit.controller.js directly shows the classification regex
// (/balance|quota|insufficient/i in publicLlmFailureReason) exists, but it
// only rewrites the `reason` STRING for readability -- it never changes the
// HTTP status. All four routes in that file answer `res.json({ok:true, ...,
// generated:false})` with the default 200 status even on a hard LLM failure
// (this is also independently confirmed by the pre-existing
// tests/audit-llm-failure-wording.mjs, whose own top-of-file comment calls
// this "the 200-OK-with-generated:false domain path"). So the real, verified
// behaviour asserted below is 200/refined:false with the quota-aware wording
// -- NOT a 429. It is still correctly "not a 500", and the failure never
// reaches the provider.
{
  installFakeProviderUsageStore();
  const userId = "d1d1d1d1d1d1d1d1d1d1d1d1";
  for (let i = 0; i < 2; i++) {
    await ProviderUsage.reserveProviderCall({
      userId, provider: "DEEPSEEK", dailyCapPerUser: 2, monthlyCapPerUser: 3, globalDailyCap: 5,
    });
  }

  const beforeFetchCount = fetchCallCount;
  const result = await callController(
    refineAuditClassification,
    { rawText: "Revenue recognised on dispatch, per company policy note 4." },
    { id: userId },
  );

  check(
    "D1 (verified real behaviour, not the brief's assumed 429): /refine answers 200 with refined:false for a quota-exhausted user",
    result.status === 200 && result.body?.ok === true && result.body?.refined === false,
  );
  check(
    "D1: the reason is worded through the existing classification (an account/attention message), not a raw 'quota' leak",
    typeof result.body?.reason === "string" && result.body.reason.length > 0 && !/quota/i.test(result.body.reason),
  );
  check("D1: the refused call never reached the provider", fetchCallCount === beforeFetchCount);
}

// D2 — POST /api/cases/ocr for a user already at the OCR daily cap: THIS path
// genuinely does answer 429, because extractTextWithOcrSpace throws an
// httpError with statusCode 429, and previewCaseOcr's catch forwards it via
// next(error) untouched. app.js's global error handler (read directly, not
// re-executed here -- see honestGaps) resolves the response status from
// `err.statusCode` verbatim (`const candidateStatus = Number(multerStatus ||
// err?.status || err?.statusCode || 500)`), so this really does reach the
// client as 429, matching the brief for this provider.
{
  installFakeProviderUsageStore();
  const userId = "d2d2d2d2d2d2d2d2d2d2d2d2";
  for (let i = 0; i < 2; i++) {
    await extractTextWithOcrSpace({
      buffer: PDF_BYTES, mimeType: "application/pdf", fileName: "n.pdf", consent: true, userId,
    });
  }

  let thrown = null;
  try {
    const { req, res } = fakeReqRes(
      { consent: "true", __file: { buffer: PDF_BYTES, mimetype: "application/pdf", originalname: "n.pdf" } },
      { id: userId },
    );
    // Stands in for what requireFeatureFlag would have attached to req in the
    // real middleware chain, matching NOTICE_CASES_APP_CONFIG_DOC above.
    req.featureFlagVersions = { noticeCases: 0 };
    let nextErr = null;
    await previewCaseOcr(req, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
  } catch (error) {
    thrown = error;
  }

  check(
    "D2: POST /api/cases/ocr for a quota-exhausted user is refused with statusCode 429 (matches the brief for this provider)",
    thrown?.statusCode === 429 && thrown?.code === "OCR_QUOTA_EXCEEDED",
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PART E — REAL concurrency proof against a real MongoDB, when one is
// reachable. Parts A-D above prove the reservation LOGIC using an in-process
// fake store; because that fake has no genuine async yield point inside its
// findOneAndUpdate (it never actually awaits network I/O), 20 calls issued
// via Promise.all against it run to completion one at a time in submission
// order and can never truly interleave -- so it cannot, by itself, prove the
// claim the brief actually asks for ("20 concurrent calls ... result in
// exactly 1 provider attempt, proving the atomic $inc closes the race"). This
// section closes that gap for real: when MONGODB_URI is set, it restores the
// REAL ProviderUsage statics captured above (before Part A's fakes were
// installed) and fires 20 GENUINELY CONCURRENT callDeepSeek() calls from one
// user already sitting at cap-minus-1, against a real database connection,
// so the 20 findOneAndUpdate calls really do race over the network. Skipped
// (not failed) when no MongoDB is reachable, matching this file's other
// "no live MongoDB" constraint stated at the top -- but this repo's own gate
// script (run-gates.ps1) never sets MONGODB_URI, so this section is always
// skipped there and never makes the mandatory gate depend on a database.
if (process.env.MONGODB_URI) {
  const mongoose = (await import("mongoose")).default;
  ProviderUsage.find = REAL_PROVIDER_USAGE_STATICS.find;
  ProviderUsage.findOne = REAL_PROVIDER_USAGE_STATICS.findOne;
  ProviderUsage.findOneAndUpdate = REAL_PROVIDER_USAGE_STATICS.findOneAndUpdate;
  ProviderUsage.updateOne = REAL_PROVIDER_USAGE_STATICS.updateOne;
  ProviderUsage.deleteMany = REAL_PROVIDER_USAGE_STATICS.deleteMany;
  await mongoose.connect(process.env.MONGODB_URI);

  // Reproduce what production does at boot, BEFORE anything writes a row.
  //
  // src/config/db.js turns Mongoose autoIndex off in production ("index in dev, manage in prod"),
  // and index-provisioning.service.js is what "manage in prod" means -- it walks REQUIREMENT_GROUPS
  // and calls createIndexes() at every boot. Running this file directly never boots the app, so on
  // a fresh database the compound unique index that E1 is entirely about simply is not there, and
  // all 20 concurrent calls are allowed. That is a true report of the database it ran against and
  // a false report of the code, which is the worst kind of red.
  //
  // Ordering matters and is the whole reason this sits above the seed: a unique index cannot be
  // built over existing duplicates, so once a run without the index has inserted its 20 rows,
  // every later run on that database fails to create the index too and the failure looks
  // permanent. Provision first, then seed.
  const providerUsageCollection = ProviderUsage.collection.collectionName;
  await mongoose.connection.db.collection(providerUsageCollection).drop().catch(() => {});
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  const provisioning = await ensureRequiredIndexes();
  const providerUsageFailure = provisioning.failures.find(
    (failure) => failure.collection === providerUsageCollection,
  );
  check(
    "E-setup (LIVE MongoDB): the unique index E1 depends on was provisioned, as it is at every boot",
    !providerUsageFailure,
    providerUsageFailure ? providerUsageFailure.reason : "",
  );

  try {
    const userId = new mongoose.Types.ObjectId();
    const provider = "DEEPSEEK";
    // Put the user at cap-minus-1 (1 of 2) for the daily tier directly, and
    // leave the monthly/global tiers far above 20 so the ONLY tier actually
    // being raced by the 20 concurrent calls below is the per-user daily one.
    const seed = await ProviderUsage.reserveProviderCall({
      userId, provider, dailyCapPerUser: 2, monthlyCapPerUser: 100, globalDailyCap: 1000,
    });
    check("E0 (LIVE MongoDB): seed call to reach cap-minus-1 was itself allowed", seed.allowed === true);

    const beforeFetchCount = fetchCallCount;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => callDeepSeek({ system: "s", prompt: "p", userId })),
    );
    const succeeded = results.filter((r) => r.ok === true).length;
    const refused = results.filter((r) => r.ok === false && /quota/i.test(r.reason || "")).length;

    check(
      "E1 (LIVE MongoDB): 20 truly concurrent calls at cap-minus-1 result in exactly 1 success",
      succeeded === 1,
      `succeeded=${succeeded}`,
    );
    check(
      "E1 (LIVE MongoDB): the other 19 truly concurrent calls are refused with a quota reason",
      refused === 19,
      `refused=${refused}`,
    );
    check(
      "E1 (LIVE MongoDB): exactly 1 provider attempt (fetch call) was made across all 20 concurrent calls",
      fetchCallCount - beforeFetchCount === 1,
      `fetch call count delta=${fetchCallCount - beforeFetchCount}`,
    );

    const finalDoc = await ProviderUsage.findOne({ userId, provider, periodKey: dailyPeriodKey() });
    check(
      "E1 (LIVE MongoDB): the stored daily counter reads exactly the cap (2), never exceeded by the race",
      finalDoc?.calls === 2,
      `stored calls=${finalDoc?.calls}`,
    );

    // E2 — persistence survives a restart. There is no in-memory counter
    // anywhere in this design (every count lives only in ProviderUsage), so the
    // real proof is that a FULLY NEW connection -- torn down and rebuilt, the
    // same thing an app process restart does to its connection pool -- reads
    // back the same value a completely separate earlier connection wrote. If
    // the count were ever cached in process memory instead of read from Mongo,
    // a fresh connection with an empty cache would not see it.
    await mongoose.disconnect();
    await mongoose.connect(process.env.MONGODB_URI);
    const afterReconnect = await ProviderUsage.findOne({ userId, provider, periodKey: dailyPeriodKey() });
    check(
      "E2 (LIVE MongoDB): the counter survives a full disconnect/reconnect (proxy for a server restart) with the same value",
      afterReconnect?.calls === 2,
      `stored calls after reconnect=${afterReconnect?.calls}`,
    );

    await ProviderUsage.deleteMany({ userId });
  } finally {
    await mongoose.disconnect();
  }
} else {
  console.log(
    "[SKIP] PART E (live MongoDB concurrency proof) -- MONGODB_URI not set in this run; " +
      "Parts A-D's in-process proxy is the only concurrency evidence without a database.",
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════════════

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nProvider quota contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
