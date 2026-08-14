// tests/audit-insights-reasoning-pipeline.mjs
//
// Root-cause regression tests for the structured reasoning pipeline added to
// POST /api/audit/insights, following a human reviewer's cross-audit
// critique of live output (five to six real runs reviewed, not one). The
// core finding: "the biggest weakness is that it sometimes jumps too
// quickly from evidence to conclusion" plus four narrower, independently
// named defects. Each numbered section below traces to one sentence of that
// critique:
//
//   1. BOILERPLATE SUPPRESSION - "it repeatedly adds SA 320/530
//      materiality, SA 505 confirmations, and SA 580 management
//      representations even when they are not specifically required for
//      that audit area." Materiality (SA 320/530) stays unconditional by
//      design (SA 320 requires it on every audit); confirmations (SA 505)
//      and representations (SA 580) are now gated by
//      isConfirmationRelevant/isRepresentationRelevant, on two independent
//      signals: a static per-topic relevance list, OR a content signal
//      from what this run's own findings actually mention (a third party,
//      or an estimate/completeness-flavoured standard).
//   2. ALREADY-PERFORMED DETECTION - "it frequently recommends procedures
//      that have already been performed ... instead of identifying the
//      actual remaining evidence gap." extractPerformedProceduresSections
//      pulls a document's own "Procedures Performed" narrative out
//      deterministically and injects it into the prompt with an explicit
//      "do not recommend these again" instruction.
//   3. FRAMEWORK-ASSUMPTION GUARD - "it sometimes assumes Ind AS 115, Ind
//      AS 2, Ind AS 10, or SA 540 without the applicable accounting
//      framework being explicitly provided, or it classifies a
//      straightforward cut-off issue as an accounting-estimate or
//      subsequent-event issue." Pinned as a prompt-content assertion: the
//      shared hard-rules block names this exact failure mode and the exact
//      corrective mapping (cut-off -> SA 500/330, not SA 540; SA 540 only
//      for a genuine estimate; SA 560 only for genuinely-after-year-end).
//   4. CLASSIFICATION TIER DISCIPLINE - "a control deficiency can be
//      treated as potential fraud or management override... a potential
//      risk can be presented almost like an established misstatement."
//      Pinned as a prompt-content assertion: the REASONING PIPELINE names
//      the three tiers (control deficiency / fraud risk indicator /
//      confirmed misstatement) and forbids writing a lower tier's finding
//      in a higher tier's language.
//   5. MATERIALITY / AGGREGATION DISCIPLINE - "it does not consistently
//      explain the practical significance of performance materiality
//      versus overall materiality" and "sometimes incorrectly aggregates
//      correctly recorded transactions with actual misstatements." Pinned
//      as a prompt-content assertion for the aggregation rule, and as a
//      behavioural assertion (existing materiality-aware wording, extended
//      to check performance-vs-overall is explicitly distinguished).
//
// All of these run against the REAL generateInsights controller with only
// the network boundary (fetch) stubbed, following the existing pattern in
// audit-insights-grounding.mjs and audit-insights-coverage-and-discipline.mjs.

process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "test-key-not-used";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

let responseQueue = [];
let capturedPrompts = [];

globalThis.fetch = async (_url, options) => {
  const body = options?.body ? JSON.parse(options.body) : null;
  const userPrompt = body?.messages?.find((m) => m.role === "user")?.content;
  if (userPrompt) capturedPrompts.push(userPrompt);

  const payload = responseQueue.shift();
  if (!payload) {
    throw new Error(
      "test forgot to enqueue enough responses before calling the controller",
    );
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: payload } }] }),
    text: async () => "",
  };
};

const { generateInsights } =
  await import("../src/controllers/audit.controller.js");

function fakeReqRes(body) {
  const state = { status: 200, body: null };
  const req = { body };
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

async function callInsights(body) {
  capturedPrompts = [];
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateInsights(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

function mandatoryTitlesOf(insights) {
  return (insights || []).map((item) => item.title);
}

const INSUFFICIENT_EVIDENCE_RESPONSE = JSON.stringify({
  result: "INSUFFICIENT_EVIDENCE",
  insufficientEvidenceReason: "test probe, no real content needed",
  insights: [],
});

// ─── 1a. Boilerplate suppression: a mechanical, no-third-party, no-estimate
//     finding must NOT carry SA 505 confirmations or SA 580 representations,
//     only the always-on SA 320/530 materiality item. ─────────────────────

const MECHANICAL_RECOMPUTE_PASSAGE = `Fixed Assets — Depreciation Recomputation [WP Ref: H-01]
Background: A machine was purchased on 1 July 2024 for Rs. 18,00,000, useful life 10 years, straight-line. The register shows Rs. 2,40,000 depreciation charged for the nine months to 31 March 2025.
Findings: The correct nine-month depreciation is Rs. 1,35,000; Rs. 2,40,000 was charged, an overstatement of Rs. 1,05,000.`;

const MECHANICAL_RECOMPUTE_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Quantify and correct Rs 1,05,000 depreciation overstatement",
      detail:
        "Quantify the Rs 1,05,000 depreciation overstatement and propose a correcting entry under SA 500.",
      risk: "high",
      standard: "SA 500",
      evidence:
        "The correct nine-month depreciation is Rs. 1,35,000; Rs. 2,40,000 was charged, an overstatement of Rs. 1,05,000.",
      why: "The overstatement directly affects profit and asset carrying value.",
      nextAction: "Record the adjusting entry if confirmed.",
    },
  ],
});

{
  responseQueue = [MECHANICAL_RECOMPUTE_RESPONSE];
  const result = await callInsights({
    rawText: MECHANICAL_RECOMPUTE_PASSAGE,
    // Deliberately NOT "FixedAssets" - that topic is on the estimate-
    // relevance list (impairment judgment is a genuine FixedAssets concern
    // in general), which would make representations relevant for a reason
    // unrelated to what this specific test checks. A topic ID absent from
    // BOTH relevance lists isolates the content-signal check to this one
    // finding's own text, which is the point of this test.
    topicId: "CashFlow",
    topicName: "Property, Plant & Equipment",
  });

  const titles = mandatoryTitlesOf(result.body?.insights);
  check(
    "boilerplate suppression: materiality (SA 320/530) is present - always unconditional",
    titles.includes("Determine materiality and sample basis"),
    JSON.stringify(titles),
  );
  check(
    "boilerplate suppression: SA 505 confirmations is ABSENT for a mechanical recompute finding with no third party and a topic not on the confirmation-relevance list",
    !titles.includes("Obtain external third-party confirmations"),
    JSON.stringify(titles),
  );
  check(
    "boilerplate suppression: SA 580 representations is ABSENT for a mechanical recompute finding with no estimate/completeness content",
    !titles.includes("Obtain written representations from management"),
    JSON.stringify(titles),
  );
}

// ─── 1b. Boilerplate suppression, content-driven signal: a topic NOT on the
//     static confirmation-relevance list still gets SA 505 when THIS run's
//     own findings genuinely mention a third party. ───────────────────────

const PAYROLL_VENDOR_PASSAGE = `Payroll — Outsourced Payroll Processor Fee [WP Ref: J-01]
Background: The company pays Meridian HR Services Pvt Ltd for payroll processing. Contracted fee is Rs. 12,00,000/year; Rs. 14,40,000 was actually paid, Rs. 2,40,000 more than contracted.
Findings: No variation order or additional-service invoice explains the excess.`;

const PAYROLL_VENDOR_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Confirm with Meridian HR Services the total fees paid",
      detail:
        "Send a written confirmation request to Meridian HR Services to confirm the Rs 14,40,000 total fees paid, under SA 505.",
      risk: "medium",
      standard: "SA 505",
      evidence:
        "The company pays Meridian HR Services Pvt Ltd for payroll processing. Contracted fee is Rs. 12,00,000/year; Rs. 14,40,000 was actually paid, Rs. 2,40,000 more than contracted.",
      why: "Direct confirmation from the vendor is independent evidence of the amount actually paid.",
      nextAction:
        "Investigate further if the vendor's confirmed figure differs.",
    },
  ],
});

{
  responseQueue = [PAYROLL_VENDOR_RESPONSE];
  const result = await callInsights({
    rawText: PAYROLL_VENDOR_PASSAGE,
    topicId: "Payroll",
    topicName: "Payroll & Employee Benefits",
  });

  const titles = mandatoryTitlesOf(result.body?.insights);
  check(
    "boilerplate suppression (content signal): SA 505 confirmations IS present for Payroll (not on the static list) because this run's own finding names a third-party vendor",
    titles.includes("Obtain external third-party confirmations"),
    JSON.stringify(titles),
  );
}

// ─── 2. Already-performed detection: the prompt sent to the model must
//     quote back the document's own "Procedures Performed" narrative with
//     an explicit "do not recommend these again" instruction. ────────────

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  await callInsights({
    rawText:
      "Trade Receivables [WP Ref: A-01]\nBackground: Rs. 62,00,000 is outstanding from a customer, overdue 400 days.\nAudit Procedures Performed: Obtained the ageing schedule; sent external confirmation; reviewed correspondence with the customer; discussed with the credit control team.\nFindings: No provision has been made.",
    topicName: "Receivables",
  });

  const prompt = capturedPrompts[0] || "";
  check(
    "already-performed: the prompt quotes back the document's own 'Procedures Performed' text",
    /PROCEDURES ALREADY PERFORMED/i.test(prompt) &&
      /sent external confirmation/i.test(prompt),
    prompt.slice(0, 400),
  );
  check(
    "already-performed: the prompt explicitly instructs not to recommend these again",
    /do NOT recommend any of these again/i.test(prompt),
  );
}

{
  // A document with no "Procedures Performed" heading at all must not inject
  // an actual data block - the prompt's own reasoning-pipeline instructions
  // always mention the label "PROCEDURES ALREADY PERFORMED" in step 7 (as a
  // standing instruction to check it "when present"), so the absence check
  // has to look for the actual INJECTED BLOCK's distinguishing phrase (the
  // "as stated by the working paper itself" lead-in performedProceduresBlock
  // writes), not the bare label, which is always in the prompt regardless.
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  await callInsights({
    rawText:
      "Some brief audit-relevant text with no stated procedures-performed section at all describing a finding worth reviewing.",
    topicName: "General audit",
  });

  const prompt = capturedPrompts[0] || "";
  check(
    "already-performed: no actual data block is injected when the document states no such section (the reasoning-pipeline instructions still mention the label itself, which is expected)",
    !/as stated by the working paper itself/i.test(prompt),
  );
}

// ─── 3. Framework-assumption guard: the prompt must instruct the model not
//     to assume a specific accounting standard, and to classify a plain
//     cut-off issue correctly rather than reclassifying it. ──────────────

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  await callInsights({
    rawText: "Some audit-relevant text about a transaction near year end.",
    topicName: "Revenue",
  });

  const prompt = capturedPrompts[0] || "";
  check(
    "framework guard: the prompt forbids citing a specific Ind AS number without the framework being stated",
    /NEVER cite a specific accounting standard.*unless the text itself states or clearly implies/i.test(
      prompt,
    ),
    prompt.length > 0
      ? "(prompt captured, pattern not found)"
      : "(no prompt captured)",
  );
  check(
    "framework guard: the prompt names the specific correction - a plain cut-off issue should cite SA 500/330, not SA 540, and not be reclassified as an estimate or subsequent-event issue",
    /plain timing\/cut-off issue/i.test(prompt) &&
      /NOT SA 540/i.test(prompt) &&
      /NOT reclassified as an accounting-estimate issue or a subsequent-events issue/i.test(
        prompt,
      ),
  );
  check(
    "framework guard: the prompt restricts SA 560 to events between the reporting date and the report date, not a same-period cut-off timing issue",
    /an event before the reporting date is a cut-off issue/i.test(prompt) &&
      /is only a "subsequent event" if it falls between them/i.test(prompt),
    prompt.length > 0
      ? "(prompt captured, pattern not found)"
      : "(no prompt captured)",
  );
}

// ─── 4. Classification tier discipline: the prompt must name all three
//     tiers and forbid writing a lower tier in a higher tier's language. ──

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  await callInsights({
    rawText: "Some audit-relevant text about a control gap.",
    topicName: "InternalControls",
  });

  const prompt = capturedPrompts[0] || "";
  check(
    "classification tiers: the prompt names all three tiers explicitly",
    /"control deficiency"/.test(prompt) &&
      /"fraud risk indicator"/.test(prompt) &&
      /"confirmed misstatement"/.test(prompt),
  );
  check(
    "classification tiers: the prompt forbids describing a control deficiency using fraud-toned language",
    /must never be described using fraud-toned language/i.test(prompt),
  );
  check(
    "classification tiers: the prompt forbids describing an unconfirmed risk indicator as if already confirmed",
    /must never be described as if confirmed/i.test(prompt),
  );
  check(
    "classification tiers: the prompt includes the self-check question about evidence support",
    /Is my conclusion directly supported by the evidence/i.test(prompt),
  );
  check(
    "classification tiers: the prompt includes the self-check question about necessity",
    /Is this procedure actually necessary for THIS specific risk/i.test(prompt),
  );
}

// ─── 5. Materiality / aggregation discipline: the prompt must instruct the
//     model not to aggregate a correctly-recorded amount with an actual
//     misstatement, and to distinguish performance from overall materiality
//     in its own reasoning steps (not just in the mandatory procedure's
//     canned wording, which is already covered by the coverage-and-
//     discipline test file). ──────────────────────────────────────────────

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  await callInsights({
    rawText: "Some audit-relevant text about several transactions.",
    topicName: "Revenue",
  });

  const prompt = capturedPrompts[0] || "";
  check(
    "materiality/aggregation: the prompt forbids aggregating a correctly-recorded transaction with an actual misstatement",
    /Do not silently add this amount to a DIFFERENT, correctly-recorded transaction's amount/i.test(
      prompt,
    ),
  );
  check(
    "materiality/aggregation: the prompt's own reasoning pipeline includes a distinct MATERIALITY step",
    /5\. MATERIALITY:/i.test(prompt),
  );
}

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nAudit insights reasoning pipeline: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
