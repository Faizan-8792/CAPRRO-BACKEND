// src/controllers/audit.controller.js
// Hybrid NLP + DeepSeek LLM audit text classifier.
// Plus: insights generation, reminder message generation.

import {
  callDeepSeek,
  parseJsonObject,
  wasJsonTruncated,
} from "../services/deepseek-provider.service.js";
import { AUDIT_TOPIC_REFERENCE } from "../data/audit-topic-reference.js";

function safeStr(v, max = 4000) {
  return String(v ?? "").slice(0, max);
}

// Fix for W02 (agenttesting.md §24.1): deepseek-provider.service.js composes
// callDeepSeek's `reason` for an engineer reading server logs - "LLM HTTP 429:
// <raw upstream body>", "DEEPSEEK_API_KEY not configured", "LLM timeout" - and
// four routes here (refine, insights, reminder-message, standard-guidance)
// were returning that string verbatim as the client-facing `reason` field.
// Both clients then render it: the desktop's AuditAssistPolicy.ReasonMessage
// appends it after "Reason reported by the server: " with no filtering on
// this domain-level (200 + generated:false) path, which is a different code
// path from the transport-level AuditAssistPolicy.DescribeAssistFailure that
// already had a dedicated leak test. A status code or a provider name next to
// a chartered accountant's statutory working paper is exactly the class of
// string A-12.01 forbids everywhere else; `OCR_PROVIDER_ERROR` was already
// generalised for the same reason and this channel was missed.
//
// Recognises the same causes AuditAssistPolicy.Recognise already does on the
// desktop, so a server-side fix and a client-side fallback describe a given
// failure the same way rather than drifting. The raw reason is logged via
// console.error at each call site (already the case before this change) so
// the actual detail is never lost, only kept off the wire.
function publicLlmFailureReason(rawReason) {
  const message = String(rawReason ?? "");

  if (/not configured/i.test(message) || /API_KEY/i.test(message)) {
    return "The assistant has not been switched on for this server yet.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "The assistant took too long to answer.";
  }
  if (/no content|could not be read|parse/i.test(message)) {
    return "The assistant replied with nothing usable.";
  }
  if (/rate|too many/i.test(message) || /HTTP 429/i.test(message)) {
    return "The assistant is handling too many requests just now.";
  }
  if (/balance|quota|insufficient/i.test(message)) {
    return "The assistant's account on this server needs attention.";
  }
  if (/HTTP 5\d\d/i.test(message)) {
    return "The assistant's provider is temporarily unavailable.";
  }

  // Falls through honestly rather than guessing at an unrecognised cause -
  // matching AuditAssistPolicy.Recognise's own "General" fallback exactly.
  return "The server answered but could not produce a result.";
}

// Classification runs on the most accurate model by default. The classify call
// is short, so using the "pro" model keeps accuracy high at low cost, while
// insights and other longer calls use the cheaper general model. Both are
// env-configurable; a request may override the classifier model only within
// this allowlist (used for A/B evaluation).
const ALLOWED_LLM_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const CLASSIFIER_MODEL =
  process.env.DEEPSEEK_CLASSIFIER_MODEL || "deepseek-v4-pro";
// Raised from 3500 in lockstep with the desktop client's single-call cap
// (CaProApiClient.MaxAuditTextChars). Classification is not chunked client-side - a topic
// verdict does not decompose into several calls and merge the way a list of insights does -
// so this is the true ceiling on what /refine ever reads, not just a per-call slice.
const REFINE_TEXT_CAP = 12000;
// Insights use the fast model by default: it is reliable and low-latency for
// this longer generation, and the strengthened prompt (mandatory coverage +
// imperative framing) drives the quality. The higher-accuracy model is slower
// here and can time out on 6-8 detailed procedures. Override via
// DEEPSEEK_INSIGHTS_MODEL if desired.
const INSIGHTS_MODEL =
  process.env.DEEPSEEK_INSIGHTS_MODEL || "deepseek-v4-flash";

// Canonical audit-area taxonomy (mirrors the extension's data/topics.json ids).
// Used so the LLM can classify against ALL areas even when the local keyword
// engine returns weak or no candidates (broken/OCR/garbled text). If a caller
// sends its own catalog, that is used instead (keeps ids single-sourced).
// Kept in sync with audit-nlp-extension/data/topics.json's `id`/`display_name` pairs -
// this is the desktop and every other caller's only source for the catalogue, since
// neither client sends its own (see PLAN.md/mandatorycompletion.md T113). A topic added
// to that file without a matching entry here silently narrows what a desktop caller is
// offered relative to what the extension shows, which is exactly the drift this list
// exists to prevent.
export const AUDIT_TOPICS = [
  { id: "Inventory", name: "Inventory & Stock Audit" },
  { id: "Revenue", name: "Revenue Recognition" },
  { id: "Receivables", name: "Accounts Receivable" },
  { id: "Payables", name: "Accounts Payable & Provisions" },
  { id: "FixedAssets", name: "Property, Plant & Equipment" },
  { id: "CashBank", name: "Cash & Bank Balances" },
  { id: "IntangibleAssets", name: "Intangible Assets & Goodwill" },
  { id: "Borrowings", name: "Borrowings & Finance Costs" },
  { id: "Equity", name: "Equity & Reserves" },
  { id: "Tax", name: "Direct & Indirect Taxes" },
  { id: "Payroll", name: "Payroll & Employee Benefits" },
  { id: "RelatedParty", name: "Related Party Transactions" },
  { id: "GoingConcern", name: "Going Concern Assessment" },
  { id: "EventsAfter", name: "Events After Reporting Period" },
  { id: "Contingencies", name: "Contingent Liabilities & Commitments" },
  { id: "Segment", name: "Segment Reporting" },
  { id: "Consolidation", name: "Consolidation & Group Audit" },
  { id: "Fraud", name: "Fraud & Management Override" },
  { id: "InternalControls", name: "Internal Financial Controls" },
  { id: "CSR", name: "Corporate Social Responsibility" },
  { id: "Investments", name: "Investments" },
  { id: "Derivatives", name: "Financial Instruments & Derivatives" },
  { id: "GovtGrants", name: "Government Grants & Subsidies" },
  { id: "Forex", name: "Foreign Exchange Transactions" },
  { id: "CashFlow", name: "Cash Flow Statement" },
  { id: "IndAS101", name: "First-time Adoption of Ind AS" },
  { id: "GeneralAudit", name: "General Audit Methodology" },
];

function catalogFromRequest(reqCatalog) {
  if (Array.isArray(reqCatalog) && reqCatalog.length) {
    const seen = new Set();
    const out = [];
    for (const t of reqCatalog) {
      const id = typeof t?.id === "string" ? t.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: safeStr(t.name || t.display_name || id, 80) });
      if (out.length >= 60) break;
    }
    if (out.length) return out;
  }
  return AUDIT_TOPICS;
}

function buildRefinePrompt(rawText, candidates, catalog) {
  const catalogBlock = catalog.map((t) => `- ${t.id}: ${t.name}`).join("\n");
  const hintsBlock = (candidates || [])
    .filter((c) => c && c.id)
    .map((c) => `${c.id} (nlp ${c.score ?? "?"}/${c.hits ?? 0} hits)`)
    .join("; ");

  return `You are a senior Indian Chartered Accountant classifying a snippet of text into ONE audit/accounting area.

The text may be messy: OCR errors, broken grammar, no punctuation, ALL CAPS, misspellings, shorthand/abbreviations, or a Hindi-English (Hinglish) mix. Read PAST these problems and infer the true meaning. Never reject text just because it is poorly written or incomplete.

Decide:
1) isAuditText — true ONLY if the text is genuinely about auditing, accounting, finance, tax, or statutory compliance. Set false for unrelated content (jobs, news, recipes, travel, marketing, chit-chat), even if a stray finance-sounding word appears incidentally.
2) chosenId — when isAuditText is true, the SINGLE best-matching audit-area id from the list below. Choose the closest area even if the wording is imperfect. Only use null if it is audit text but genuinely no area fits.

AUDIT AREAS (chosenId MUST be exactly one of these ids):
${catalogBlock}

LOCAL ENGINE HINTS (a keyword tool's guesses; may be wrong, weak, or empty — use only as a faint hint, do not over-trust): ${hintsBlock || "(none)"}

confidence: 0.0 to 1.0, your honest certainty. Be strict; do not inflate.
reason: ONE short phrase, at most 15 words. Do not write paragraphs.

Respond with ONLY this compact JSON on a single line (no markdown, no commentary):
{"isAuditText": boolean, "chosenId": string|null, "confidence": number, "reason": string}

TEXT:
"""
${safeStr(rawText, REFINE_TEXT_CAP)}
"""`;
}

export async function refineAuditClassification(req, res, next) {
  try {
    const { rawText, candidates, catalog, model } = req.body || {};

    if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
      return res.status(400).json({ ok: false, error: "rawText required" });
    }
    // Classifier runs on the accuracy-focused model by default; a request may
    // override it only within the allowlist (A/B evaluation).
    const classifierModel = ALLOWED_LLM_MODELS.has(model)
      ? model
      : CLASSIFIER_MODEL;
    // Candidates are an optional hint now: broken/garbled text may produce none,
    // and we still classify against the full audit-area catalog below.
    const cands = Array.isArray(candidates) ? candidates : [];

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        ok: true,
        refined: false,
        reason: "DEEPSEEK_API_KEY not configured on server",
      });
    }

    const topicCatalog = catalogFromRequest(catalog);
    const prompt = buildRefinePrompt(rawText, cands, topicCatalog);
    const r = await callDeepSeek({
      system:
        "You are a strict JSON-only audit-text classifier for Indian Chartered Accountants. Output only valid JSON, no extra text.",
      prompt,
      jsonResponse: true,
      maxTokens: 900,
      temperature: 0,
      model: classifierModel,
    });

    if (!r.ok) {
      console.error("DeepSeek refine error:", r.reason);
      return res.json({
        ok: true,
        refined: false,
        reason: publicLlmFailureReason(r.reason),
        model: classifierModel,
      });
    }

    const parsed = parseJsonObject(r.content);
    if (!parsed) {
      return res.json({
        ok: true,
        refined: false,
        reason: "Could not parse LLM response",
      });
    }

    const isAuditText = parsed.isAuditText === true;
    const chosenIdRaw =
      typeof parsed.chosenId === "string" ? parsed.chosenId.trim() : null;
    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null;
    const reason = safeStr(parsed.reason, 500);

    // Validate against the FULL catalog (not just the local candidates) so the
    // LLM can correctly pick an area the keyword engine missed.
    const validIds = new Set(topicCatalog.map((t) => t.id));
    const chosenId =
      isAuditText && chosenIdRaw && validIds.has(chosenIdRaw)
        ? chosenIdRaw
        : null;

    return res.json({
      ok: true,
      refined: true,
      isAuditText,
      chosenId,
      confidence: confidence ?? (isAuditText ? 0.6 : 0.1),
      reason,
      model: classifierModel,
    });
  } catch (err) {
    console.error("refineAuditClassification error:", err);
    next(err);
  }
}

// ─── AI Insights ────────────────────────────────────────────────────
//
// Redesigned under Phase B of EXTENSION-DESKTOP-FEATURE-PARITY.md §4-5 (B1-B5),
// which traced a human-supplied revenue cut-off passage rated 6/10 to four
// independent root causes in the previous version of this endpoint - not a
// prompt-tuning problem:
//
//   M1  three mandatory boilerplate procedures consumed up to 7 of 8 slots
//   M2  grounding was one sentence of prose; nothing could verify a citation
//   M3  maxTokens truncation was silently repaired, discarding the tail -
//       which was always the document-specific findings, since the boilerplate
//       is emitted first
//   M4  the model saw only rawText + a topic label, never the packaged
//       procedures/mistakes the extension already computes for /refine
//
// Fixed by, respectively: moving the three mandatory procedures to a
// deterministic block the model never has to produce (buildMandatoryProcedures);
// requiring a verbatim evidence span per procedure and rejecting any that is not
// actually in the text the model was sent (evidenceIsGrounded); reporting
// truncation instead of hiding it (wasJsonTruncated); and sending the packaged
// reference procedures/mistakes for the resolved topic so the model selects and
// evidences rather than re-deriving generically (packagedContextFor).

// Requested from the model. Kept deliberately small: the three universal
// procedures no longer come from here, and an evidence-grounded set is a
// higher bar than an ungrounded one at any size.
//
// Raised from "4 to 6"/6/9 (2026-08-14, agent-testing dense-document pass):
// a real seven-issue statutory working paper (Stellar Textiles fixture)
// showed the model already proposing all seven document-specific findings
// within the old ceiling's neighbourhood, but the ceiling itself meant an
// eighth or ninth genuinely distinct, evidence-grounded finding on a dense
// document had nowhere to go. maxTokens below is raised in step so the extra
// headroom is real rather than nominal.
const MODEL_INSIGHT_TARGET = "4 to 8";
const MAX_MODEL_INSIGHTS = 8;
// New genuinely-uncovered findings the coverage-check pass (see
// buildCoverageCheckPrompt) may contribute on top of the primary pass. Kept
// smaller than MAX_MODEL_INSIGHTS: a well-run primary pass should already
// find most of what a document has, so a second pass finding more than a
// handful more is unusual, and an unbounded second pass would make the
// response length unpredictable for a reviewer.
const MAX_COVERAGE_MODEL_INSIGHTS = 4;
const MAX_TOTAL_INSIGHTS = 15; // 3 deterministic + up to 8 primary + up to 4 coverage-check
// Raised from 3500 (2026-08-13, agent-testing feature request) to shrink how much of a long
// document went unseen and unexamined by a single call. Desktop-side chunking (see
// CaPro.Desktop.Core.Audit.AuditAssistanceService.GetInsightsForTextAsync) is what now carries
// text longer than this over several sequential calls rather than truncating or refusing it -
// this constant is still what any ONE of those calls, or a single short document, is capped at.
// The extension's REVIEWED_TEXT_DISPLAY_CAP (audit-render.js) must be kept equal to this value;
// tests/audit-render-text-cap.focused.mjs in the extension asserts that.
const INSIGHTS_TEXT_CAP = 12000;
const MIN_EVIDENCE_LENGTH = 6;
const MAX_EVIDENCE_LENGTH = 400;

// Every "detail" must open with one of these, checked against its first word.
// A closed, testable set rather than free-form verb detection, mirroring the
// prompt's own "starting with a verb such as..." instruction - the model is
// told the set it will be held to.
const IMPERATIVE_VERBS = new Set([
  "OBTAIN",
  "INSPECT",
  "CONFIRM",
  "RECOMPUTE",
  "RECALCULATE",
  "TRACE",
  "VOUCH",
  "PERFORM",
  "RECONCILE",
  "ASSESS",
  "EVALUATE",
  "TEST",
  "DETERMINE",
  "SELECT",
  "SEND",
  "REQUEST",
  "VERIFY",
  "REVIEW",
  "EXAMINE",
  "ANALYSE",
  "ANALYZE",
  "COMPARE",
  "AGREE",
  "DISCUSS",
  "CORROBORATE",
  "ASCERTAIN",
  "IDENTIFY",
  "ENSURE",
  "VALIDATE",
  // Added 2026-08-14: the prompt's own instruction lists these as "a verb
  // such as..." - illustrative, not exhaustive - but the set enforcing it
  // was closed. Measured directly against a real live-model run on a
  // seven-issue statutory working paper (Stellar Textiles fixture): the
  // model opened one finding's detail with "Quantify" (extending a sampled
  // FX-rate error to the full population, a genuine audit procedure) and
  // another with "Investigate" (a quarter-end journal-entry reversal with no
  // supporting documentation - a textbook fraud-indicator procedure, not
  // management commentary). Both findings were silently discarded over a
  // word the prompt never actually forbade. Added only these two, rather
  // than guessing at a longer list: each is confirmed by a real model
  // response, not speculated.
  "INVESTIGATE",
  "QUANTIFY",
]);

// Matches a stated overall-materiality figure anywhere in the source, e.g.
// "Materiality (Overall): Rs. 22,50,000" or "Overall Materiality: Rs 32,00,000".
// Deliberately anchored on the word "materiality" within 80 characters of a
// rupee figure, rather than the bare RUPEE_AMOUNT_PATTERN used for per-insight
// evidence - this one is scanned against the WHOLE document, and an unanchored
// version would as happily match the first amount mentioned anywhere near the
// word "material" in an unrelated sentence.
const MATERIALITY_STATEMENT_PATTERN =
  /materiality[^.\n]{0,80}?(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh|lakhs|crore|crores)?/i;

// Deterministic (non-LLM), same principle as extractRupeeMinorFromEvidence:
// whether a document states an overall materiality figure is a fact about the
// document, not something a model should be asked to notice or restate. Root
// fix for the mandatory materiality procedure reading as fully generic
// ("Determine materiality...") even when the working paper already states one
// on its cover page - the model was never shown this because it is asked to
// select and evidence document-specific FINDINGS, not to read the document's
// own header block.
function extractStatedMateriality(rawText) {
  const match = MATERIALITY_STATEMENT_PATTERN.exec(String(rawText || ""));
  if (!match) return null;

  const numeral = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(numeral) || numeral <= 0) return null;

  const unit = match[2] ? match[2].toLowerCase() : null;
  const scale = unit && unit.startsWith("crore") ? 10000000 : unit ? 100000 : 1;
  const rupees = numeral * scale;
  if (!Number.isFinite(rupees) || rupees > 10000000000) return null;

  // Whole rupees, not minor units: this is used only to build a prose sentence
  // below, never compared against another minor-unit figure, so there is no
  // reason to introduce paise here.
  return Math.round(rupees);
}

function formatRupeesForSentence(rupees) {
  return rupees.toLocaleString("en-IN");
}

// Root fix for a human reviewer's own critique, measured across several real
// audits: "the tool repeatedly adds SA 320/530 materiality, SA 505
// confirmations, and SA 580 management representations even when they are
// not specifically required for that audit area." Forcing all three into
// EVERY response regardless of subject matter is boilerplate precisely
// because real audit practice does not treat them as interchangeable
// universals:
//
//   - SA 320/530 (materiality and sample basis) genuinely IS universal: SA
//     320 requires a materiality determination for every audit, and it
//     scopes every substantive procedure regardless of area. This one stays
//     unconditional - that is a considered decision, not an oversight, and
//     is why only the other two gained a relevance check below.
//   - SA 505 (external confirmations) only applies when the finding
//     actually involves an outside party - a bank, customer, supplier,
//     lender, subsidiary, or similar. A payroll ghost-employee test, a
//     depreciation recompute, or a CSR spend check has no third party to
//     confirm anything with.
//   - SA 580 (written representations) is the residual evidence source for
//     something the auditor cannot independently verify - a management
//     estimate, a completeness assertion, a going-concern judgment, a
//     related-party disclosure. A purely mechanical vouch-and-recompute
//     finding does not need a fresh representation asked of management.
//
// Relevance for both conditional items is decided on TWO independent
// signals, either of which is enough: (1) the resolved topic is one where
// this procedure is standard practice for that whole audit area, or (2) the
// findings THIS run actually produced mention a third party / cite an
// estimate-flavoured standard - a real, content-driven signal from what was
// actually found, not just a static guess from the topic label alone. A
// topic not on either list still gets the item if its own evidence justifies
// it, and a listed topic still gets it even when no document-specific
// insight survived (the topic-level signal does not require content).
const THIRD_PARTY_CONFIRMATION_TOPICS = new Set([
  "Revenue", // customer confirmations for terms - explicitly in this topic's own reference procedures
  "Receivables", // customer balance confirmations
  "Payables", // vendor balance confirmations
  "CashBank", // bank balance confirmations
  "Borrowings", // bank/lender confirmations for loans
  "RelatedParty", // outstanding balance confirmation with the related party
  "Investments", // registrar/broker/depository confirmations
  "Derivatives", // counterparty confirmations
  "Consolidation", // subsidiary/associate auditor confirmations
  "GoingConcern", // lender/facility confirmation of renewal terms or a covenant waiver
  "Inventory", // third-party-held stock confirmations
  "GeneralAudit", // catch-all bucket; stays inclusive rather than silently narrowing an unresolved topic
]);

const THIRD_PARTY_EVIDENCE_PATTERN =
  /\b(banks?|customers?|suppliers?|vendors?|lenders?|creditors?|debtors?|borrowers?|subsidiar(?:y|ies)|associates?|related[- ]part(?:y|ies)|depositors?|guarantors?|job[- ]?workers?|counterpart(?:y|ies)|dealers?)\b/i;

const SA_505_CITATION_PATTERN = /\bSA\s*505\b/i;

// Measured live against a real fixture (a payroll finding naming a specific
// outsourced vendor, "Meridian HR Services", by name only - no generic
// noun like "vendor" or "supplier" anywhere near it): the prose-keyword
// signal above missed it entirely, because a proper noun carries no generic
// third-party word for the pattern to match. The MODEL ITSELF had already
// recognised this as a confirmation-worthy finding and cited SA 505 on its
// own model-derived insight - a far more precise, low-false-positive signal
// than re-scanning free text for nouns, since it is the same standard-
// citation discipline insightsHardRulesBlock already holds the model to.
// Checked FIRST, before the prose fallback, for exactly that reason.
function isConfirmationRelevant(topicId, evidencedInsights) {
  if (THIRD_PARTY_CONFIRMATION_TOPICS.has(topicId)) return true;
  if (
    evidencedInsights.some((item) =>
      SA_505_CITATION_PATTERN.test(item.standard || ""),
    )
  )
    return true;
  return evidencedInsights.some(
    (item) =>
      THIRD_PARTY_EVIDENCE_PATTERN.test(item.evidence || "") ||
      THIRD_PARTY_EVIDENCE_PATTERN.test(item.detail || ""),
  );
}

const MANAGEMENT_ESTIMATE_OR_COMPLETENESS_TOPICS = new Set([
  "Revenue", // variable-consideration estimates, completeness of side agreements
  "Payables", // accruals and contingent-liability completeness
  "Contingencies",
  "GoingConcern",
  "EventsAfter",
  "RelatedParty", // completeness of related-party disclosure
  "FixedAssets", // impairment judgment
  "IntangibleAssets", // goodwill impairment judgment
  "Investments", // impairment / fair-value judgment
  "Tax", // deferred-tax-asset realisability judgment
  "Borrowings", // covenant classification judgment
  "Fraud", // inherently about management's own conduct
  "Equity", // completeness of dividend declaration
  "CSR", // judgment on unspent-amount treatment
  "GeneralAudit",
]);

const ESTIMATE_OR_COMPLETENESS_STANDARD_PATTERN =
  /\bSA\s*540\b|\bSA\s*570\b|\bSA\s*550\b|\bSA\s*240\b/i;

function isRepresentationRelevant(topicId, evidencedInsights) {
  if (MANAGEMENT_ESTIMATE_OR_COMPLETENESS_TOPICS.has(topicId)) return true;
  return evidencedInsights.some((item) =>
    ESTIMATE_OR_COMPLETENESS_STANDARD_PATTERN.test(item.standard || ""),
  );
}

// The materiality procedure is unconditional (see above); confirmations and
// representations are now gated by isConfirmationRelevant/isRepresentationRelevant.
// evidence is deliberately empty on every item here: these are standard-mandated
// or relevance-gated, never derived from a specific document quotation, and an
// empty evidence field says that honestly rather than inventing one.
//
// rawText is read ONLY to check for a stated overall-materiality figure
// (extractStatedMateriality), which is deterministic string matching against
// the document's own header, not model output - amountMinor stays null
// regardless, so the existing "every mandatory procedure carries amountMinor:
// null" invariant is unaffected; only the materiality item's prose changes.
//
// topicLabel names the audit area in the confirmations/representations items
// rather than the vague "this area", when a caller supplied or resolved one -
// falls back to the previous generic wording when it did not. topicId drives
// the relevance decision itself and is separate from topicLabel because a
// caller may send a free-form topicName with no catalogue-matched topicId at
// all, in which case relevance falls back to the content signal alone.
// evidencedInsights is the combined, already-validated primary-plus-coverage
// list for THIS run - empty for a caller with no accepted insights yet (the
// INSUFFICIENT_EVIDENCE and all-rejected paths), which is correct: with
// nothing accepted, only the topic-level signal can justify relevance.
function buildMandatoryProcedures(
  rawText,
  topicLabel,
  topicId = null,
  evidencedInsights = [],
) {
  const statedMateriality = extractStatedMateriality(rawText);
  const materialityDetail = statedMateriality
    ? `This working paper states overall materiality as Rs ${formatRupeesForSentence(statedMateriality)}. Confirm performance materiality is documented separately (typically a proportion of the overall figure, not the same number) and use it, not the overall figure, as the basis for sample size and item selection.`
    : "Determine materiality and performance materiality for this area and document the basis for sample size and item selection.";
  const materialityNextAction = statedMateriality
    ? "Confirm the performance materiality figure is documented, then record the sample basis before testing individual items."
    : "Record the materiality figure and sample basis in the working paper before testing individual items.";

  const areaLabel =
    typeof topicLabel === "string" && topicLabel.trim().length > 0
      ? topicLabel.trim()
      : "this area";

  const procedures = [
    {
      title: "Determine materiality and sample basis",
      detail: materialityDetail,
      risk: "medium",
      standard: "SA 320, SA 530",
      evidence: "",
      why: "Materiality sets the threshold for what counts as a significant misstatement, so every other procedure in this area is scoped against it.",
      nextAction: materialityNextAction,
      amountMinor: null,
      workingPaperRef: null,
    },
  ];

  if (isConfirmationRelevant(topicId, evidencedInsights)) {
    procedures.push({
      title: "Obtain external third-party confirmations",
      detail: `Obtain external third-party confirmations for balances, holdings or amounts in ${areaLabel} that involve outside parties such as banks, customers, suppliers, job-workers or lenders.`,
      risk: "medium",
      standard: "SA 505",
      evidence: "",
      why: "A confirmation received directly from the third party is stronger evidence than internal correspondence, because it cannot be influenced by company management.",
      nextAction:
        "If a confirmation cannot be obtained, perform alternative procedures and document why the confirmation was unavailable.",
      amountMinor: null,
      workingPaperRef: null,
    });
  }

  if (isRepresentationRelevant(topicId, evidencedInsights)) {
    procedures.push({
      title: "Obtain written representations from management",
      detail: `Obtain written representations from management covering the completeness and key assertions of ${areaLabel}.`,
      risk: "medium",
      standard: "SA 580",
      evidence: "",
      why: "A written representation records management's acknowledgement of responsibility and does not replace other audit evidence.",
      nextAction:
        "File the signed representation with the working papers before forming a conclusion on this area.",
      amountMinor: null,
      workingPaperRef: null,
    });
  }

  return procedures;
}

// Best-effort match from a free-form topic name to one of AUDIT_TOPICS, used
// only when a caller (the desktop today) sends topicName without topicId.
function resolveTopicIdFromName(topicName) {
  const needle = String(topicName || "")
    .trim()
    .toLowerCase();
  if (!needle) return null;
  const exact = AUDIT_TOPICS.find(
    (t) => t.id.toLowerCase() === needle || t.name.toLowerCase() === needle,
  );
  if (exact) return exact.id;
  const partial = AUDIT_TOPICS.find(
    (t) =>
      needle.includes(t.name.toLowerCase()) ||
      t.name.toLowerCase().includes(needle),
  );
  return partial ? partial.id : null;
}

// The packaged procedures/mistakes for a topic, or null when nothing resolves.
// Fix for M4: the model is starved of context the system already has, because
// /insights previously received only rawText + a topic label while /refine
// already receives this same reference data computed by the extension. Rather
// than depend on the caller to forward it, the server holds its own trimmed
// copy (src/data/audit-topic-reference.js) so every caller benefits, including
// the desktop, which does not compute this itself.
function packagedContextFor(topicId, topicName) {
  const resolvedId =
    (typeof topicId === "string" && AUDIT_TOPIC_REFERENCE[topicId]
      ? topicId
      : null) || resolveTopicIdFromName(topicName);
  if (!resolvedId) return null;
  const reference = AUDIT_TOPIC_REFERENCE[resolvedId];
  if (!reference) return null;
  return {
    topicId: resolvedId,
    procedures: reference.procedures,
    mistakes: reference.mistakes,
  };
}

// Selects and formats the packaged reference procedures/mistakes for a topic
// into the prompt block both the primary and coverage-check prompts share.
// Factored out so the two prompts cannot silently drift into two different
// wordings of the same instruction.
function packagedContextBlock(packaged) {
  return packaged
    ? `\nKNOWN PROCEDURES for this audit area (select the ones THIS text actually supports; do not just restate all of them):\n${packaged.procedures.map((p) => `- ${p}`).join("\n")}\n\nKNOWN COMMON MISTAKES for this audit area (check whether THIS text shows evidence of any of these):\n${packaged.mistakes.map((m) => `- ${m}`).join("\n")}\n`
    : "";
}

// The rules and output schema shared by the primary generation pass and the
// coverage-check pass below. Factored into one function so the two prompts
// are held to literally the same bar for evidence, imperative phrasing,
// standard selection and fact-versus-risk discipline - a second copy that
// drifts from the first would let the coverage pass accept something the
// primary pass would have rejected, or vice versa.
//
// Restructured 2026-08-14 around a human reviewer's cross-audit critique
// (five to six real runs reviewed): the tool's core issue-detection was
// judged strong, but it consistently (1) jumped from evidence straight to a
// conclusion without stating what the evidence actually establishes versus
// merely suggests, (2) collapsed a control deficiency, a fraud RISK
// indicator, and confirmed fraud/misstatement into one tier of language,
// (3) recommended procedures a document's own "Procedures Performed"
// section already states were done, (4) cited amounts without explaining
// performance-materiality significance or separating genuinely misstated
// amounts from correctly-recorded ones nearby, and (5) assumed a specific
// accounting standard (Ind AS 115/2/10, SA 540) applies without the source
// text actually stating that framework, sometimes reclassifying a plain
// cut-off issue as an estimate or subsequent-event issue in the process.
// The REASONING PIPELINE and SELF-CHECK sections below target each of
// these directly; the rest of the hard rules are the prior discipline this
// builds on, not a replacement for it.
//
// Extended again 2026-08-14 following a direct capability scorecard from
// the human - ten specific capabilities individually rated, not a review of
// free-form output. Contradictory-evidence handling, related-party
// technical judgment, going-concern judgment, subsequent-event detection,
// avoiding generic procedures and knowing when NOT to conclude were all
// rated "needs improvement" or worse, with subsequent-event detection the
// single worst ("major gap demonstrated"). None of these six needed a new
// mechanism: the FRAMEWORK/STANDARD SELECTION rule already told the model
// to CITE SA 560/570/550 for three of them, but never told it HOW to apply
// the judgment those standards actually require, and the self-check never
// asked about internal contradictions, evidence specificity, or permission
// to produce fewer findings than the target. SUBSEQUENT EVENTS, GOING
// CONCERN INDICATORS and RELATED PARTY JUDGMENT below turn a one-line
// citation instruction into the actual SA 560/570/550 judgment framework -
// an adjusting-vs-non-adjusting test, the standard financial/operating/
// other indicator taxonomy, and arm's-length/approval/disclosure-
// completeness respectively - each applied regardless of the stated topic,
// since all three can surface unexpectedly in any audit area (a
// receivables review can turn up a covenant breach or a director loan just
// as easily as a dedicated going-concern or related-party review). Two new
// hard rules (CONTRADICTORY EVIDENCE, NAME THE SPECIFIC MISSING EVIDENCE)
// plus a fourth self-check question cover the other three. Knowing when
// NOT to conclude is fixed in two places: a new hard rule making omission
// the explicitly correct choice for a borderline non-finding, and (see
// buildInsightsPrompt below) porting the "do not force one" permission
// that previously existed only in buildCoverageCheckPrompt into the
// PRIMARY prompt as well - that asymmetry meant the first, most heavily
// used pass had no permission to admit a section needed nothing beyond the
// mandatory items, while the second pass already did.
function insightsHardRulesBlock() {
  return `REASONING PIPELINE — work through these steps for each candidate finding before writing it. The output only has one "detail" field, but the steps below decide what that field is allowed to say:
1. EVIDENCE: the exact passage in the text that triggered your attention.
2. WHAT IS ACTUALLY ESTABLISHED: restate, in your own words, only what this passage proves on its own — no inference yet. A control deficiency ("no independent review of a journal entry") is established by an absence-of-control statement; a suspicious PATTERN ("an unusual login while its holder was away") is established only as a pattern, not as proof anyone did anything wrong.
3. RISK: what could this mean if the underlying cause turns out to be the worst plausible explanation? State the risk as a possibility ("could indicate...", "is consistent with...") — this step is where a risk is named, never where it is confirmed.
4. EVIDENCE GAP: what specific, additional evidence would confirm or rule out the risk named in step 3? This is what the procedure you recommend must actually close — not a generic textbook procedure for the topic area, but the one piece of missing information this specific finding needs.
5. MATERIALITY: is the amount involved, if any, large enough next to overall/performance materiality to matter on its own, or is it only significant in combination with something else? Do not silently add this amount to a DIFFERENT, correctly-recorded transaction's amount to produce a bigger headline figure — an amount that is proven correct is not part of a misstatement total.
6. CLASSIFICATION: pick exactly ONE tier for the risk named in step 3, and hold it there for the rest of the finding:
   - "control deficiency" — a process/control weakness the text describes (missing review, missing approval, missing segregation of duties), with NO stated indication that anyone actually misused it.
   - "fraud risk indicator" — a pattern that COULD be exploited for fraud (unusual timing, an unusual login, pressure language, related-party terms) but the text does not say the underlying act was confirmed.
   - "confirmed misstatement" or "confirmed non-compliance" — ONLY when the text itself states the outcome was already established (an amount already found wrong, a rule already found breached), not merely suspected.
   Never write wording from a lower tier as if it were a higher one. "A control deficiency" must never be described using fraud-toned language ("the fraudulent transfer", "management's deception"); a "fraud risk indicator" must never be described as if confirmed ("investigate the unauthorized changes" implies they already ARE unauthorized — write "verify whether the changes were authorized" instead).
7. REQUIRED NEXT PROCEDURE: the imperative action that closes the evidence gap from step 4 — this becomes "detail". It must be the procedure this document's own gap needs, not a generic procedure for the topic that this document has already satisfied elsewhere (see "PROCEDURES ALREADY PERFORMED" below, when present).
8. CONCLUSION: the "why" and "nextAction" fields state what happens once the procedure in step 7 resolves the gap — not a foregone conclusion about what the answer will turn out to be.

SELF-CHECK — before including a finding in your output, answer these three questions; if the answer to any is "no", revise or drop the finding rather than including it as-is:
- "Has this procedure already been performed?" Check the PROCEDURES ALREADY PERFORMED block below (when present) and the text's own Procedures/Work-performed narrative. If the specific check you were about to recommend is already described as done, do not recommend it again — recommend only what its outcome left unresolved.
- "Is this procedure actually necessary for THIS specific risk?" A textbook list of standard procedures for a topic area is not a substitute for one procedure that closes THIS finding's specific evidence gap. Do not add a procedure only because it is customary for the topic if this particular finding does not need it.
- "Is my conclusion directly supported by the evidence?" Re-read step 2 above: if your "detail" states something as an established fact that step 2 only established as a pattern or a possibility, rewrite it down a tier rather than leaving the overstatement in.
- "Does this finding contradict another finding I am about to produce, or a statement made elsewhere in this same text — including management's own stated position?" Two passages that cannot both be true at once (a stated cause that conflicts with a stated effect, a stated policy that conflicts with a stated practice, a control described as operating that a later passage shows was overridden) are themselves the finding. See CONTRADICTORY EVIDENCE below for how to write it.
- "Am I including this finding because the evidence genuinely supports it, or to reach the target count?" If the honest answer is the second, drop it. A shorter, well-evidenced list is the correct and expected result for a short, narrow, or single-issue document — never force a weak or repetitive finding just to produce more of them. See "it is correct to produce fewer findings" below.

Hard rules:
- Each "detail" MUST be an audit procedure phrased as an imperative action, starting with a verb such as Obtain, Inspect, Confirm, Recompute, Trace, Vouch, Perform, Reconcile, Assess, Evaluate, Test, Determine, Select, Verify, Review, Examine, Request, Investigate or Quantify. Never write business or management advice.
- SURFACE THE EXACT FIGURE, NOT A VAGUE REFERENCE: when the text states a specific amount, party name, day count or date, the "title" and "detail" MUST quote that figure directly instead of a vague phrase. Write "Evaluate adequacy of provision for the Rs 62,00,000 receivable from Vantage Garments LLC, overdue 400+ days" — never "Evaluate adequacy of provision for the receivable". A reviewer scanning the list must see the stakes without re-opening the source text.
- STATE AN ALREADY-REACHED CONCLUSION AS A FACT, NOT AN OPEN QUESTION: if the text itself already states a finding, determination or conclusion (for example "credit control confirmed no recovery plan exists", "management decided X"), the "detail" MUST state that finding as an established fact (wording such as "has confirmed", "appears inadequate", "was already determined") and then name the next verification or escalation step. Do not phrase an already-reached conclusion as something that still needs open-ended "assessment" from zero — that understates what the source material already established. This rule is about HOW MUCH the text already established (step 2 of the pipeline above), never about which classification tier (step 6) it belongs to — an already-established control deficiency is still only a "control deficiency", stated as a fact, not automatically promoted to fraud.
- DISTINGUISH A CONFIRMED FACT FROM A SUSPECTED RISK — do not overstate a pattern as a proven conclusion: if the text shows a PATTERN consistent with a risk (an unusual login used while its usual holder was away, a transaction structured in an unusual way, a payment near a threshold) but nothing in the text says the underlying wrongdoing was actually confirmed, phrase the finding as something to VERIFY or ASSESS ("verify whether the changes were authorized", "assess the risk that..."), never as an established fact ("investigate the unauthorized changes", "the fraudulent transfer"). Reserve fact-stating language (see the rule above) strictly for things the text itself already says were confirmed, found, or decided — a suspicious pattern is evidence toward a risk, not proof of one.
- CONTRADICTORY EVIDENCE — when two passages in the text cannot both be fully true (a stated cause conflicts with a stated effect; a control is described as operating and a later passage shows it was bypassed; management states one position and a different passage shows the opposite; a total does not reconcile with the items said to make it up), do NOT silently pick the passage that sounds more serious and ignore the other, and do NOT average or blend them into one smoothed-over statement. Write the finding so BOTH passages are quoted or named, state plainly that they conflict, and make the required procedure the act of resolving the conflict itself (for example "reconcile the two figures and determine which is correct", "obtain an explanation from management for the discrepancy between X and Y", "corroborate the [later/more authoritative] version with independent evidence before relying on it"). The contradiction is frequently the finding in its own right, not noise to resolve before writing one.
- FRAMEWORK / STANDARD SELECTION — cite the standard or accounting framework that actually governs the activity described, and NEVER cite a specific accounting standard (Ind AS 115, Ind AS 2, Ind AS 10, or similarly specific standards) unless the text itself states or clearly implies which financial reporting framework the entity follows. When no framework is stated, cite the AUDITING standard that governs the PROCEDURE (SA numbers govern how the auditor tests something, and apply regardless of which accounting framework the entity itself follows), and leave the accounting-standard citation as an empty or generic reference rather than guessing a specific Ind AS number:
  - A plain timing/cut-off issue (a transaction recorded in the wrong period, with no accounting judgment involved) → SA 500 (audit evidence) or SA 330 (test of details on the timing), NOT SA 540 and NOT reclassified as an accounting-estimate issue or a subsequent-events issue merely because a date is involved. Only cite SA 540 when the finding is actually about an ESTIMATE (a provision, an impairment, a fair value) — not every finding involving a number is an estimate.
  - Testing an existing accounting estimate or provision already made (doubtful-debt provision, warranty provision, impairment) → SA 540, not SA 315 (SA 315 is risk identification during planning, not testing an estimate that already exists).
  - External third-party confirmations (banks, customers, suppliers, lenders) → SA 505.
  - RELATED PARTY TRANSACTIONS → SA 550, and apply the substantive judgment SA 550 actually asks for, not only the citation. State explicitly, from what the text shows: (a) whether the pricing or terms differ from what an unrelated third party would receive — a below-market rate, an interest-free loan, a waived fee, or unusually generous credit terms are the signal, and if the text gives no comparator, the procedure must be to obtain one (an unrelated-party quote, a market rate, a similar arm's-length contract) rather than assuming the terms are fine; (b) whether the transaction has the board or audit-committee approval a related-party transaction of its kind requires, and if the text is silent on approval, treat that silence as an open gap to close, not as approval that can be assumed; (c) whether the relationship itself and the transaction are BOTH disclosed, since a related party can be correctly identified yet the transaction still omitted, or vice versa — these are two separate completeness questions, not one. A related-party finding that only says "confirm this is arm's length" without naming which of these three the text actually leaves open is exactly the generic procedure this rule exists to prevent.
  - Subsequent events after the reporting date → SA 560, and apply the actual SA 560 test rather than the citation alone. First, identify the two governing dates from the text if stated (the balance sheet / reporting date, and the date the auditor's report is signed or the financial statements are approved) — an event is only a "subsequent event" if it falls between them; an event before the reporting date is a cut-off issue (see the rule above), and the text may not state the report date at all, in which case say so as part of the procedure ("confirm the date of the auditor's report to determine whether this event falls within the subsequent-events period") rather than assuming it qualifies. Second, classify the event as ADJUSTING (it provides evidence of a condition that existed AT the reporting date — a customer's post-year-end bankruptcy showing a receivable was already uncollectible at year-end, a court judgment on a case that existed at year-end) or NON-ADJUSTING (a condition that arose AFTER the reporting date — a fire, a new acquisition, a post-year-end share issue) and say which, because the two require different actions: an adjusting event means the figures in the statements may need to change, a non-adjusting material event means disclosure only. Cite Ind AS 10 alongside SA 560 ONLY if the text states or implies Ind AS is the applicable framework; otherwise cite SA 560 alone. Do not describe an event as "subsequent" merely because it is mentioned near the end of a document, and actively look for language that signals one even when no explicit heading names it: "since year-end", "after the balance sheet date", "in April 2025" following a March year-end, "subsequently", "post year-end", a dated board-minute excerpt after the reporting date, or a customer/supplier event reported after the period covered by the working paper.
  - Going concern doubts → SA 570, and when this text shows ANY of the standard SA 570 indicator categories below, name explicitly which category and which specific fact triggered it, rather than a bare "assess going concern" — genuinely check for these even when the topic is not going concern, since a covenant breach or a funding gap can surface inside a receivables, borrowings or cash-flow review just as easily as a dedicated going-concern one:
    - FINANCIAL indicators: net liability or net current liability position; a loan approaching maturity with no realistic prospect of renewal or repayment; a breached loan covenant or a covenant waiver that was only verbal or informal; negative operating cash flows (historical or forecast); major debt repayments falling due within twelve months of the reporting date with no funding plan; reliance on a related party or director for continued financial support, especially if that support is not legally binding; withdrawal or refusal of normal supplier credit terms.
    - OPERATING indicators: loss of a key customer, supplier, market, franchise, licence or principal supplier; labour difficulties or a shortage of an important input; management stated intention to liquidate, cease operations, or dispose of substantial assets.
    - OTHER indicators: non-compliance with statutory capital or other requirements; pending legal or regulatory proceedings that could result in claims the entity is unlikely to be able to satisfy; changes in law, regulation or government policy expected to adversely affect the entity.
    Once an indicator is identified, the required procedure must go beyond "assess going concern" and name the actual SA 570 evaluation step this document's own gap needs: obtain and evaluate management's future cash flow forecast or business plan covering at least twelve months from the reporting date; obtain written confirmation of a facility renewal, waiver or continued support rather than relying on a verbal indication; evaluate whether management's mitigating plans are realistic and whether their key assumptions are supported by evidence; or determine whether the going concern basis itself, and any required disclosure of material uncertainty, is adequate given what was found. Do not conclude the entity IS or IS NOT a going concern yourself — that is the auditor's ultimate professional judgment on the whole engagement, not something one document-specific procedure can establish; state the indicator and the evaluation procedure that is required, not the verdict.
  - Reliance on a management expert or specialist → SA 620. Opening balances on a first engagement → SA 510.
  Cite a specific clause number ONLY when certain; otherwise cite the standard/Act without a number rather than guessing one.
- Each procedure MUST include "evidence": an exact, verbatim quotation of the specific amount, date, party, or transaction detail from the text below that makes this procedure apply. Quote the text exactly; do not paraphrase, translate, or invent a quotation. A procedure with no specific document evidence to quote must not be included here — the mandatory procedures (materiality always, confirmations and representations only when relevant) are already handled separately and must NOT be repeated in your response.
- Do NOT invent facts. Only cite something that is actually written in the text below.
- Where relevant to what the text says, cover: a roll-forward/roll-back reconciliation if a count or verification date differs from the reporting date; the effect on going concern [SA 570]; a subsequent events review [SA 560]; export or cross-border control-transfer timing; a formal cut-off test; and any indicator of fraud or management pressure on the numbers [SA 240] — but only add these when THIS text's own content actually raises them, not as a standard checklist applied regardless of content.
- No generic filler, no repeated points, no two procedures citing the same evidence for the same purpose. If two distinct passages describe the SAME underlying finding (a fact, and then a conclusion about that fact), combine them into ONE procedure rather than two - do not produce a second procedure that only restates or narrows the first.
- NAME THE SPECIFIC MISSING EVIDENCE, NOT THE TOPIC'S STANDARD PROCEDURE LIST: a "detail" that would read exactly the same on a different document about the same topic area is too generic and must be rewritten or dropped. "Obtain confirmation of the balance" or "Assess whether the provision is adequate" are the topic's standard textbook procedure, not this finding's procedure — they say nothing that could only have come from THIS text. Contrast with "Obtain external confirmation from Vantage Garments LLC of the exact Rs 62,00,000 balance, since credit control's own file shows no recovery plan": this could only be written about this specific fact pattern, because it names the specific party, the specific figure, and the specific evidence gap (a recovery plan that was confirmed absent) that only THIS text's evidence gap (step 4 of the pipeline) creates. Before finalising each "detail", check it actually depends on the "evidence" quoted beside it — if the same "detail" text would still make sense with a different, unrelated "evidence" quotation substituted in, it has not used the evidence and must be rewritten to depend on it.
- "why": ONE short plain-language sentence with no jargon, explaining to a junior team member why this procedure or standard matters here — for example "A written confirmation direct from the customer is stronger evidence than internal correspondence, because it cannot be influenced by company management." Explain the REASON, do not repeat the detail text.
- "nextAction": ONE short sentence naming what the reviewer does depending on the outcome of this procedure — for example "If the provision is found inadequate, propose an adjusting entry and record it as an unadjusted misstatement for review."
- IT IS CORRECT, AND EXPECTED, TO PRODUCE FEWER FINDINGS THAN THE TARGET COUNT BELOW WHEN THE TEXT DOES NOT SUPPORT MORE. The target given below is a ceiling to select up to, driven by how much this specific text actually supports — never a quota to fill. A short, narrow, or single-issue document producing one or two well-evidenced findings is a correct, complete answer, not a partial one; do not pad the list with a second, weaker treatment of the same fact, a topic's routine procedure with no document-specific evidence gap behind it, or a restatement of the materiality/confirmation/representation items that are already handled separately, just to reach the target number. If the text genuinely does not contain enough specific detail to support ANY document-specific procedure (e.g. it is too short, too vague, or not really audit-relevant), set "result" to "INSUFFICIENT_EVIDENCE", give a one-sentence "insufficientEvidenceReason", and return an empty "insights" array. Do not force procedures onto text that does not support them.

Respond ONLY with JSON of this exact shape:
{"result": "SUPPORTED or INSUFFICIENT_EVIDENCE", "insufficientEvidenceReason": "required when result is INSUFFICIENT_EVIDENCE, empty string otherwise", "insights": [{"title": "short imperative procedure title with the specific figure included", "detail": "1-3 sentence executable audit procedure tied to the text, citing the standard, with specific figures and any already-reached conclusion stated as fact", "risk": "high|medium|low", "standard": "precise standard/section or empty string", "evidence": "exact quotation from the text below", "why": "one plain-language sentence explaining why this matters", "nextAction": "one sentence on what to do depending on the outcome"}]}

Keep title under 100 characters, detail under 320 characters, why under 220 characters, nextAction under 220 characters, and evidence under ${MAX_EVIDENCE_LENGTH} characters.`;
}

function buildInsightsPrompt(rawText, topicLabel, packaged, performedSections) {
  return `Read the audit text below. It may contain OCR noise, broken grammar, misspellings, abbreviations, ALL CAPS, or a Hindi-English (Hinglish) mix — infer the real meaning and do not be thrown off by formatting.

For the audit area "${topicLabel}", decide which of the KNOWN PROCEDURES below apply to THIS specific text, and whether THIS text shows evidence of any KNOWN COMMON MISTAKES. Produce UP TO ${MODEL_INSIGHT_TARGET} document-specific AUDIT PROCEDURES the engagement team must perform because of what THIS text actually says — this is a ceiling to select up to, not a quota to fill; if this specific text genuinely supports fewer, producing fewer is the correct answer (see "it is correct to produce fewer findings" below). This is selection and evidencing, not free generation, and it is audit documentation, not management commentary.
${packagedContextBlock(packaged)}${performedProceduresBlock(performedSections)}
${insightsHardRulesBlock()}

TEXT:
"""
${safeStr(rawText, INSIGHTS_TEXT_CAP)}
"""`;
}

// Root fix for a class of defect a human reviewer traced directly to a real
// document (the Orion/Stellar fixtures below): a single generation pass, even
// a well-grounded one, can read a multi-section working paper and simply stop
// after finding "enough" issues, silently leaving one or more labelled
// sections unaddressed. Measured live on the Stellar Textiles fixture: a
// single pass covered 5 of 7 real, evidenced, WP-Ref-tagged findings and
// silently dropped the other 2 (B-02 foreign-exchange mismatch and G-07 going-
// concern/working-capital renewal) despite the response having room to spare
// under the insight-count ceiling - so raising the ceiling alone would not
// have caught this; the model chose to stop short of it, not hit it.
//
// A first version of this pass asked the model to "re-read the whole document
// and hunt for anything missed", which is the same vague instruction a single
// pass already effectively had (the primary prompt already says to cover
// everything relevant). Measured live: it recovered some missed findings but
// not all (a going-concern finding was recovered; a foreign-exchange finding
// on the same document was still missed). The fix below is deterministic
// rather than a second guess: findUncoveredSections computes EXACTLY which
// "[WP Ref: ...]"-tagged sections have zero primary-pass coverage, using the
// same tag-extraction machinery findNearestWorkingPaperRef relies on, and
// this prompt is then built to ask about ONLY those specific, named, quoted
// sections - one finding is requested per uncovered section rather than a
// generic re-read of the whole text. This turns "did you miss anything?"
// into "here is section B-02, verbatim - what, if anything, does it
// require?", which is a fill-in-the-blank task rather than a repeat of the
// open-ended search that already under-delivered once.
function findUncoveredSections(sentTextOriginalCase, primaryPassInsights) {
  const tags = extractAllWorkingPaperRefTags(sentTextOriginalCase);
  if (tags.length === 0) return null; // No tagging convention in this document at all.

  const coveredRefs = new Set(
    primaryPassInsights.map((item) => item.workingPaperRef).filter(Boolean),
  );
  const uniqueTags = [];
  const seenRefs = new Set();
  for (const tag of tags) {
    if (!seenRefs.has(tag.ref)) {
      seenRefs.add(tag.ref);
      uniqueTags.push(tag);
    }
  }

  const uncoveredRefs = uniqueTags.filter((tag) => !coveredRefs.has(tag.ref));
  if (uncoveredRefs.length === 0) return [];

  const sections = sectionTextsByWorkingPaperRef(sentTextOriginalCase, tags);
  return uncoveredRefs.map((tag) => ({
    ref: tag.ref,
    text: sections.get(tag.ref) || "",
  }));
}

// Builds a targeted coverage-check prompt naming and quoting the SPECIFIC
// uncovered sections computed by findUncoveredSections, when the document
// uses the "[WP Ref: ...]" convention. Falls back to a generic whole-document
// re-read only for a document with no such tags at all (uncoveredSections is
// null), since there is then no deterministic way to know which parts a
// first pass addressed.
function buildCoverageCheckPrompt(
  rawText,
  topicLabel,
  packaged,
  primaryPassInsights,
  uncoveredSections,
  performedSections,
) {
  const coveredBlock = primaryPassInsights
    .map(
      (item, index) =>
        `${index + 1}. ${item.title} — evidence already cited: "${safeStr(item.evidence, 160)}"`,
    )
    .join("\n");

  if (uncoveredSections && uncoveredSections.length > 0) {
    const sectionsBlock = uncoveredSections
      .map(
        (section, index) =>
          `SECTION ${index + 1} [WP Ref: ${section.ref}]:\n"""\n${safeStr(section.text, 2000)}\n"""`,
      )
      .join("\n\n");

    return `You are reviewing specific sections of an audit working paper for the audit area "${topicLabel}" that a first review pass did NOT produce any finding for. These sections were NOT examined in the first pass at all - your job is to examine each one now and decide what, if anything, it requires.

For context only, here is what the first pass already found in OTHER sections (do not repeat these; they are not the sections below):
${coveredBlock}
${packagedContextBlock(packaged)}${performedProceduresBlock(performedSections)}
Now examine EACH of the following sections and produce ONE document-specific audit procedure per section that genuinely requires one, grounded in that section's own text:

${sectionsBlock}

If a specific section genuinely contains nothing requiring a distinct audit procedure beyond materiality, confirmations, or representations (already handled separately), simply do not produce an insight for that section - do not force one. If NONE of the sections above require anything, set "result" to "INSUFFICIENT_EVIDENCE" with a one-sentence reason and an empty "insights" array.

${insightsHardRulesBlock()}

TEXT (for reference; the sections needing your attention are quoted above):
"""
${safeStr(rawText, INSIGHTS_TEXT_CAP)}
"""`;
  }

  // Fallback for a document with no "[WP Ref: ...]" tagging convention at
  // all: there is no deterministic way to know which passages a first pass
  // addressed, so this asks for a careful whole-document re-read instead.
  return `You are re-reviewing the SAME audit text below for the audit area "${topicLabel}". On a first pass, the following document-specific findings were already identified and must NOT be repeated or closely restated:

ALREADY IDENTIFIED (do not repeat these):
${coveredBlock}
${packagedContextBlock(packaged)}${performedProceduresBlock(performedSections)}
Now read the FULL text below again, specifically hunting for any OTHER distinct passage describing a finding, exception, dispute, control gap, unusual transaction, or risk indicator that is NOT already covered above. Pay particular attention to: a passage near the end of the document, which a first pass sometimes shortchanges; and an issue that resembles an already-covered one in TYPE but concerns a DIFFERENT transaction, amount, date, or party (these are still genuinely separate findings, not restatements).

If you find one or more genuinely new, evidence-backed findings, produce one procedure for each, in the JSON shape below. If, after this careful re-check, there is truly nothing left uncovered, set "result" to "INSUFFICIENT_EVIDENCE" with a one-sentence reason and an empty "insights" array — this is a normal, GOOD outcome meaning the first pass was already complete. Do not invent a finding just to report something.

${insightsHardRulesBlock()}

TEXT:
"""
${safeStr(rawText, INSIGHTS_TEXT_CAP)}
"""`;
}

// Below this length a document is very unlikely to contain more distinct,
// independently-evidenced findings than a single pass would already surface,
// so the coverage-check pass (a second full model call) is skipped rather
// than spent on text where it is very unlikely to add anything. Real
// multi-issue statutory working papers (the actual use case this pass exists
// for) run well into the thousands of characters.
const COVERAGE_CHECK_MIN_TEXT_LENGTH = 300;

// Deterministic (non-LLM) extraction of a stated rupee figure from a GROUNDED
// evidence quote, so a materiality ratio never depends on model arithmetic -
// a language model asked to compute "2.8x materiality" is exactly the kind of
// arithmetic an LLM gets wrong silently. Handles "Rs./₹/INR" prefixed figures
// with optional lakh/crore words and Indian digit grouping. Returns null when
// no confident figure is found rather than guessing: a missing amount is
// honest, a wrong one is not.
const RUPEE_AMOUNT_PATTERN =
  /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh|lakhs|crore|crores)?/i;

function extractRupeeMinorFromEvidence(evidence) {
  const text = String(evidence || "");
  const match = RUPEE_AMOUNT_PATTERN.exec(text);
  if (!match) return null;

  const numeral = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(numeral) || numeral <= 0) return null;

  const unit = match[2] ? match[2].toLowerCase() : null;
  const scale = unit && unit.startsWith("crore") ? 10000000 : unit ? 100000 : 1;
  const rupees = numeral * scale;

  // Reject an implausible figure (over ₹1,000 crore) rather than propagate
  // it - a match this large from free text is more likely a parsing
  // artefact (e.g. a phone number or id run into the pattern) than a real
  // amount on a single working paper line.
  if (!Number.isFinite(rupees) || rupees > 10000000000) return null;

  return Math.round(rupees * 100);
}

// Every quote-like character - straight single, straight double, and the four
// curly/smart variants - is collapsed to one canonical character for
// grounding purposes only (never in what is displayed: callers slice from
// the ORIGINAL evidence string, this normalization exists solely to decide
// whether a span is a real quotation). Measured directly against a live
// model response on the Stellar Textiles fixture: the source wrote a quoted
// term in straight DOUBLE quotes ("Other Income"), the model quoted the same
// words back in straight SINGLE quotes ('Other Income') - not a curly-vs-
// straight mismatch at all, but two different ASCII quote characters that a
// curly-only mapping does not touch. Collapsing both to `'` (rather than
// mapping one to the other, which would just relocate the same bug) is what
// actually closes it. A model rewriting a document's quote style has not
// changed a single word - only the glyph MarkDown-style JSON prose defaults
// to - and rejecting the whole evidence string over that punishes a
// formatting artefact as if it were a fabrication.
function normalizeQuotesForComparison(value) {
  return String(value ?? "").replace(/[\u2018\u2019\u201A\u201B'"]/g, "'");
}

function normalizeWhitespace(value) {
  return normalizeQuotesForComparison(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

// Real statutory working papers are commonly written as short labelled
// sections - "Background: ... Findings: ... Preparer's Conclusion: ..." -
// so the two sentences that together make one finding worth citing (the fact,
// and what was concluded about it) often sit in different sections with other
// sentences between them. A careful model quotes both because both are true
// and both matter; asked for ONE contiguous span it cannot supply, so the
// previous single-substring check rejected such evidence in its entirety -
// discarding a real, verbatim, well-grounded finding because of how the
// source document happened to be laid out, not because anything was invented.
//
// Splits a multi-sentence evidence string into individual sentence-like
// fragments (splitting on ". "/"; " before a capital letter or quote, and on
// an ellipsis the model may use to mark its own elision) and checks EACH
// fragment against the sent text independently. A fragment that does not
// resolve is dropped rather than failing the whole evidence string, so a
// model that pads one fabricated sentence onto two real ones still loses only
// the fabricated part. Grounded fragments are re-joined with " ... " (the
// same marker a model already uses for its own elisions) so the final
// evidence string a reviewer sees never claims contiguity that is not there.
// Splits on whitespace-normalized text but deliberately does NOT run quote
// normalization here: what is returned is what a reviewer sees, and the
// model's own quote-character choice (however it differs from the source) is
// preserved verbatim rather than silently rewritten to a canonical glyph.
// Quote-blindness is applied only where fragments are checked against the
// source in resolveGroundedEvidence, never in what is displayed.
function splitEvidenceFragments(evidence) {
  return String(evidence ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s*\.{3}\s*|(?<=[.;])\s+(?=[A-Z"'\u2018\u201C])/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

// Fix for M2: the previous grounding mechanism was one sentence of prose with
// no field a citation could go in, so nothing could check that a cited amount
// actually appeared anywhere in the input. This is the check. It runs against
// the text the model was actually sent (capped at INSIGHTS_TEXT_CAP), because
// that is the only text the model could truthfully quote from.
//
// Returns { text, firstFragment } where text is the evidence actually
// grounded (which may be a subset of what was submitted, rejoined with
// " ... ") and firstFragment is its first individually-verified span - kept
// separately because that is what findNearestWorkingPaperRef locates a
// position with, or null when nothing in the submitted evidence grounds at
// all. The overall length bound is checked against what is actually kept,
// not the model's original submission, so trimming a partly-fabricated
// evidence string down to its real portion cannot itself trip the ceiling.
function resolveGroundedEvidence(evidence, sentTextNormalized) {
  const fragments = splitEvidenceFragments(evidence);
  const kept = fragments.filter((fragment) => {
    if (fragment.length < MIN_EVIDENCE_LENGTH) return false;
    // Compared quote-blind (a model rewriting " to ' has changed no word),
    // but the fragment itself - what gets displayed - keeps its own
    // original quote characters untouched.
    const comparable = normalizeQuotesForComparison(fragment).toLowerCase();
    return sentTextNormalized.includes(comparable);
  });
  if (kept.length === 0) return null;

  const joined = kept.join(" ... ");
  if (joined.length > MAX_EVIDENCE_LENGTH) return null;

  return { text: joined, firstFragment: kept[0] };
}

// Matches the bracketed working-paper-reference convention already used in
// this fixture's own documents ("[WP Ref: A-01]"), tolerant of a missing
// colon, extra spaces, or no surrounding brackets - never inferred, only
// recognised: a document with no such tag anywhere simply gets
// workingPaperRef: null on every insight, which is the honest answer.
const WORKING_PAPER_REF_PATTERN =
  /\[?\s*WP\s*Ref\.?\s*:?\s*([A-Za-z]{1,4}-?\d{1,4}(?:\.\d+)?)\s*\]?/gi;

// Deterministic (non-LLM), the same design principle as
// extractRupeeMinorFromEvidence: a working paper reference is a fact about
// WHERE in the source document a finding's evidence sits, not something a
// model should be trusted to report about its own output. Finds every
// "[WP Ref: X-NN]" tag in the ORIGINAL text (case preserved, so the tag's
// own casing is returned unchanged) and returns whichever one appears
// nearest before the grounded evidence's first fragment - the same
// convention this fixture's own documents use, where one tag heads a section
// and every subsequent sentence until the next tag belongs to it. Returns
// null when the source contains no such tags at all, or when the evidence's
// position could not be located (should not happen for evidence already
// confirmed grounded, but fails safe rather than guessing).
function findNearestWorkingPaperRef(firstFragment, sentTextOriginalCase) {
  if (!sentTextOriginalCase) return null;

  const tags = [];
  let match;
  WORKING_PAPER_REF_PATTERN.lastIndex = 0;
  while ((match = WORKING_PAPER_REF_PATTERN.exec(sentTextOriginalCase))) {
    tags.push({ ref: match[1], index: match.index });
  }
  if (tags.length === 0) return null;

  // Quote-blind for the same reason resolveGroundedEvidence is: firstFragment
  // may carry the model's own quote-character choice, which can differ from
  // the source's while quoting the exact same words.
  const needle = normalizeQuotesForComparison(
    String(firstFragment || ""),
  ).toLowerCase();
  if (!needle) return null;
  const haystack =
    normalizeQuotesForComparison(sentTextOriginalCase).toLowerCase();
  const evidenceIndex = haystack.indexOf(needle);
  if (evidenceIndex === -1) return null;

  let nearest = null;
  for (const tag of tags) {
    if (tag.index <= evidenceIndex) {
      if (!nearest || tag.index > nearest.index) nearest = tag;
    }
  }
  return nearest ? nearest.ref : null;
}

// Extracts every "[WP Ref: X-NN]" tag in the source with its position, in
// document order - completely separate from findNearestWorkingPaperRef above,
// which instead finds the nearest tag BEFORE one specific piece of evidence.
// This is the groundwork for the coverage-check pass below: knowing how many
// labelled sections a document has, and where each one starts, is what makes
// it possible to check which sections a first model pass actually addressed
// versus which it silently skipped.
function extractAllWorkingPaperRefTags(sentTextOriginalCase) {
  const tags = [];
  let match;
  WORKING_PAPER_REF_PATTERN.lastIndex = 0;
  while ((match = WORKING_PAPER_REF_PATTERN.exec(sentTextOriginalCase))) {
    tags.push({ ref: match[1], index: match.index });
  }
  return tags;
}

// Slices the source into per-section text, keyed by ref label, using each
// tag's start position through the next tag's start (or end of document for
// the last one). A ref appearing more than once (should not normally happen
// in a well-formed document) has its slices concatenated rather than the
// later one overwriting the earlier, so no text is silently lost.
function sectionTextsByWorkingPaperRef(sentTextOriginalCase, tags) {
  const sections = new Map();
  for (let i = 0; i < tags.length; i += 1) {
    const start = tags[i].index;
    const end =
      i + 1 < tags.length ? tags[i + 1].index : sentTextOriginalCase.length;
    const slice = sentTextOriginalCase.slice(start, end).trim();
    const existing = sections.get(tags[i].ref);
    sections.set(tags[i].ref, existing ? existing + "\n\n" + slice : slice);
  }
  return sections;
}

// Root fix for a human reviewer's own critique, observed across several real
// audits: "it frequently recommends procedures that have already been
// performed; instead of identifying the actual remaining evidence gap, it
// repeats confirmation, vouching, cut-off, or subsequent-payment procedures
// already documented in the working paper." A real statutory working paper
// routinely states what was already done, under a heading such as
// "Procedures Performed" or "Audit Procedures Performed" - that text is
// simply never shown to the model today, so the model has no way to know a
// procedure it is about to propose is one the working paper's own author
// already carried out.
//
// This extracts that stated text deterministically (regex against known
// heading words, never model-derived) and the prompt then quotes it back
// verbatim with an explicit "do not recommend these again" instruction - the
// same "give the model the fact rather than ask it to notice the fact"
// principle extractStatedMateriality and findUncoveredSections already use
// elsewhere in this file, extended to a new class of fact.
//
// Heading matching is heuristic by nature - real working papers do not share
// one fixed template - but is anchored on the two heading phrasings observed
// directly in this session's own fixtures ("Procedures Performed:" as an
// inline label, and "Audit Procedures Performed" as a standalone heading
// line), plus the closest common synonyms. A document using a heading this
// pattern does not recognise simply yields no extracted block, which is the
// honest fallback: the prompt's own self-check rule (see
// insightsHardRulesBlock) still asks the model to avoid repeating anything
// the text describes as already done, so detection is not solely dependent
// on this regex firing.
const WORKING_PAPER_HEADING_PATTERN =
  /\b(?:Objective|Background(?:\s*\/\s*Facts\s*Noted)?|(?:Audit\s+)?Procedures\s+(?:Performed|Carried\s+Out)|Work\s+Performed|Findings(?:\s*\/\s*Observations)?|Preparer'?s?\s+Conclusion|Conclusion)\s*:?/gi;

const PROCEDURES_PERFORMED_HEADING_PATTERN =
  /\b(?:(?:Audit\s+)?Procedures\s+(?:Performed|Carried\s+Out)|Work\s+Performed)\s*:?/i;

// Finds every recognised heading in the ORIGINAL (uncapped, structure-
// preserving) text, and for each one matching the "procedures performed"
// family, captures the text from immediately after that heading up to
// whichever comes next: another recognised heading, the next "[WP Ref: ...]"
// tag, or the end of the document. Attributed to the nearest preceding WP Ref
// tag using the same convention findNearestWorkingPaperRef already applies
// to evidence, so a multi-section document's performed-procedures text stays
// correctly grouped by which finding it actually belongs to.
function extractPerformedProceduresSections(rawText) {
  const text = String(rawText || "");
  if (!text) return [];

  const wpTags = extractAllWorkingPaperRefTags(text);

  const headings = [];
  const headingScanPattern = new RegExp(
    WORKING_PAPER_HEADING_PATTERN.source,
    "gi",
  );
  let match;
  while ((match = headingScanPattern.exec(text))) {
    headings.push({
      index: match.index,
      end: match.index + match[0].length,
      label: match[0],
    });
  }
  if (headings.length === 0) return [];

  const boundaries = [
    ...headings.map((h) => h.index),
    ...wpTags.map((t) => t.index),
    text.length,
  ].sort((a, b) => a - b);

  const results = [];
  for (const heading of headings) {
    if (!PROCEDURES_PERFORMED_HEADING_PATTERN.test(heading.label)) continue;

    const nextBoundary =
      boundaries.find((boundary) => boundary > heading.index) ?? text.length;
    const bodyText = text.slice(heading.end, nextBoundary).trim();
    if (bodyText.length === 0) continue;

    let nearestRef = null;
    for (const tag of wpTags) {
      if (tag.index <= heading.index) {
        if (!nearestRef || tag.index > nearestRef.index) nearestRef = tag;
      }
    }
    results.push({ ref: nearestRef ? nearestRef.ref : null, text: bodyText });
  }
  return results;
}

// Formats extracted performed-procedures sections into the prompt block both
// the primary and coverage-check prompts inject. Empty string (nothing
// added to the prompt) when the document had no such heading at all, rather
// than an empty/misleading block.
function performedProceduresBlock(sections) {
  if (!sections || sections.length === 0) return "";
  const lines = sections.map((section, index) => {
    const label = section.ref
      ? `[WP Ref: ${section.ref}]`
      : `Section ${index + 1}`;
    return `${label}: ${safeStr(section.text, 600)}`;
  });
  return `\nPROCEDURES ALREADY PERFORMED, as stated by the working paper itself (do NOT recommend any of these again as if they were still outstanding - identify and recommend only the REMAINING evidence gap, i.e. what these already-performed procedures did not resolve):\n${lines.join("\n")}\n`;
}

// Root fix for the "the tool produced two entries for one finding" class of
// defect. Measured against a real live-model run and confirmed directly by
// a human reviewer's own critique of it: "Test unsupported Rs 2,50,000
// accrual" and "Investigate unsupported Rs 2,50,000 accrual portion" were
// named as the same issue restated, while a third item on the same journal
// entry - "Evaluate manual journal entry for management override" - was
// explicitly named by the same reviewer as "different and useful" and
// should survive as its own finding.
//
// Two candidate signals were tried against those exact three real titles
// before settling on this one. Word-overlap on TITLE ALONE cannot separate
// the two cases correctly: the genuine duplicate pair's title-word overlap
// ratio (0.5) is LOWER than the genuinely-distinct pair's ratio (0.57),
// because "portion" replacing "from manual journal entry" removes more
// shared words than the word "unsupported" it keeps - so no single
// threshold can accept the real duplicate while rejecting the real
// non-duplicate. What actually distinguishes them: the two duplicate items
// cite the EXACT SAME evidence quotation, while the distinct third item
// cites a different quotation ("no evidence of independent review" versus
// "the remaining Rs 2,50,000 has not been supported"). Evidence equality is
// therefore checked FIRST, as the dominant signal - a model producing two
// items grounded in literally the same quoted sentence is restating one
// finding, almost by definition, regardless of how differently the two
// titles happen to be worded. Title-word overlap is kept only as a secondary
// safety net, for a paraphrased-but-not-identical evidence string that is
// still obviously the same point, and its threshold is set high enough
// (0.75) to require near-total title agreement rather than merely a shared
// topic - low enough to still catch an exact-duplicate title with slightly
// reworded evidence, high enough to leave the genuinely distinct third item
// alone. The earlier occurrence in the list is kept in both cases.
function normalizeEvidenceForDuplicateComparison(evidence) {
  return String(evidence || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function significantWords(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

const NEAR_DUPLICATE_TITLE_OVERLAP_THRESHOLD = 0.75;

// True when candidate is a near-duplicate of ANY item in referenceItems, by
// the evidence-equality-first, title-overlap-second rule described above.
// Factored out so the within-pass dedup below and the cross-pass
// (coverage-pass-against-primary-pass) check in generateInsights share one
// definition of "near-duplicate" rather than two that could silently drift.
function isNearDuplicateOfAny(candidate, referenceItems) {
  const candidateEvidence = normalizeEvidenceForDuplicateComparison(
    candidate.evidence,
  );
  const candidateWords = significantWords(candidate.title);

  return referenceItems.some((existing) => {
    const existingEvidence = normalizeEvidenceForDuplicateComparison(
      existing.evidence,
    );
    if (
      candidateEvidence.length > 0 &&
      candidateEvidence === existingEvidence
    ) {
      return true;
    }

    const existingWords = significantWords(existing.title);
    const overlap = [...candidateWords].filter((word) =>
      existingWords.has(word),
    ).length;
    const smaller = Math.min(candidateWords.size, existingWords.size);
    return (
      smaller > 0 && overlap / smaller >= NEAR_DUPLICATE_TITLE_OVERLAP_THRESHOLD
    );
  });
}

function deduplicateNearIdenticalInsights(items) {
  const kept = [];
  for (const item of items) {
    if (!isNearDuplicateOfAny(item, kept)) {
      kept.push(item);
    }
  }
  return kept;
}

// A narrow, closed set of subject-plus-modal openings that name the auditor/team as the
// one acting and say they should/must/shall/need to/are to do something - "The auditor
// should verify X" is exactly as actionable as "Verify X", and rejecting it purely for
// phrasing loses a correct, professionally sound procedure over grammar rather than
// substance (W22 in agenttesting.md's weak-area register). Deliberately does not widen
// the gate to accept passive/descriptive prose: "Verification of X should be performed"
// and "This shows management pressure" still fail, because there is no verb to recover
// after stripping this specific opening shape, which is the actual signal of substance.
const IMPERATIVE_SUBJECT_MODAL_PREFIX =
  /^(?:the\s+)?(?:auditors?|engagement\s+teams?|audit\s+teams?|teams?|reviewers?)\s+(?:should|must|shall|needs?\s+to|are?\s+to|has\s+to|have\s+to)\s+/i;

function isImperativeDetail(detail) {
  const trimmed = String(detail || "").trim();
  const withoutModalPrefix = trimmed.replace(
    IMPERATIVE_SUBJECT_MODAL_PREFIX,
    "",
  );
  const firstWord = withoutModalPrefix.split(/\s+/, 1)[0] || "";
  return IMPERATIVE_VERBS.has(
    firstWord.replace(/[^A-Za-z]/g, "").toUpperCase(),
  );
}

// Fix for B5's output gate: rejects a duplicate procedure (by normalized
// title), a detail with no imperative verb, and any procedure whose evidence
// does not resolve against the text the model was actually sent. What remains
// is capped and field-bounded the same way the previous version always was.
//
// sentTextNormalized is lowercase (whitespace/quote-normalized) and is what
// every substring check runs against. sentTextOriginalCase is the same text
// with its original casing intact, needed only so a recovered
// [WP Ref: A-01]-style tag is returned in the case it was actually written,
// not forced to lower case.
//
// options.maxAccepted overrides MAX_MODEL_INSIGHTS - used by the
// coverage-check pass, which is deliberately capped lower (see
// MAX_COVERAGE_MODEL_INSIGHTS). options.excludeTitles is a Set of normalized
// titles (lowercase) already accepted from an earlier pass on the same
// request: defense in depth alongside the coverage-check prompt's own
// "do not repeat these" instruction, so a model that repeats an
// already-covered finding anyway does not get it counted twice even though
// the prompt asked it not to.
function validateAndFilterInsights(
  rawItems,
  sentTextNormalized,
  sentTextOriginalCase,
  options = {},
) {
  const maxAccepted = options.maxAccepted ?? MAX_MODEL_INSIGHTS;
  const seenTitles = new Set(options.excludeTitles ?? []);
  const accepted = [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    if (accepted.length >= maxAccepted) break;

    const title = safeStr(item.title, 120).trim();
    const detail = safeStr(item.detail, 500).trim();
    const evidence = safeStr(item.evidence, MAX_EVIDENCE_LENGTH + 40).trim();
    if (!title || !detail || !evidence) continue;

    const normalizedTitle = title.toLowerCase();
    if (seenTitles.has(normalizedTitle)) continue;
    if (!isImperativeDetail(detail)) continue;

    const resolved = resolveGroundedEvidence(evidence, sentTextNormalized);
    if (resolved === null) continue;

    seenTitles.add(normalizedTitle);
    accepted.push({
      title,
      detail,
      risk: ["high", "medium", "low"].includes(String(item.risk).toLowerCase())
        ? String(item.risk).toLowerCase()
        : "medium",
      standard: safeStr(item.standard, 60).trim(),
      evidence: resolved.text,
      // Model-written, but bounded and optional: an absent or blank value
      // is dropped rather than defaulted to an empty string reaching the
      // client as if it were a deliberate "nothing to add" answer.
      why: safeStr(item.why, 220).trim() || null,
      nextAction: safeStr(item.nextAction, 220).trim() || null,
      // Extracted deterministically from the GROUNDED evidence text with a
      // regex, never trusted from the model's own arithmetic. Grounded
      // evidence is a verbatim quotation already checked against the source
      // document above, so a figure found inside it is the actual stated
      // amount, not a model computation that could silently be wrong.
      amountMinor: extractRupeeMinorFromEvidence(resolved.text),
      // Deterministically located from the ORIGINAL text by proximity, never
      // from the model: see findNearestWorkingPaperRef below for why
      // position in the source is what a working-paper reference actually
      // means.
      workingPaperRef: findNearestWorkingPaperRef(
        resolved.firstFragment,
        sentTextOriginalCase,
      ),
    });
  }

  return accepted;
}

// Given extracted text + chosen topic, generate audit-specific procedures the
// text actually supports, each carrying the evidence it is grounded in.
export async function generateInsights(req, res, next) {
  try {
    const { rawText, topicId, topicName } = req.body || {};
    if (!rawText || typeof rawText !== "string") {
      return res.status(400).json({ ok: false, error: "rawText required" });
    }

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        ok: true,
        generated: false,
        reason: "LLM not configured",
        insights: [],
      });
    }

    const topicLabel = safeStr(topicName || topicId || "General audit", 100);
    const packaged = packagedContextFor(topicId, topicName);
    const resolvedTopicId = packaged?.topicId ?? topicId ?? null;
    const performedSections = extractPerformedProceduresSections(rawText);
    const prompt = buildInsightsPrompt(
      rawText,
      topicLabel,
      packaged,
      performedSections,
    );

    const system =
      "You are an Indian Chartered Accountant acting as the engagement partner on a statutory audit. You produce AUDIT PROCEDURES to be performed (imperative, executable steps), each grounded in a verbatim quotation from the supplied text. Never write management advice or general commentary. Return ONLY valid JSON. No markdown, no commentary.";

    // Fix for M3: raised from 1600, then again from 3000 to 4000 (2026-08-14)
    // alongside MAX_MODEL_INSIGHTS rising from 6 to 8. Measured on the Stellar
    // Textiles fixture (a real seven-issue statutory working paper): 6
    // fully-populated insights (title/detail/evidence/why/nextAction/standard
    // each) cost 1,346 completion tokens, so 8 needs roughly 1,800 plus
    // headroom for a longer prompt on a denser source document - 4000 keeps
    // that generous rather than tuned to one fixture, same principle as the
    // original increase from 1600.
    //
    // timeoutMs lowered from 40000 and maxAttemptsPerModel from the default 2
    // to 1 (2026-08-13, accuracy/speed pass). The old combination allowed a
    // documented worst case of 162.4s for this one route - by far the longest
    // of the four model-backed routes here - which a shared-hosting reverse
    // proxy in front of this server can plausibly kill before it finishes,
    // turning a merely-slow-but-working call into a hard failure with no
    // model-side signal at all. 25s matches the default this service already
    // uses for every other route (refine, reminder), and a same-model retry
    // rarely rescues a slow-response failure the way a genuinely different
    // fallback model can, so that retry is dropped rather than the fallback.
    // New worst case: 2 models x (25s + backoff) = ~50.8s - see
    // AuditAssistanceTests.ModelCallsAreGivenLongerThanTheServersRetryAndFallbackStructure
    // on the desktop side, which pins this arithmetic against the client's
    // deadline.
    const r = await callDeepSeek({
      system,
      prompt,
      jsonResponse: true,
      maxTokens: 4000,
      temperature: 0.2,
      timeoutMs: 25000,
      maxAttemptsPerModel: 1,
      model: INSIGHTS_MODEL,
    });

    if (!r.ok) {
      console.error("DeepSeek insights error:", r.reason);
      return res.json({
        ok: true,
        generated: false,
        reason: publicLlmFailureReason(r.reason),
        insights: [],
      });
    }

    // Fix for M3's second half: repairTruncatedJson can still recover a usable
    // object from a response that hit the token cap mid-value. Recovering
    // silently is exactly what let truncation hide the document-specific tail
    // before; this reports it instead, so the caller can label the result
    // partial rather than complete.
    const partial = wasJsonTruncated(r.content);

    const parsed = parseJsonObject(r.content);
    if (!parsed) {
      // Previously this fell through to generated:true with an empty
      // insights array - claiming success while nothing was produced. An
      // unparseable response is a failure, not a quiet empty result.
      return res.json({
        ok: true,
        generated: false,
        reason: "Could not parse LLM response",
        insights: [],
      });
    }

    const result = String(parsed.result || "SUPPORTED")
      .trim()
      .toUpperCase();

    if (result === "INSUFFICIENT_EVIDENCE") {
      const reason =
        safeStr(parsed.insufficientEvidenceReason, 500).trim() ||
        "This text does not contain enough specific detail to support document-specific procedures.";
      return res.json({
        ok: true,
        generated: true,
        insufficientEvidence: true,
        reason,
        insights: buildMandatoryProcedures(
          rawText,
          topicLabel,
          resolvedTopicId,
        ),
        ...(partial ? { partial: true } : {}),
      });
    }

    // Grounding runs against the exact text the model was sent (capped, same
    // as the prompt), normalized the same way on both sides. The
    // original-case copy (whitespace collapsed, but quote characters and
    // letter case both left exactly as written) is kept alongside purely so
    // a "[WP Ref: A-01]"-style tag can be recovered in the case it was
    // actually written; findNearestWorkingPaperRef does its own quote-blind
    // comparison internally, so this copy does not need to be pre-normalized
    // for that.
    const sentTextCapped = safeStr(rawText, INSIGHTS_TEXT_CAP);
    const sentTextOriginalCase = sentTextCapped.replace(/\s+/g, " ");
    const sentTextNormalized =
      normalizeWhitespace(sentTextCapped).toLowerCase();

    const rawItems = Array.isArray(parsed.insights) ? parsed.insights : [];
    const primaryPassInsights = deduplicateNearIdenticalInsights(
      validateAndFilterInsights(
        rawItems,
        sentTextNormalized,
        sentTextOriginalCase,
      ),
    );

    if (primaryPassInsights.length === 0) {
      return res.json({
        ok: true,
        generated: true,
        insufficientEvidence: true,
        reason:
          "No procedure returned by the assistant could be grounded in specific evidence from this text.",
        insights: buildMandatoryProcedures(
          rawText,
          topicLabel,
          resolvedTopicId,
        ),
        ...(partial ? { partial: true } : {}),
      });
    }

    // Coverage-check pass: re-reads the same document, told what the primary
    // pass already found, and asked specifically what else it missed. See
    // buildCoverageCheckPrompt for why this exists - a single pass can stop
    // short of a full multi-section document even when it has room left
    // under the insight ceiling. Best-effort: skipped for short text where a
    // second pass is very unlikely to find anything (fixed cost, near-zero
    // expected benefit), and any failure of this second call - timeout, no
    // content, unparseable response - simply means the response carries only
    // the primary pass's findings, exactly as it always did before this
    // pass existed. A coverage-check failure must never fail or shrink an
    // otherwise-successful primary result.
    let coveragePassInsights = [];
    let coveragePartial = false;

    const uncoveredSections = findUncoveredSections(
      sentTextOriginalCase,
      primaryPassInsights,
    );
    // A document that tags every section AND already has a finding for
    // every one of them needs no coverage-check call at all - there is
    // nothing left to ask about. Only skip when the tagging convention
    // exists (uncoveredSections is an array, not null) and it is empty; a
    // null (no tags at all) still runs the whole-document fallback below,
    // because that document offers no deterministic way to know the
    // primary pass was complete.
    const everyTaggedSectionAlreadyCovered =
      Array.isArray(uncoveredSections) && uncoveredSections.length === 0;

    if (
      sentTextCapped.length >= COVERAGE_CHECK_MIN_TEXT_LENGTH &&
      primaryPassInsights.length < MAX_MODEL_INSIGHTS &&
      !everyTaggedSectionAlreadyCovered
    ) {
      try {
        const coveragePrompt = buildCoverageCheckPrompt(
          rawText,
          topicLabel,
          packaged,
          primaryPassInsights,
          uncoveredSections,
          performedSections,
        );
        const coverageResponse = await callDeepSeek({
          system,
          prompt: coveragePrompt,
          jsonResponse: true,
          maxTokens: 2000,
          temperature: 0.2,
          timeoutMs: 25000,
          maxAttemptsPerModel: 1,
          model: INSIGHTS_MODEL,
        });

        if (coverageResponse.ok) {
          coveragePartial = wasJsonTruncated(coverageResponse.content);
          const coverageParsed = parseJsonObject(coverageResponse.content);
          const coverageResultTag = String(
            coverageParsed?.result || "SUPPORTED",
          )
            .trim()
            .toUpperCase();

          if (coverageResultTag !== "INSUFFICIENT_EVIDENCE") {
            const coverageRawItems = Array.isArray(coverageParsed?.insights)
              ? coverageParsed.insights
              : [];
            const excludeTitles = new Set(
              primaryPassInsights.map((item) => item.title.toLowerCase()),
            );
            coveragePassInsights = deduplicateNearIdenticalInsights(
              validateAndFilterInsights(
                coverageRawItems,
                sentTextNormalized,
                sentTextOriginalCase,
                { maxAccepted: MAX_COVERAGE_MODEL_INSIGHTS, excludeTitles },
              ),
            );
            // A finding from the coverage pass might still be a near-duplicate
            // of a PRIMARY-pass finding even though the model was told not to
            // repeat them (defense in depth, using the same shared rule
            // deduplicateNearIdenticalInsights uses within one pass).
            coveragePassInsights = coveragePassInsights.filter(
              (candidate) =>
                !isNearDuplicateOfAny(candidate, primaryPassInsights),
            );
          }
        }
      } catch (coverageErr) {
        // Logged for diagnosis; never surfaced or allowed to fail the request,
        // per the best-effort contract stated above.
        console.error("DeepSeek insights coverage-check error:", coverageErr);
      }
    }

    const allEvidencedInsights = [
      ...primaryPassInsights,
      ...coveragePassInsights,
    ];

    return res.json({
      ok: true,
      generated: true,
      insights: [
        ...buildMandatoryProcedures(
          rawText,
          topicLabel,
          resolvedTopicId,
          allEvidencedInsights,
        ),
        ...allEvidencedInsights,
      ].slice(0, MAX_TOTAL_INSIGHTS),
      ...(partial || coveragePartial ? { partial: true } : {}),
    });
  } catch (err) {
    console.error("generateInsights error:", err);
    next(err);
  }
}

// A calendar day, optionally with a time component, in a form
// `new Date()` parses unambiguously across Node/V8 locales - ISO 8601 date
// or date-time. Rejects free text like "10th Aug" that `new Date()` would
// otherwise silently turn into the literal string "Invalid Date" reaching a
// message a firm sends to a paying client (W01, agenttesting.md §24.1).
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

// A plausible number of pending/delay days for a client-facing reminder. Not
// validating this let `Number("1e9")` reach the prompt as "pending for
// 1000000000 days" (W16, agenttesting.md §24.1) - a bound this generous still
// covers any realistic compliance delay while rejecting scientific notation,
// negatives, and non-numeric input outright.
const MAX_PLAUSIBLE_DAYS = 3650;

function safeDueDate(dueDate) {
  if (typeof dueDate !== "string" || !ISO_DATE_PATTERN.test(dueDate.trim())) {
    return null;
  }
  const parsed = new Date(dueDate.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function safeDayCount(value, fallback) {
  const numeral = Number(value);
  return Number.isInteger(numeral) &&
    numeral >= 0 &&
    numeral <= MAX_PLAUSIBLE_DAYS
    ? numeral
    : fallback;
}

// ─── Reminder message generation ────────────────────────────────────
// Generate a personalized client follow-up message in Hinglish.
export async function generateReminderMessage(req, res, next) {
  try {
    const {
      clientName,
      serviceType,
      type, // "pending" | "risk"
      daysPending: rawDaysPending,
      lastDelayDays: rawLastDelayDays,
      dueDate: rawDueDate,
      tone, // "polite" | "firm" | "casual"
    } = req.body || {};

    if (!clientName || typeof clientName !== "string") {
      return res.status(400).json({ ok: false, error: "clientName required" });
    }

    // Validated once, up front, so neither the template fallback nor the
    // model prompt below can carry an unparseable date or an implausible day
    // count - both previously reached user-facing text unbounded.
    const parsedDueDate = safeDueDate(rawDueDate);
    const daysPending = safeDayCount(rawDaysPending, 3);
    const lastDelayDays = safeDayCount(rawLastDelayDays, 0);

    const fallbackMessage = (() => {
      const dueText = parsedDueDate
        ? parsedDueDate.toLocaleDateString("en-IN")
        : "upcoming due date";
      if (type === "pending") {
        return `Hi ${clientName},\n\nHum aapke ${serviceType || "compliance"} ke documents ka wait kar rahe hain. ${daysPending}+ din se documents pending hain.\nDue: ${dueText}.\n\nKripya documents jaldi share karein.\n\n- CA PRO Toolkit`;
      }
      return `Hi ${clientName},\n\nPichle 2 periods me aapke ${serviceType || "compliance"} filings due date ke baad submit hue the. Is baar time se complete karne ke liye documents thoda pehle bhejne ka request hai.\nCurrent due: ${dueText}.\n\nThanks.\n\n- CA PRO Toolkit`;
    })();

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        ok: true,
        generated: false,
        message: fallbackMessage,
        reason: "LLM not configured, using template",
      });
    }

    const dueText = parsedDueDate
      ? parsedDueDate.toLocaleDateString("en-IN")
      : "upcoming";

    const system =
      "You write professional client follow-up messages for Indian Chartered Accountants. Tone is warm but professional. Use a natural Hinglish (Hindi-English mix) style common in CA-client communication. Keep messages 60-100 words. Sign off as '- CA PRO Toolkit'. Return only the message text, no quotes, no commentary.";

    const userPrompt =
      type === "risk"
        ? `Write a polite WhatsApp/email follow-up message to a chronically late client.

Client name: ${safeStr(clientName, 80)}
Service: ${safeStr(serviceType || "compliance", 30)}
Last period delay: ${lastDelayDays} days late
Current due date: ${dueText}
Tone: ${tone === "firm" ? "firm but respectful" : "polite and supportive"}

Goal: gently remind them that last 2 filings were late and request they share documents earlier this time. Keep it short. Hinglish.`
        : `Write a polite WhatsApp/email follow-up message asking client to share pending documents.

Client name: ${safeStr(clientName, 80)}
Service: ${safeStr(serviceType || "compliance", 30)}
Days pending: ${daysPending}
Due date: ${dueText}
Tone: ${tone === "firm" ? "firm but respectful" : "polite and warm"}

Goal: remind them documents have been pending for ${daysPending}+ days and request they send them today. Keep it short. Hinglish.`;

    const r = await callDeepSeek({
      system,
      prompt: userPrompt,
      jsonResponse: false,
      maxTokens: 400,
      temperature: 0.6,
    });

    if (!r.ok || !r.content?.trim()) {
      console.error("DeepSeek reminder-message error:", r.reason);
      return res.json({
        ok: true,
        generated: false,
        message: fallbackMessage,
        reason: publicLlmFailureReason(r.reason || "LLM returned empty"),
      });
    }

    let message = r.content.trim();
    // Strip markdown code fences if any
    message = message
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/i, "")
      .trim();
    // Remove surrounding quotes if any
    if (
      (message.startsWith('"') && message.endsWith('"')) ||
      (message.startsWith("'") && message.endsWith("'"))
    ) {
      message = message.slice(1, -1).trim();
    }

    return res.json({ ok: true, generated: true, message });
  } catch (err) {
    console.error("generateReminderMessage error:", err);
    next(err);
  }
}

// In-memory cache for generated standard guidance (per server instance). Keeps
// repeat lookups instant and avoids re-calling the LLM for the same code.
const STANDARD_GUIDANCE_CACHE = new Map();

// Generate a concise reference summary for ANY audit/accounting standard or
// statutory provision code, so the extension's guidance page never dead-ends on
// codes that are not in the packaged standardDetails dictionary.
export async function generateStandardGuidance(req, res, next) {
  try {
    const code = safeStr(req.body?.code, 60).trim();
    if (!code || code.length < 2) {
      return res.status(400).json({ ok: false, error: "code required" });
    }

    const cacheKey = code.toLowerCase();
    if (STANDARD_GUIDANCE_CACHE.has(cacheKey)) {
      return res.json({
        ok: true,
        generated: true,
        code,
        guidance: STANDARD_GUIDANCE_CACHE.get(cacheKey),
        cached: true,
      });
    }

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        ok: true,
        generated: false,
        code,
        guidance: "",
        reason: "LLM not configured",
      });
    }

    const system =
      "You are an Indian Chartered Accountant. Provide a concise, practical reference summary of an Indian auditing/accounting standard or statutory provision as used in Indian statutory audit. Return plain text only, no markdown.";
    const prompt = `Provide a concise reference summary for "${code}" as used in Indian statutory audit / accounting.
Use short labelled lines:
Overview: what it is and its scope.
Key requirements: the core requirements.
Audit focus / procedures: what the auditor does.
Common risks / pitfalls.
Documentation / disclosures.
Keep it 120-200 words, professional and specific to Indian practice. If "${code}" is not a recognised standard or statutory provision, say so briefly and advise verifying against official ICAI / MCA / statutory sources.`;

    const r = await callDeepSeek({
      system,
      prompt,
      jsonResponse: false,
      maxTokens: 500,
      temperature: 0.2,
      timeoutMs: 30000,
      model: INSIGHTS_MODEL,
    });

    if (!r.ok || !r.content?.trim()) {
      console.error("DeepSeek standard-guidance error:", r.reason);
      return res.json({
        ok: true,
        generated: false,
        code,
        guidance: "",
        reason: publicLlmFailureReason(r.reason || "LLM returned empty"),
      });
    }

    const guidance = r.content
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/i, "")
      .trim();

    STANDARD_GUIDANCE_CACHE.set(cacheKey, guidance);
    if (STANDARD_GUIDANCE_CACHE.size > 500) {
      STANDARD_GUIDANCE_CACHE.delete(
        STANDARD_GUIDANCE_CACHE.keys().next().value,
      );
    }

    return res.json({ ok: true, generated: true, code, guidance });
  } catch (err) {
    console.error("generateStandardGuidance error:", err);
    next(err);
  }
}
