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
//
// Added 2026-08-14, from a real live-model run against a genuine seven-issue
// statutory working paper (Stellar Textiles fixture below) that surfaced a
// sixth root cause the fixture above never exercised, because its passage is
// one continuous paragraph with no section structure:
//
//   M6  evidenceIsGrounded demanded ONE contiguous substring. A real working
//       paper's "Background: ... Findings: ... Conclusion: ..." layout means
//       the fact and the conclusion about it often sit in different
//       sections, so a model quoting both loses the whole evidence string -
//       5 of 6 real findings were silently discarded on first measurement.
//   M7  the model's own quote-character choice (straight single vs straight
//       double, or a curly variant) can legitimately differ from the
//       source's while quoting the exact same words, and the exact-substring
//       check treated that as a fabrication.
//
// Fixed by splitting evidence into sentence-like fragments and grounding each
// independently (resolveGroundedEvidence/splitEvidenceFragments), and by
// comparing fragments quote-blind (normalizeQuotesForComparison) while never
// rewriting what is actually displayed. Also added: workingPaperRef, a
// deterministic (regex/position, never model-trusted) lookup of the nearest
// preceding "[WP Ref: X-NN]" tag before an insight's evidence, matching the
// same convention this fixture's own documents already use.
//
//   B6  a multi-sentence evidence string spanning two labelled sections is
//       still accepted, with only the fragments that actually ground kept
//   B7  a real quote-character mismatch (model uses ' where source uses ")
//       no longer causes the whole evidence string to be rejected
//   B8  workingPaperRef resolves to the nearest preceding tag, is null when
//       the source has no such tags, and is never provided by the model

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

// O10 added a per-user/monthly/global spend quota at the callDeepSeek choke
// point (ProviderUsage.reserveProviderCall), backed by a real MongoDB
// collection there is no live connection to here. This suite tests evidence
// GROUNDING, not quota, so the increment is stubbed to always succeed -- see
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
  // This asserted `insights.length === 3` until the all-rejected path was routed through the same
  // response assembly as every other path. It now also carries the AA-01 coverage declaration,
  // which is the correct behaviour and was missing precisely here: a document whose every model
  // finding was rejected is the one most likely to leave matters unaddressed, and this path used to
  // say nothing about them at all. The assertion is kept but made specific, so it still fails if a
  // mandatory procedure goes missing rather than merely counting to a number.
  const b5Titles = (result.body?.insights ?? []).map((item) => item.title ?? "");
  check(
    "B5: the three mandatory procedures are still returned even when every model item is rejected",
    Array.isArray(result.body?.insights) &&
      b5Titles.filter((title) => /materiality|confirmation|representation/i.test(title))
        .length === 3,
  );
  check(
    "B5: the coverage declaration is present too, since nothing the model returned was usable",
    b5Titles.some((title) => /were not reviewed/i.test(title)),
  );
  check(
    "B5: every returned finding carries a status, on this path as on every other",
    (result.body?.insights ?? []).every(
      (item) => typeof item.status === "string" && item.status.length > 0,
    ),
  );
  check(
    "B5: the coverage object is present and does not claim completeness",
    result.body?.coverage !== undefined && result.body.coverage.complete === false,
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

// ─── B6/B7/B8: a real labelled working-paper fixture with non-contiguous
//     evidence and a genuine quote-character mismatch ──────────────────
//
// Modelled directly on the actual Stellar Textiles document that surfaced
// this defect: short sections tagged "[WP Ref: X-NN]", each with its own
// Background/Findings/Conclusion sentences, and a quoted term the model will
// legitimately re-quote with a different quote character.

const WORKING_PAPER_PASSAGE = `Trade Receivables — Provision for Doubtful Debts [WP Ref: A-01]
Background: Total trade receivables at year-end stand at Rs. 4,10,00,000. Of this, Rs. 62,00,000 is outstanding from a single customer, Vantage Garments LLC, overdue by more than 400 days. No provision has been made against this balance.
Findings: Credit control confirmed no realistic recovery plan exists. Management believes the amount will "eventually be settled through arbitration."
Preparer's Conclusion: Recoverability is doubtful based on evidence obtained; provisioning appears inadequate.

Journal Entry Testing — Reversing Entries at Quarter-End [WP Ref: F-06]
Background: Four manual journal entries totaling Rs. 41,00,000 were posted to "Other Income" on 30 September 2024 (Q2 close), all by the Deputy CFO. All four entries were reversed in the first week of October 2024.
Findings: No supporting documentation was available for any of the four entries at the time of testing.
Preparer's Conclusion: Indicators consistent with possible earnings management around interim reporting.`;

// Evidence spans two labelled sections of A-01: a Background sentence and a
// Findings sentence, with the section label and "Findings:" between them in
// the source - genuinely non-contiguous, exactly the shape that discarded
// real findings before this fix.
const NON_CONTIGUOUS_RESPONSE = JSON.stringify({
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
        "Rs. 62,00,000 is outstanding from a single customer, Vantage Garments LLC, overdue by more than 400 days. Credit control confirmed no realistic recovery plan exists.",
      why: "A large, long-overdue, disputed receivable with no recovery plan suggests the provision is understated.",
      nextAction: "If inadequate, propose an adjusting entry.",
    },
    // Quotes the same "Other Income" words the source wraps in double quotes,
    // but with straight single quotes - a real quote-character mismatch, not
    // a fabrication. Also spans Background + Findings, same non-contiguity.
    {
      title: "Investigate quarter-end reversing entries of Rs 41,00,000",
      detail:
        "Investigate the four manual journal entries totaling Rs 41,00,000 posted to Other Income and reversed in early October under SA 240.",
      risk: "high",
      standard: "SA 240",
      evidence:
        "Four manual journal entries totaling Rs. 41,00,000 were posted to 'Other Income' on 30 September 2024 (Q2 close), all by the Deputy CFO. No supporting documentation was available for any of the four entries at the time of testing.",
      why: "Quarter-end entries with no support and prompt reversal are a classic fraud indicator.",
      nextAction: "Obtain explanation from the Deputy CFO.",
    },
  ],
});

{
  nextResponse = NON_CONTIGUOUS_RESPONSE;
  const result = await callInsights({
    rawText: WORKING_PAPER_PASSAGE,
    topicId: null,
    topicName: null,
  });

  check("labelled fixture: HTTP 200", result.status === 200);
  check(
    "labelled fixture: not flagged insufficientEvidence",
    result.body?.insufficientEvidence !== true,
  );

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
    "B6: both non-contiguous, cross-section findings survive (not silently dropped)",
    modelDerived.length === 2,
    JSON.stringify(modelDerived.map((i) => i.title)),
  );

  const receivableItem = modelDerived.find((i) =>
    i.title.includes("62,00,000"),
  );
  check(
    "B6: the surviving evidence carries both fragments, joined with an elision marker",
    receivableItem?.evidence.includes("...") &&
      receivableItem.evidence.includes("Vantage Garments LLC") &&
      receivableItem.evidence.includes("no realistic recovery plan"),
    receivableItem?.evidence,
  );

  const journalItem = modelDerived.find((i) => i.title.includes("41,00,000"));
  check(
    "B7: evidence quoting 'Other Income' in single quotes still grounds against a source using double quotes",
    journalItem !== undefined,
    JSON.stringify(modelDerived.map((i) => i.title)),
  );
  check(
    "B7: the model's own single-quote choice is preserved verbatim in the displayed evidence, not silently rewritten",
    journalItem?.evidence.includes("'Other Income'"),
    journalItem?.evidence,
  );

  check(
    "B8: workingPaperRef resolves to the nearest preceding tag for each finding",
    receivableItem?.workingPaperRef === "A-01" &&
      journalItem?.workingPaperRef === "F-06",
    JSON.stringify({
      receivable: receivableItem?.workingPaperRef,
      journal: journalItem?.workingPaperRef,
    }),
  );

  const mandatoryItems = insights.filter((item) =>
    [
      "Determine materiality and sample basis",
      "Obtain external third-party confirmations",
      "Obtain written representations from management",
    ].includes(item.title),
  );
  check(
    "B8: the three mandatory procedures always carry workingPaperRef: null",
    mandatoryItems.every((item) => item.workingPaperRef === null),
    JSON.stringify(mandatoryItems.map((i) => i.workingPaperRef)),
  );
}

// ─── B8: no "[WP Ref: ...]" tag anywhere in the source ──────────────

{
  nextResponse = GROUNDED_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE, // the untagged fixture from the top of this file
    topicId: "Revenue",
    topicName: "Revenue Recognition",
  });

  const insights = Array.isArray(result.body?.insights)
    ? result.body.insights
    : [];
  check(
    "B8: workingPaperRef is null for every insight when the source has no WP Ref tags at all",
    insights.every((item) => item.workingPaperRef === null),
    JSON.stringify(insights.map((i) => i.workingPaperRef)),
  );
}

// ─── An evidence string with one fabricated fragment loses only that
//     fragment, not the whole finding ────────────────────────────────

const PARTIALLY_FABRICATED_RESPONSE = JSON.stringify({
  result: "SUPPORTED",
  insufficientEvidenceReason: "",
  insights: [
    {
      title: "Test the dispatch cut-off with a padded fabrication",
      detail:
        "Trace the Rs 18.5 lakh dispatch against the delivery request dates and the fabricated detail below.",
      risk: "high",
      standard: "SA 500",
      evidence:
        "Rs 18.5 lakh of goods dispatched on 31 March 2026 to two customers who had explicitly written requesting delivery only after 5 April, yet revenue was recognised in the year under audit. This sentence was never in the source text at all and is entirely fabricated.",
    },
  ],
});

{
  nextResponse = PARTIALLY_FABRICATED_RESPONSE;
  const result = await callInsights({
    rawText: REVENUE_PASSAGE,
    topicId: "Revenue",
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
    "a real fragment survives even when padded with one fabricated sentence",
    modelDerived.length === 1,
    JSON.stringify(modelDerived.map((i) => i.title)),
  );
  check(
    "the fabricated fragment is dropped from the displayed evidence, not merely tolerated",
    modelDerived[0] !== undefined &&
      !modelDerived[0].evidence.includes("never in the source text"),
    modelDerived[0]?.evidence,
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
