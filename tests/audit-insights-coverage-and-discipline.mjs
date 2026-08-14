// tests/audit-insights-coverage-and-discipline.mjs
//
// Root-cause regression tests for the coverage-check pass, evidence/risk
// discipline, materiality-aware mandatory-procedure wording, and near-
// duplicate suppression added to POST /api/audit/insights following a
// human's detailed qualitative review of live output against two real,
// multi-issue statutory working papers (Stellar Textiles and Orion
// Industrial - both saved as fixtures under tools/audit-fixtures/ and
// runnable live via tools/run-insights-fixture.mjs).
//
// The human's critique, condensed, and what each check below pins:
//
//   1. Two whole findings (revenue cut-off / covenant breach on the Orion
//      fixture; foreign-exchange / going-concern on the Stellar fixture)
//      were silently missed by a single generation pass despite the
//      response having room to spare under the insight-count ceiling.
//      -> COVERAGE CHECK below: a targeted second pass, told EXACTLY which
//         "[WP Ref: ...]"-tagged sections the primary pass produced zero
//         finding for, recovers a finding from an uncovered section.
//   2. A payroll-access finding was phrased as an established fact
//      ("Investigate unauthorized...") when the source only shows a
//      SUSPICIOUS PATTERN (an unusual login used while its usual holder was
//      reportedly on leave) - nothing in the text confirms the access was
//      actually unauthorized.
//      -> FACT VS RISK DISCIPLINE below: the prompt's hard-rules block
//         (shared by both passes) explicitly distinguishes a confirmed fact
//         from a suspected risk and is pinned to contain that instruction.
//   3. The same underlying finding (an unsupported Rs 2,50,000 accrual
//      portion) was produced as three near-identical, separately-titled
//      items.
//      -> DEDUP below: deduplicateNearIdenticalInsights is exercised via
//         the real endpoint and collapses near-duplicate titles to one.
//   4. The mandatory "Determine materiality" procedure read as fully
//      generic even when the working paper's own cover page already states
//      an overall materiality figure.
//      -> MATERIALITY-AWARE WORDING below: a document stating "Materiality
//         (Overall): Rs. X" produces a materiality procedure whose detail
//         quotes that figure, and one that does not falls back to the
//         previous generic wording unchanged.
//
// All of these run against the REAL generateInsights controller with only
// the network boundary (fetch) stubbed, following the existing pattern in
// audit-insights-grounding.mjs - so the prompt-building, response-parsing,
// grounding and dedup logic under test is exactly what a live call runs.

process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || "test-key-not-used";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// Queue of responses returned in order, one per fetch call - lets a test
// script the primary-pass response and a distinct coverage-check response
// separately, which a single nextResponse variable (as other test files use
// for single-pass scenarios) cannot express.
let responseQueue = [];

globalThis.fetch = async () => {
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
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateInsights(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

const mandatoryTitles = new Set([
  "Determine materiality and sample basis",
  "Obtain external third-party confirmations",
  "Obtain written representations from management",
]);

function modelDerived(insights) {
  return (insights || []).filter((item) => !mandatoryTitles.has(item.title));
}

// ─── Fixture: a three-section tagged working paper, deliberately built so
//     a single "primary pass" response covers only ONE of the three tagged
//     sections - this isolates the coverage-check mechanism itself rather
//     than depending on a live model actually stopping short, which is not
//     reproducible in a stubbed test. ────────────────────────────────────

const THREE_SECTION_PASSAGE = `Trade Receivables [WP Ref: A-01]
Background: Rs. 62,00,000 is outstanding from Vantage Garments LLC, overdue by more than 400 days. No provision has been made against this balance.
Findings: Credit control confirmed no realistic recovery plan exists.

Foreign Exchange [WP Ref: B-02]
Background: Export sales of Rs. 2,80,00,000 were recognized. 11 invoices totaling Rs. 34,00,000 used the wrong exchange rate under Ind AS 21.
Findings: Overstatement of revenue of approximately Rs. 3,10,000 identified in the sample.

Going Concern [WP Ref: G-07]
Background: The company's working capital facility of Rs. 3,00,00,000 is due for renewal in July 2025. The bank has verbally indicated renewal may require additional collateral.
Findings: No formal renewal confirmation exists; management has no documented alternative funding plan.`;

const PRIMARY_PASS_COVERS_ONLY_A01 = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Evaluate adequacy of provision for Rs 62,00,000 receivable",
      detail:
        "Assess the recoverability of the Rs 62,00,000 receivable from Vantage Garments LLC and determine if the provision is adequate under SA 540.",
      risk: "high",
      standard: "SA 540",
      evidence:
        "Rs. 62,00,000 is outstanding from Vantage Garments LLC, overdue by more than 400 days. Credit control confirmed no realistic recovery plan exists.",
      why: "A large, long-overdue receivable with no recovery plan suggests the provision is understated.",
      nextAction: "If inadequate, propose an adjusting entry.",
    },
  ],
});

const COVERAGE_PASS_FINDS_B02_AND_G07 = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Quantify FX misstatement on export sales of Rs 34,00,000",
      detail:
        "Quantify the full population impact of the incorrect exchange rate used on the Rs 34,00,000 sample under Ind AS 21.",
      risk: "high",
      standard: "Ind AS 21",
      evidence:
        "11 invoices totaling Rs. 34,00,000 used the wrong exchange rate under Ind AS 21. Overstatement of revenue of approximately Rs. 3,10,000 identified in the sample.",
      why: "A systemic FX translation error could materially overstate revenue.",
      nextAction: "Extrapolate the sample impact across the full population.",
    },
    {
      title:
        "Assess going concern risk from Rs 3,00,00,000 facility renewal uncertainty",
      detail:
        "Evaluate the going concern implications of the Rs 3,00,00,000 working capital facility renewal uncertainty under SA 570.",
      risk: "high",
      standard: "SA 570",
      evidence:
        "The company's working capital facility of Rs. 3,00,00,000 is due for renewal in July 2025. No formal renewal confirmation exists.",
      why: "Uncertain access to working capital could cast doubt on going concern.",
      nextAction: "Obtain management's written assessment.",
    },
  ],
});

{
  responseQueue = [
    PRIMARY_PASS_COVERS_ONLY_A01,
    COVERAGE_PASS_FINDS_B02_AND_G07,
  ];
  const result = await callInsights({
    rawText: THREE_SECTION_PASSAGE,
    topicName: "General audit",
  });

  check("coverage-check: HTTP 200", result.status === 200);
  check("coverage-check: generated true", result.body?.generated === true);

  const derived = modelDerived(result.body?.insights);
  const refs = derived.map((item) => item.workingPaperRef).filter(Boolean);

  check(
    "coverage-check: the primary pass's A-01 finding survives in the final response",
    refs.includes("A-01"),
    JSON.stringify(refs),
  );
  check(
    "coverage-check: the coverage pass's B-02 finding (missed by the primary pass) is present",
    refs.includes("B-02"),
    JSON.stringify(refs),
  );
  check(
    "coverage-check: the coverage pass's G-07 finding (missed by the primary pass) is present",
    refs.includes("G-07"),
    JSON.stringify(refs),
  );
  check(
    "coverage-check: exactly 3 document-specific findings total (1 primary + 2 coverage)",
    derived.length === 3,
    JSON.stringify(derived.map((i) => i.title)),
  );
}

// ─── The coverage-check pass must be SKIPPED (no second fetch call at all)
//     when the primary pass already covers every tagged section, so a
//     complete primary result is not spent on a pointless extra call. ────

{
  const ALL_THREE_COVERED = JSON.stringify({
    result: "SUPPORTED",
    insufficientEvidenceReason: "",
    insights: [
      {
        title: "Evaluate adequacy of provision for Rs 62,00,000 receivable",
        detail:
          "Assess the recoverability of the Rs 62,00,000 receivable and determine if the provision is adequate under SA 540.",
        risk: "high",
        standard: "SA 540",
        evidence:
          "Rs. 62,00,000 is outstanding from Vantage Garments LLC, overdue by more than 400 days.",
      },
      {
        title: "Quantify FX misstatement of Rs 34,00,000",
        detail:
          "Quantify the FX misstatement on the Rs 34,00,000 sample under Ind AS 21.",
        risk: "high",
        standard: "Ind AS 21",
        evidence:
          "11 invoices totaling Rs. 34,00,000 used the wrong exchange rate under Ind AS 21.",
      },
      {
        title: "Assess going concern risk from facility renewal",
        detail:
          "Evaluate going concern given the Rs 3,00,00,000 facility renewal uncertainty under SA 570.",
        risk: "high",
        standard: "SA 570",
        evidence:
          "The company's working capital facility of Rs. 3,00,00,000 is due for renewal in July 2025.",
      },
    ],
  });

  let fetchCallCount = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCallCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: ALL_THREE_COVERED } }],
      }),
      text: async () => "",
    };
  };
  try {
    const result = await callInsights({
      rawText: THREE_SECTION_PASSAGE,
      topicName: "General audit",
    });
    check(
      "coverage-check skip: exactly 1 fetch call when every tagged section is already covered",
      fetchCallCount === 1,
      `actual fetch calls: ${fetchCallCount}`,
    );
    check(
      "coverage-check skip: the response still carries all 3 primary findings",
      modelDerived(result.body?.insights).length === 3,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// ─── Fact vs risk discipline: the shared hard-rules block (used by both the
//     primary and coverage-check prompts) explicitly instructs the model not
//     to overstate a suspicious PATTERN as a confirmed fact. This is a
//     prompt-content assertion - the actual judgement is the model's, so
//     this pins that the instruction reaching the model is the corrected
//     one, which is what is actually within this codebase's control. ─────

{
  // A minimal single-insight response is enough; the assertion below reads
  // the prompt text captured by fetch, not this response.
  let capturedPrompt = "";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedPrompt =
      body.messages.find((m) => m.role === "user")?.content || "";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                result: "INSUFFICIENT_EVIDENCE",
                insufficientEvidenceReason:
                  "test probe, no real content needed",
                insights: [],
              }),
            },
          },
        ],
      }),
      text: async () => "",
    };
  };
  try {
    await callInsights({
      rawText:
        "Of these, 11 changes were made by the Payroll Executive using the Payroll Administrator login. The Payroll Manager stated that the Payroll Administrator was on leave during several of the dates shown in the report.",
      topicName: "Payroll",
    });

    check(
      "fact-vs-risk: the prompt distinguishes a confirmed fact from a suspected risk",
      /CONFIRMED FACT FROM A SUSPECTED RISK/i.test(capturedPrompt),
    );
    check(
      "fact-vs-risk: the prompt names 'verify' or 'assess' as the correct framing for an unconfirmed pattern",
      /verify whether/i.test(capturedPrompt) ||
        /assess the risk/i.test(capturedPrompt),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// ─── Dedup: three near-identical titles about the same Rs 2,50,000
//     unsupported accrual collapse to one, matching the real live-model
//     output pattern the human's critique named directly. ────────────────

const G17_PASSAGE = `Management Override [WP Ref: G-17]
Background: One entry dated 31 March 2025 debited Miscellaneous Expenses by Rs. 44,00,000. The remaining Rs. 2,50,000 has not been supported by documentation.
Findings: No evidence of independent review of the journal entry was available.`;

const THREE_NEAR_DUPLICATE_G17_FINDINGS = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Test unsupported Rs 2,50,000 accrual from manual journal entry",
      detail:
        "Test the Rs 2,50,000 unsupported portion of the manual journal entry under SA 240.",
      risk: "high",
      standard: "SA 240",
      evidence:
        "The remaining Rs. 2,50,000 has not been supported by documentation.",
    },
    {
      title: "Investigate unsupported Rs 2,50,000 accrual portion",
      detail:
        "Investigate the unsupported Rs 2,50,000 portion of the year-end accrual under SA 240.",
      risk: "high",
      standard: "SA 240",
      evidence:
        "The remaining Rs. 2,50,000 has not been supported by documentation.",
    },
    {
      title:
        "Evaluate manual journal entry for management override given Rs 2,50,000 unsupported",
      detail:
        "Evaluate the manual journal entry with the unsupported Rs 2,50,000 portion for management override risk under SA 240.",
      risk: "high",
      standard: "SA 240",
      evidence:
        "No evidence of independent review of the journal entry was available.",
    },
  ],
});

{
  responseQueue = [THREE_NEAR_DUPLICATE_G17_FINDINGS];
  // Short text (well under COVERAGE_CHECK_MIN_TEXT_LENGTH) so only one fetch
  // call happens; the dedup logic under test runs on the primary pass alone.
  const result = await callInsights({
    rawText: G17_PASSAGE,
    topicName: "Fraud",
  });

  const derived = modelDerived(result.body?.insights);
  // The human's own critique named exactly two of the three as duplicates
  // ("Test unsupported..." and "Investigate unsupported...", sharing one
  // evidence quotation) and the third as "different and useful" and
  // deserving to survive on its own - so the correct outcome is 2 survivors,
  // not 1: the true duplicate pair collapses, the genuinely distinct third
  // item stays.
  check(
    "dedup: the two true duplicates (same evidence quotation) collapse to one; the genuinely distinct third item survives separately",
    derived.length === 2,
    JSON.stringify(derived.map((i) => i.title)),
  );
  check(
    "dedup: the surviving duplicate-pair item is the first one submitted",
    derived[0]?.title ===
      "Test unsupported Rs 2,50,000 accrual from manual journal entry",
    derived[0]?.title,
  );
  check(
    "dedup: the genuinely distinct management-override item is NOT removed",
    derived.some((item) =>
      item.title.startsWith(
        "Evaluate manual journal entry for management override",
      ),
    ),
    JSON.stringify(derived.map((i) => i.title)),
  );
  check(
    "dedup: the near-duplicate 'Investigate unsupported...portion' item is removed",
    !derived.some(
      (item) =>
        item.title === "Investigate unsupported Rs 2,50,000 accrual portion",
    ),
    JSON.stringify(derived.map((i) => i.title)),
  );
}

// ─── Materiality-aware mandatory-procedure wording ──────────────────────

const WITH_STATED_MATERIALITY =
  "Materiality (Overall): Rs. 22,50,000 (1.5% of Revenue)\n\nSome audit-relevant text about revenue recognition timing that is long enough to be treated as real content for this test.";

const WITHOUT_STATED_MATERIALITY =
  "Some audit-relevant text about revenue recognition timing with no materiality figure stated anywhere in it at all.";

const INSUFFICIENT_EVIDENCE_RESPONSE = JSON.stringify({
  result: "INSUFFICIENT_EVIDENCE",
  insufficientEvidenceReason: "Too vague for a document-specific procedure.",
  insights: [],
});

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  const result = await callInsights({
    rawText: WITH_STATED_MATERIALITY,
    topicName: "Revenue",
  });

  const materialityItem = (result.body?.insights || []).find(
    (item) => item.title === "Determine materiality and sample basis",
  );
  check(
    "materiality-aware: a stated 'Materiality (Overall): Rs. 22,50,000' is quoted in the mandatory procedure's detail",
    materialityItem?.detail.includes("22,50,000"),
    materialityItem?.detail,
  );
  check(
    "materiality-aware: the detail distinguishes performance materiality from the overall figure",
    /performance materiality/i.test(materialityItem?.detail || ""),
    materialityItem?.detail,
  );
}

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  const result = await callInsights({
    rawText: WITHOUT_STATED_MATERIALITY,
    topicName: "Revenue",
  });

  const materialityItem = (result.body?.insights || []).find(
    (item) => item.title === "Determine materiality and sample basis",
  );
  check(
    "materiality-aware: no stated figure falls back to the original generic wording unchanged",
    materialityItem?.detail ===
      "Determine materiality and performance materiality for this area and document the basis for sample size and item selection.",
    materialityItem?.detail,
  );
}

// ─── The confirmations/representations mandatory procedures name the topic
//     rather than the generic "this area", when a topic was supplied. ────

{
  responseQueue = [INSUFFICIENT_EVIDENCE_RESPONSE];
  const result = await callInsights({
    rawText: WITHOUT_STATED_MATERIALITY,
    topicName: "Revenue Recognition",
  });

  const confirmationsItem = (result.body?.insights || []).find(
    (item) => item.title === "Obtain external third-party confirmations",
  );
  check(
    "materiality-aware: the confirmations procedure names the supplied topic rather than 'this area'",
    confirmationsItem?.detail.includes("Revenue Recognition"),
    confirmationsItem?.detail,
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
console.log(`\nAudit insights coverage and discipline: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
