// tests/reminder-message-validation.mjs
//
// Closes two confirmed weak areas from agenttesting.md §24.1:
//
//   W01  dueDate was never validated before new Date(x).toLocaleDateString("en-IN"),
//        so an unparseable date could reach both the model prompt and the
//        deterministic fallback message a CA sends to a client as the literal
//        string "Invalid Date".
//   W16  daysPending and lastDelayDays had no range or NaN guard, so
//        Number("1e9") reached the prompt as 1000000000 ("pending for
//        1000000000 days").
//
// Both are exercised on the deterministic TEMPLATE fallback path (no
// DEEPSEEK_API_KEY set), because that is the path that is guaranteed to run
// and put text in front of a client even when the model is unavailable.

delete process.env.DEEPSEEK_API_KEY;

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const { generateReminderMessage } = await import(
  "../src/controllers/audit.controller.js"
);

// O10 added a per-user/monthly/global spend quota at the callDeepSeek choke
// point (ProviderUsage.reserveProviderCall), backed by a real MongoDB
// collection there is no live connection to here. This suite validates
// reminder-message wording, not quota, so the increment is stubbed to always
// succeed -- see tests/provider-quota-contract.mjs for the quota logic itself.
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

async function callReminder(body) {
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateReminderMessage(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

// ─── W01: an unparseable dueDate must never reach the message as "Invalid Date" ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    dueDate: "10th August", // exactly the free-text shape new Date() mangles
  });

  check("free-text dueDate: still answers 200", result.status === 200);
  check(
    "W01: free-text dueDate never produces the literal string 'Invalid Date' in the message",
    !String(result.body?.message || "").includes("Invalid Date"),
    result.body?.message,
  );
  check(
    "free-text dueDate falls back to the 'upcoming' wording",
    String(result.body?.message || "").includes("upcoming"),
    result.body?.message,
  );
}

// ─── W01: a valid ISO date is still accepted and rendered ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    dueDate: "2026-08-10",
  });

  check(
    "a valid ISO dueDate still renders a real date, not 'upcoming'",
    !String(result.body?.message || "").includes("upcoming") &&
      !String(result.body?.message || "").includes("Invalid Date"),
    result.body?.message,
  );
}

// ─── W16: an implausible daysPending must not reach the message verbatim ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    daysPending: "1e9",
  });

  check(
    "W16: scientific-notation daysPending never produces '1000000000' in the message",
    !String(result.body?.message || "").includes("1000000000"),
    result.body?.message,
  );
  check(
    "W16: an implausible daysPending falls back to the default of 3",
    String(result.body?.message || "").includes("3+ din"),
    result.body?.message,
  );
}

// ─── W16: a negative daysPending must not reach the message verbatim ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    daysPending: -5,
  });

  check(
    "W16: a negative daysPending never produces '-5' in the message",
    !String(result.body?.message || "").includes("-5"),
    result.body?.message,
  );
}

// ─── W16: a plausible daysPending is passed through unchanged ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "pending",
    daysPending: 12,
  });

  check(
    "a plausible daysPending of 12 is rendered exactly",
    String(result.body?.message || "").includes("12+ din"),
    result.body?.message,
  );
}

// ─── W16 on the "risk" path's lastDelayDays ───

{
  const result = await callReminder({
    clientName: "Test Client",
    serviceType: "GST filing",
    type: "risk",
    lastDelayDays: "Infinity",
  });

  check(
    "risk-path template still answers 200 with an implausible lastDelayDays",
    result.status === 200,
  );
  check(
    "W16: 'Infinity' lastDelayDays never reaches the risk-path message",
    !String(result.body?.message || "").includes("Infinity"),
    result.body?.message,
  );
}

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nReminder message validation: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
