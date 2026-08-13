// tests/audit-insights-grounding.mjs
//
// Executes the redesigned POST /api/audit/insights controller (generateInsights)
// against the human's own revenue cut-off fixture from
// EXTENSION-DESKTOP-FEATURE-PARITY.md §4, with a stubbed DeepSeek call so no
// network request is made and no API key is required.
//
// Why this exists. The previous version of this endpoint was traced to four
// independent root causes, none of them a prompt-tuning problem:
//
//   M1  three mandatory boilerplate procedures consumed up to 7 of 8 model slots
//   M2  grounding was a sentence of prose; nothing could check a citation existed
//   M3  maxTokens truncation was silently repaired, discarding exactly the
//       document-specific findings, which are emitted last
//   M4  the model saw rawText + a topic label only, never the packaged
//       reference procedures/mistakes /refine already receives
//
// Each fix is exercised here as a behavioural assertion, not a code reading:
//
//   B1  every returned procedure's evidence is a substring of the text sent
//   B2  the three mandatory procedures never occupy a model-derived slot
//   B3  at least 4 of 6 known facts from the fixture are cited across the run
//   B4  a deliberately truncated response is reported partial, not silently repaired
//   B5  a duplicate title, a non-imperative detail, and an ungrounded evidence
//       span are each rejected; an all-rejected batch reports insufficient
//       evidence rather than an empty success

process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "test-key-not-used";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── The human's own fixture, verbatim from §4 ──────────────────────

const REVENUE_PASSAGE = `During the physical stock verification, the company disclosed a sale and repurchase arrangement worth Rs 42 lakh with a related dealer, structured so the goods never left the warehouse. Dispatch records show Rs 18.5 lakh of goods dispatched on 31 March 2026 to two customers who had explicitly written requesting delivery only after 5 April, yet revenue was recognised in the year under audit. Rs 7.2 lakh of credit notes were issued in the first week of April against invoices raised in the last week of March, and three of these credit notes lack any approval signature. The shipping documents for an export consignment record the bill of lading date as 2 April while the sales invoice is dated 29 March, meaning control had not transferred to the customer before the year-end cut-off the company applied. No formal cut-off testing procedure appears to have been performed by the finance team. The CFO's email to the sales team, dated 27 March, states "we need these numbers in by month end no matter what it takes."`;

// The six specific facts the benchmark asks for, each with a short label and a
// verbatim substring that must appear somewhere in the fixture (sanity-checking
// the fixture itself, not the controller).
const KNOWN_FACTS = [
  { label: "Rs 42 lakh sale-and-repurchase", needle: "42 lakh" },
  {
    label: "Rs 18.5 lakh dispatch / delivery-after-5-April",
    needle: "18.5 lakh",
  },
  { label: "Rs 7.2 lakh credit notes lacking approval", needle: "7.2 lakh" },
  {
    label: "export control-transfer mismatch (bill of lading vs invoice date)",
    needle: "bill of lading",
  },
  { label: "absent formal cut-off test", needle: "cut-off testing" },
  {
    label: "management-pressure indicator (CFO email)",
    needle: "no matter what it takes",
  },
];

for (const fact of KNOWN_FACTS) {
  check(
    `fixture sanity: "${fact.label}" is actually present in the passage`,
    REVENUE_PASSAGE.toLowerCase().includes(fact.needle.toLowerCase()),
    `looked for "${fact.needle}"`,
  );
}

// ─── Stub callDeepSeek's only external dependency: fetch ────────────
//
// Stubbed at the transport boundary, not by mocking callDeepSeek itself, so the
// real retry/fallback/timeout logic in deepseek-provider.service.js still runs.

let nextResponse = null;

globalThis.fetch = async () => {
  const payload = nextResponse;
  if (!payload)
    throw new Error(
      "test forgot to set nextResponse before calling the controller",
    );
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
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateInsights(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

// ─── B1 + B3: a realistic grounded response cites real evidence ────

const GROUNDED_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title:
        "Test sale-and-repurchase substance for the Rs 42 lakh arrangement",
      detail:
        "Inspect the sale and repurchase agreement to assess whether the Rs 42 lakh arrangement transferred genuine control given the goods never left the warehouse.",
      risk: "high",
      standard: "Ind AS 115",
      evidence:
        "sale and repurchase arrangement worth Rs 42 lakh with a related dealer",
      why: "A sale where the goods never left the warehouse may not meet the control-transfer test for revenue recognition.",
      nextAction:
        "If control did not transfer, propose reversing the recognised revenue and record it as an unadjusted misstatement.",
    },
    {
      title:
        "Test dispatch cut-off for the Rs 18.5 lakh shipment against requested delivery dates",
      detail:
        "Trace the Rs 18.5 lakh dispatch recorded on 31 March against the customers' written requests for delivery only after 5 April to assess whether control transferred before year-end.",
      risk: "high",
      standard: "SA 500",
      evidence:
        "Rs 18.5 lakh of goods dispatched on 31 March 2026 to two customers who had explicitly written requesting delivery only after 5 April",
      why: "A dispatch date before the customer's own requested delivery date suggests revenue may have been recognised a period early.",
      nextAction:
        "If cut-off is confirmed wrong, propose deferring the revenue to the next period.",
    },
    {
      title: "Vouch the Rs 7.2 lakh of unapproved post-year-end credit notes",
      detail:
        "Vouch the Rs 7.2 lakh of credit notes issued in April against March invoices, and obtain approval evidence for the three lacking a signature.",
      risk: "high",
      standard: "SA 240",
      evidence:
        "Rs 7.2 lakh of credit notes were issued in the first week of April against invoices raised in the last week of March, and three of these credit notes lack any approval signature",
      why: "A credit note with no approval signature is a control gap that can be used to manage reported revenue.",
      nextAction:
        "Escalate the three unapproved credit notes to the audit committee if approval cannot be obtained.",
    },
    {
      title: "Reconcile export bill of lading date against invoice date",
      detail:
        "Reconcile the bill of lading date of 2 April against the 29 March sales invoice to determine the correct period for this export transaction.",
      risk: "high",
      standard: "Ind AS 115",
      evidence:
        "the bill of lading date as 2 April while the sales invoice is dated 29 March",
      why: "Control over an export shipment typically transfers no earlier than the bill of lading date, not the invoice date.",
      nextAction:
        "If the mismatch is confirmed, propose moving this transaction's revenue to the following period.",
    },
    {
      title: "Perform a formal cut-off test",
      detail:
        "Perform a formal sales cut-off test across the year-end period given no such procedure appears to have been performed by the finance team.",
      risk: "medium",
      standard: "SA 500",
      evidence:
        "No formal cut-off testing procedure appears to have been performed by the finance team",
      why: "Without a cut-off test, revenue recorded near year-end has not been independently checked for the correct period.",
      nextAction:
        "Design and perform a cut-off test covering the last and first ten days of the adjoining periods.",
    },
    {
      title:
        "Assess management-pressure fraud risk indicator from the CFO's email",
      detail:
        "Assess the CFO's instruction to the sales team as a fraud risk indicator of management pressure to meet revenue targets.",
      risk: "high",
      standard: "SA 240",
      evidence: "we need these numbers in by month end no matter what it takes",
      why: "Explicit pressure to hit a number near year-end is a recognised fraud risk factor under SA 240.",
      nextAction:
        "Extend substantive testing over revenue recognised in the final week of the period.",
    },
  ],
});

{
  nextResponse = GROUNDED_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE,
    topicId: "Revenue",
    topicName: "Revenue Recognition",
  });

  check("grounded run: HTTP 200", result.status === 200);
  check("grounded run: ok true", result.body?.ok === true);
  check("grounded run: generated true", result.body?.generated === true);
  check(
    "grounded run: not flagged insufficientEvidence",
    result.body?.insufficientEvidence !== true,
  );

  const insights = Array.isArray(result.body?.insights)
    ? result.body.insights
    : [];
  check(
    "grounded run: at least 6 insights returned (3 mandatory + at least 3 model)",
    insights.length >= 6,
  );

  // B2: the three mandatory procedures are present and carry no evidence field
  // (or an empty one) - they are standard-mandated, not document-derived.
  const mandatoryTitles = [
    "Determine materiality and sample basis",
    "Obtain external third-party confirmations",
    "Obtain written representations from management",
  ];
  const mandatoryFound = mandatoryTitles.every((title) =>
    insights.some((item) => item.title === title && !item.evidence),
  );
  check(
    "B2: all three mandatory procedures present, each with empty evidence",
    mandatoryFound,
    JSON.stringify(
      insights.map((i) => ({ title: i.title, evidence: i.evidence })),
    ),
  );

  // B1: every non-mandatory procedure's evidence is a verbatim substring of the
  // text actually sent to the model (case-insensitive, whitespace-normalized).
  const sentNormalized = REVENUE_PASSAGE.replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const modelDerived = insights.filter(
    (item) => !mandatoryTitles.includes(item.title),
  );
  check(
    "B1: at least one model-derived procedure returned",
    modelDerived.length > 0,
  );
  const ungroundedEvidence = modelDerived.filter(
    (item) =>
      !sentNormalized.includes(
        String(item.evidence || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase(),
      ),
  );
  check(
    "B1: every model-derived procedure's evidence is a substring of the input",
    ungroundedEvidence.length === 0,
    ungroundedEvidence.map((i) => i.evidence).join(" | "),
  );

  // B3: at least 4 of the 6 known facts are cited by SOME evidence span.
  const allEvidence = insights
    .map((i) => String(i.evidence || "").toLowerCase())
    .join(" \n ");
  const citedFacts = KNOWN_FACTS.filter((fact) =>
    allEvidence.includes(fact.needle.toLowerCase()),
  );
  check(
    "B3: at least 4 of 6 known facts are cited by evidence",
    citedFacts.length >= 4,
    `cited ${citedFacts.length}/6: ${citedFacts.map((f) => f.label).join(", ")}`,
  );

  // Every detail must actually be imperative - the output gate's job.
  const nonImperative = modelDerived.filter(
    (item) => !/^[A-Za-z]+/.test(String(item.detail || "").trim()),
  );
  check("every returned detail has a leading word", nonImperative.length === 0);

  // Suggestion #5/#7: every model-derived procedure carries a plain-language
  // "why" and a "nextAction", both bounded, both present when the model
  // supplied them.
  check(
    "every model-derived procedure carries a why and a nextAction",
    modelDerived.every(
      (item) =>
        typeof item.why === "string" &&
        item.why.length > 0 &&
        typeof item.nextAction === "string" &&
        item.nextAction.length > 0,
    ),
    JSON.stringify(
      modelDerived.map((i) => ({ why: i.why, nextAction: i.nextAction })),
    ),
  );

  // Suggestion #1: a rupee figure stated inside the GROUNDED evidence is
  // extracted deterministically (regex, not model arithmetic) into
  // amountMinor. Only three of the six fixture items actually carry a Rs
  // figure in their evidence (42 lakh, 18.5 lakh, 7.2 lakh) - the other three
  // (bill of lading date, cut-off absence, CFO email) genuinely have no
  // amount to extract, so amountMinor: null for those is the correct
  // deterministic answer, not a gap.
  const evidenceWithRupeeFigure = modelDerived.filter((item) =>
    /(?:rs\.?|inr|₹)\s*[0-9]/i.test(item.evidence),
  );
  const missingAmount = evidenceWithRupeeFigure.filter(
    (item) => typeof item.amountMinor !== "number",
  );
  check(
    "every model-derived procedure whose evidence states a rupee figure has amountMinor extracted",
    evidenceWithRupeeFigure.length >= 3 && missingAmount.length === 0,
    JSON.stringify(missingAmount.map((i) => i.evidence)),
  );
  const evidenceWithNoRupeeFigure = modelDerived.filter(
    (item) => !/(?:rs\.?|inr|₹)\s*[0-9]/i.test(item.evidence),
  );
  check(
    "a procedure whose evidence states no rupee figure gets amountMinor: null, never a guess",
    evidenceWithNoRupeeFigure.every((item) => item.amountMinor === null),
    JSON.stringify(evidenceWithNoRupeeFigure.map((i) => i.amountMinor)),
  );
  const rs42LakhItem = modelDerived.find((item) =>
    item.evidence.includes("42 lakh"),
  );
  check(
    "amountMinor for 'Rs 42 lakh' is 42,00,000 rupees in paise (420000000)",
    rs42LakhItem?.amountMinor === 420000000,
    `got ${rs42LakhItem?.amountMinor}`,
  );

  // The three mandatory procedures always carry why/nextAction too, and an
  // explicit null amountMinor (standard-mandated, not document-derived).
  const mandatoryItems = insights.filter((item) =>
    mandatoryTitles.includes(item.title),
  );
  check(
    "every mandatory procedure carries why, nextAction, and amountMinor: null",
    mandatoryItems.every(
      (item) =>
        typeof item.why === "string" &&
        item.why.length > 0 &&
        typeof item.nextAction === "string" &&
        item.nextAction.length > 0 &&
        item.amountMinor === null,
    ),
    JSON.stringify(
      mandatoryItems.map((i) => ({ why: i.why, amountMinor: i.amountMinor })),
    ),
  );
}

// ─── B5: duplicate title, non-imperative detail, ungrounded evidence ────

const MIXED_QUALITY_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Test the dispatch cut-off",
      detail:
        "Trace the Rs 18.5 lakh dispatch against the delivery request dates.",
      risk: "high",
      standard: "SA 500",
      evidence: "Rs 18.5 lakh of goods dispatched on 31 March 2026",
    },
    // Exact duplicate title - must be rejected as a repeat, not a second finding.
    {
      title: "Test the dispatch cut-off",
      detail: "Inspect the same dispatch records again for a different reason.",
      risk: "medium",
      standard: "SA 500",
      evidence: "Rs 18.5 lakh of goods dispatched on 31 March 2026",
    },
    // Non-imperative detail (starts with "This" rather than a verb) - rejected.
    {
      title: "Management pressure is concerning",
      detail:
        "This shows the CFO applied pressure on the sales team near year-end.",
      risk: "high",
      standard: "SA 240",
      evidence: "no matter what it takes",
    },
    // Evidence that was never in the input - fabricated, must be rejected.
    {
      title: "Investigate the fabricated related-party loan",
      detail:
        "Obtain the loan agreement for the Rs 90 lakh related-party loan mentioned in the ledger.",
      risk: "high",
      standard: "SA 550",
      evidence: "Rs 90 lakh related-party loan disclosed in the notes",
    },
  ],
});

{
  nextResponse = MIXED_QUALITY_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE,
    topicId: "Revenue",
    topicName: "Revenue Recognition",
  });

  const insights = Array.isArray(result.body?.insights)
    ? result.body.insights
    : [];
  const modelDerived = insights.filter(
    (item) =>
      ![
        "Determine materiality and sample basis",
        "Obtain external third-party confirmations",
        "Obtain written representations from management",
      ].includes(item.title),
  );

  check(
    "B5: exactly one model-derived procedure survives (duplicate/non-imperative/fabricated all rejected)",
    modelDerived.length === 1,
    JSON.stringify(modelDerived.map((i) => i.title)),
  );
  check(
    "B5: the surviving procedure is the genuinely grounded, imperative, non-duplicate one",
    modelDerived[0]?.title === "Test the dispatch cut-off",
  );
}

// ─── B5: an all-rejected batch reports insufficient evidence, not empty success ────

const ALL_REJECTED_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Fabricated finding",
      detail: "Obtain confirmation of a fact that is not in the text at all.",
      risk: "high",
      standard: "",
      evidence: "this exact phrase does not appear anywhere in the passage",
    },
  ],
});

{
  nextResponse = ALL_REJECTED_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE,
    topicId: "Revenue",
    topicName: "Revenue Recognition",
  });

  check("all-rejected run: ok true", result.body?.ok === true);
  check(
    "all-rejected run: generated true (the three mandatory procedures still stand)",
    result.body?.generated === true,
  );
  check(
    "B5: an all-rejected model batch is flagged insufficientEvidence rather than a silent empty success",
    result.body?.insufficientEvidence === true,
  );
  check(
    "B5: the three mandatory procedures are still returned even when every model item is rejected",
    Array.isArray(result.body?.insights) && result.body.insights.length === 3,
  );
}

// ─── The model's own explicit INSUFFICIENT_EVIDENCE path ───────────

const EXPLICIT_INSUFFICIENT_RESPONSE = JSON.stringify({
  result: "INSUFFICIENT_EVIDENCE",
  insufficientEvidenceReason:
    "The text is a single vague sentence with no specific amounts, dates or parties.",
  insights: [],
});

{
  nextResponse = EXPLICIT_INSUFFICIENT_RESPONSE;
  const result = await callInsights({
    rawText: "Some expenses were recorded during the year.",
    topicId: "Payables",
  });

  check("explicit insufficient: ok true", result.body?.ok === true);
  check(
    "explicit insufficient: generated true",
    result.body?.generated === true,
  );
  check(
    "explicit insufficient: insufficientEvidence true",
    result.body?.insufficientEvidence === true,
  );
  check(
    "explicit insufficient: reason is the model's own stated reason",
    result.body?.reason ===
      "The text is a single vague sentence with no specific amounts, dates or parties.",
  );
  check(
    "explicit insufficient: the three mandatory procedures are still returned",
    Array.isArray(result.body?.insights) && result.body.insights.length === 3,
  );
}

// ─── B4: a deliberately truncated response is reported partial ────
//
// Simulates the model hitting max_tokens mid-object: the JSON string is cut off
// partway through a value and never closed. deepseek-provider's
// repairTruncatedJson can still recover the insights emitted before the cut,
// but the response must say partial:true rather than silently returning as if
// nothing were lost.

const COMPLETE_TRUNCATION_SOURCE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Test the dispatch cut-off",
      detail:
        "Trace the Rs 18.5 lakh dispatch against the delivery request dates.",
      risk: "high",
      standard: "SA 500",
      evidence: "Rs 18.5 lakh of goods dispatched on 31 March 2026",
    },
    {
      title: "Reconcile the export bill of lading date",
      detail:
        "Reconcile the bill of lading date against the invoice date for this export shipment.",
      risk: "high",
      standard: "Ind AS 115",
      evidence:
        "the bill of lading date as 2 April while the sales invoice is dated 29 March",
    },
  ],
});
// Cut the source mid-way through the second insight's "evidence" value, exactly
// as a max_tokens cutoff would - no closing quote, no closing braces/brackets.
const cutPoint =
  COMPLETE_TRUNCATION_SOURCE.indexOf("the bill of lading date") + 10;
const TRUNCATED_RESPONSE = COMPLETE_TRUNCATION_SOURCE.slice(0, cutPoint);

{
  nextResponse = TRUNCATED_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE,
    topicId: "Revenue",
  });

  check(
    "B4: truncated response still parses (repair recovers the first insight)",
    result.body?.ok === true,
  );
  check(
    "B4: truncated response is reported partial:true rather than silently complete",
    result.body?.partial === true,
    `body: ${JSON.stringify(result.body).slice(0, 200)}`,
  );
}

// ─── Guardrails that must be unchanged from before ──────────────────

{
  const { req, res } = fakeReqRes({});
  let nextErr = null;
  const state = { status: 200, body: null };
  const wrappedRes = {
    status(code) {
      state.status = code;
      return wrappedRes;
    },
    json(body) {
      state.body = body;
      return wrappedRes;
    },
  };
  await generateInsights(req, wrappedRes, (err) => {
    nextErr = err;
  });
  check(
    "missing rawText is refused with 400",
    state.status === 400 && state.body?.ok === false,
  );
  check(
    "missing rawText refusal names the field",
    state.body?.error === "rawText required",
  );
}

{
  const previousKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await callInsights({
      rawText: REVENUE_PASSAGE,
      topicId: "Revenue",
    });
    check(
      "no API key: still answers 200 with generated:false",
      result.status === 200 && result.body?.generated === false,
    );
    check(
      "no API key: empty insights array, not the mandatory block",
      Array.isArray(result.body?.insights) && result.body.insights.length === 0,
    );
  } finally {
    process.env.DEEPSEEK_API_KEY = previousKey;
  }
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
console.log(`\nAudit insights grounding: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
