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
const MAX_TOTAL_INSIGHTS = 11; // 3 deterministic + up to 8 model-derived
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

// The three procedures every statutory audit response needs regardless of what
// the text says (SA 320/530 materiality, SA 505 confirmations, SA 580 written
// representations). Static and topic-independent, exactly as the previous
// prompt's own "ALWAYS include... in every response" rule already said they
// were - so nothing is lost by no longer asking a model to reproduce them.
// evidence is deliberately empty: these are standard-mandated, not derived from
// this document, and an empty evidence field says that honestly rather than
// inventing a quotation to satisfy the schema.
function buildMandatoryProcedures() {
  return [
    {
      title: "Determine materiality and sample basis",
      detail:
        "Determine materiality and performance materiality for this area and document the basis for sample size and item selection.",
      risk: "medium",
      standard: "SA 320, SA 530",
      evidence: "",
      why: "Materiality sets the threshold for what counts as a significant misstatement, so every other procedure in this area is scoped against it.",
      nextAction:
        "Record the materiality figure and sample basis in the working paper before testing individual items.",
      amountMinor: null,
      workingPaperRef: null,
    },
    {
      title: "Obtain external third-party confirmations",
      detail:
        "Obtain external third-party confirmations for balances, holdings or amounts in this area that involve outside parties such as banks, customers, suppliers, job-workers or lenders.",
      risk: "medium",
      standard: "SA 505",
      evidence: "",
      why: "A confirmation received directly from the third party is stronger evidence than internal correspondence, because it cannot be influenced by company management.",
      nextAction:
        "If a confirmation cannot be obtained, perform alternative procedures and document why the confirmation was unavailable.",
      amountMinor: null,
      workingPaperRef: null,
    },
    {
      title: "Obtain written representations from management",
      detail:
        "Obtain written representations from management covering the completeness and key assertions of this area.",
      risk: "medium",
      standard: "SA 580",
      evidence: "",
      why: "A written representation records management's acknowledgement of responsibility and does not replace other audit evidence.",
      nextAction:
        "File the signed representation with the working papers before forming a conclusion on this area.",
      amountMinor: null,
      workingPaperRef: null,
    },
  ];
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

function buildInsightsPrompt(rawText, topicLabel, packaged) {
  const contextBlock = packaged
    ? `\nKNOWN PROCEDURES for this audit area (select the ones THIS text actually supports; do not just restate all of them):\n${packaged.procedures.map((p) => `- ${p}`).join("\n")}\n\nKNOWN COMMON MISTAKES for this audit area (check whether THIS text shows evidence of any of these):\n${packaged.mistakes.map((m) => `- ${m}`).join("\n")}\n`
    : "";

  return `Read the audit text below. It may contain OCR noise, broken grammar, misspellings, abbreviations, ALL CAPS, or a Hindi-English (Hinglish) mix — infer the real meaning and do not be thrown off by formatting.

For the audit area "${topicLabel}", decide which of the KNOWN PROCEDURES below apply to THIS specific text, and whether THIS text shows evidence of any KNOWN COMMON MISTAKES. Produce ${MODEL_INSIGHT_TARGET} document-specific AUDIT PROCEDURES the engagement team must perform because of what THIS text actually says. This is selection and evidencing, not free generation, and it is audit documentation, not management commentary.
${contextBlock}
Hard rules:
- Each "detail" MUST be an audit procedure phrased as an imperative action, starting with a verb such as Obtain, Inspect, Confirm, Recompute, Trace, Vouch, Perform, Reconcile, Assess, Evaluate, Test, Determine, Select, Verify, Review, Examine, Request, Investigate or Quantify. Never write business or management advice.
- SURFACE THE EXACT FIGURE, NOT A VAGUE REFERENCE: when the text states a specific amount, party name, day count or date, the "title" and "detail" MUST quote that figure directly instead of a vague phrase. Write "Evaluate adequacy of provision for the Rs 62,00,000 receivable from Vantage Garments LLC, overdue 400+ days" — never "Evaluate adequacy of provision for the receivable". A reviewer scanning the list must see the stakes without re-opening the source text.
- STATE AN ALREADY-REACHED CONCLUSION AS A FACT, NOT AN OPEN QUESTION: if the text itself already states a finding, determination or conclusion (for example "credit control confirmed no recovery plan exists", "management decided X"), the "detail" MUST state that finding as an established fact (wording such as "has confirmed", "appears inadequate", "was already determined") and then name the next verification or escalation step. Do not phrase an already-reached conclusion as something that still needs open-ended "assessment" from zero — that understates what the source material already established.
- STANDARD SELECTION — cite the standard that actually governs the activity described, not merely one that sounds plausible:
  - Testing an existing accounting estimate or provision already made (doubtful-debt provision, warranty provision, impairment) → SA 540, not SA 315 (SA 315 is risk identification during planning, not testing an estimate that already exists).
  - External third-party confirmations (banks, customers, suppliers, lenders) → SA 505.
  - Related party transactions → SA 550. Fraud risk or management-override indicators → SA 240.
  - Subsequent events after the reporting date → SA 560 (with Ind AS 10 if disclosure is relevant). Going concern doubts → SA 570.
  - Reliance on a management expert or specialist → SA 620. Opening balances on a first engagement → SA 510.
  Cite a specific clause number ONLY when certain; otherwise cite the standard/Act without a number rather than guessing one.
- Each procedure MUST include "evidence": an exact, verbatim quotation of the specific amount, date, party, or transaction detail from the text below that makes this procedure apply. Quote the text exactly; do not paraphrase, translate, or invent a quotation. A procedure with no specific document evidence to quote must not be included here — the three universal procedures (materiality, confirmations, representations) are already handled separately and must NOT be repeated in your response.
- Do NOT invent facts. Only cite something that is actually written in the text below.
- Where relevant to what the text says, cover: a roll-forward/roll-back reconciliation if a count or verification date differs from the reporting date; the effect on going concern [SA 570]; a subsequent events review [SA 560 / Ind AS 10]; export or cross-border control-transfer timing; a formal cut-off test; and any indicator of fraud or management pressure on the numbers [SA 240].
- No generic filler, no repeated points, no two procedures citing the same evidence for the same purpose.
- "why": ONE short plain-language sentence with no jargon, explaining to a junior team member why this procedure or standard matters here — for example "A written confirmation direct from the customer is stronger evidence than internal correspondence, because it cannot be influenced by company management." Explain the REASON, do not repeat the detail text.
- "nextAction": ONE short sentence naming what the reviewer does depending on the outcome of this procedure — for example "If the provision is found inadequate, propose an adjusting entry and record it as an unadjusted misstatement for review."
- If the text genuinely does not contain enough specific detail to support ANY document-specific procedure (e.g. it is too short, too vague, or not really audit-relevant), set "result" to "INSUFFICIENT_EVIDENCE", give a one-sentence "insufficientEvidenceReason", and return an empty "insights" array. Do not force procedures onto text that does not support them.

Respond ONLY with JSON of this exact shape:
{"result": "SUPPORTED or INSUFFICIENT_EVIDENCE", "insufficientEvidenceReason": "required when result is INSUFFICIENT_EVIDENCE, empty string otherwise", "insights": [{"title": "short imperative procedure title with the specific figure included", "detail": "1-3 sentence executable audit procedure tied to the text, citing the standard, with specific figures and any already-reached conclusion stated as fact", "risk": "high|medium|low", "standard": "precise standard/section or empty string", "evidence": "exact quotation from the text below", "why": "one plain-language sentence explaining why this matters", "nextAction": "one sentence on what to do depending on the outcome"}]}

Keep title under 100 characters, detail under 320 characters, why under 220 characters, nextAction under 220 characters, and evidence under ${MAX_EVIDENCE_LENGTH} characters.

TEXT:
"""
${safeStr(rawText, INSIGHTS_TEXT_CAP)}
"""`;
}

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
function validateAndFilterInsights(
  rawItems,
  sentTextNormalized,
  sentTextOriginalCase,
) {
  const seenTitles = new Set();
  const accepted = [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    if (accepted.length >= MAX_MODEL_INSIGHTS) break;

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
    const prompt = buildInsightsPrompt(rawText, topicLabel, packaged);

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
        insights: buildMandatoryProcedures(),
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
    const validated = validateAndFilterInsights(
      rawItems,
      sentTextNormalized,
      sentTextOriginalCase,
    );

    if (validated.length === 0) {
      return res.json({
        ok: true,
        generated: true,
        insufficientEvidence: true,
        reason:
          "No procedure returned by the assistant could be grounded in specific evidence from this text.",
        insights: buildMandatoryProcedures(),
        ...(partial ? { partial: true } : {}),
      });
    }

    return res.json({
      ok: true,
      generated: true,
      insights: [...buildMandatoryProcedures(), ...validated].slice(
        0,
        MAX_TOTAL_INSIGHTS,
      ),
      ...(partial ? { partial: true } : {}),
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
