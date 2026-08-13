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
        reason: r.reason,
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
// procedures no longer come from here, and an evidence-grounded set of 4-6 is a
// higher bar than 6-8 ungrounded ones.
const MODEL_INSIGHT_TARGET = "4 to 6";
const MAX_MODEL_INSIGHTS = 6;
const MAX_TOTAL_INSIGHTS = 9; // 3 deterministic + up to 6 model-derived
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
    },
    {
      title: "Obtain external third-party confirmations",
      detail:
        "Obtain external third-party confirmations for balances, holdings or amounts in this area that involve outside parties such as banks, customers, suppliers, job-workers or lenders.",
      risk: "medium",
      standard: "SA 505",
      evidence: "",
    },
    {
      title: "Obtain written representations from management",
      detail:
        "Obtain written representations from management covering the completeness and key assertions of this area.",
      risk: "medium",
      standard: "SA 580",
      evidence: "",
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
- Each "detail" MUST be an audit procedure phrased as an imperative action, starting with a verb such as Obtain, Inspect, Confirm, Recompute, Trace, Vouch, Perform, Reconcile, Assess, Evaluate, Test, Determine, Select, Verify, Review, Examine or Request. Never write business or management advice.
- Each procedure MUST include "evidence": an exact, verbatim quotation of the specific amount, date, party, or transaction detail from the text below that makes this procedure apply. Quote the text exactly; do not paraphrase, translate, or invent a quotation. A procedure with no specific document evidence to quote must not be included here — the three universal procedures (materiality, confirmations, representations) are already handled separately and must NOT be repeated in your response.
- Do NOT invent facts. Only cite something that is actually written in the text below.
- Where relevant to what the text says, cover: a roll-forward/roll-back reconciliation if a count or verification date differs from the reporting date; the effect on going concern [SA 570]; a subsequent events review [SA 560 / Ind AS 10]; export or cross-border control-transfer timing; a formal cut-off test; and any indicator of fraud or management pressure on the numbers [SA 240].
- Reference the precise standard or section (e.g. SA 501, SA 505, SA 240, SA 315, Ind AS 115, Schedule II/III, Companies Act 2013, CARO 2020, Form 3CD, CGST Act). Cite a specific clause number ONLY when certain; otherwise cite the standard/Act without a number rather than guessing one.
- No generic filler, no repeated points, no two procedures citing the same evidence for the same purpose.
- If the text genuinely does not contain enough specific detail to support ANY document-specific procedure (e.g. it is too short, too vague, or not really audit-relevant), set "result" to "INSUFFICIENT_EVIDENCE", give a one-sentence "insufficientEvidenceReason", and return an empty "insights" array. Do not force procedures onto text that does not support them.

Respond ONLY with JSON of this exact shape:
{"result": "SUPPORTED or INSUFFICIENT_EVIDENCE", "insufficientEvidenceReason": "required when result is INSUFFICIENT_EVIDENCE, empty string otherwise", "insights": [{"title": "short imperative procedure title", "detail": "1-3 sentence executable audit procedure tied to the text, citing the standard", "risk": "high|medium|low", "standard": "precise standard/section or empty string", "evidence": "exact quotation from the text below"}]}

Keep title under 80 characters, detail under 300 characters, and evidence under ${MAX_EVIDENCE_LENGTH} characters.

TEXT:
"""
${safeStr(rawText, INSIGHTS_TEXT_CAP)}
"""`;
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Fix for M2: the previous grounding mechanism was one sentence of prose with
// no field a citation could go in, so nothing could check that a cited amount
// actually appeared anywhere in the input. This is the check. It runs against
// the text the model was actually sent (capped at INSIGHTS_TEXT_CAP), because
// that is the only text the model could truthfully quote from.
function evidenceIsGrounded(evidence, sentTextNormalized) {
  const normalized = normalizeWhitespace(evidence);
  if (
    normalized.length < MIN_EVIDENCE_LENGTH ||
    normalized.length > MAX_EVIDENCE_LENGTH
  ) {
    return false;
  }
  return sentTextNormalized.includes(normalized.toLowerCase());
}

function isImperativeDetail(detail) {
  const firstWord =
    String(detail || "")
      .trim()
      .split(/\s+/, 1)[0] || "";
  return IMPERATIVE_VERBS.has(
    firstWord.replace(/[^A-Za-z]/g, "").toUpperCase(),
  );
}

// Fix for B5's output gate: rejects a duplicate procedure (by normalized
// title), a detail with no imperative verb, and any procedure whose evidence
// does not resolve against the text the model was actually sent. What remains
// is capped and field-bounded the same way the previous version always was.
function validateAndFilterInsights(rawItems, sentTextNormalized) {
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
    if (!evidenceIsGrounded(evidence, sentTextNormalized)) continue;

    seenTitles.add(normalizedTitle);
    accepted.push({
      title,
      detail,
      risk: ["high", "medium", "low"].includes(String(item.risk).toLowerCase())
        ? String(item.risk).toLowerCase()
        : "medium",
      standard: safeStr(item.standard, 60).trim(),
      evidence: normalizeWhitespace(evidence).slice(0, MAX_EVIDENCE_LENGTH),
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

    // Fix for M3: raised from 1600. The deterministic block no longer competes
    // for tokens, but each remaining item now also carries an evidence quote,
    // so headroom is kept generous rather than tuned to a single fixture.
    const r = await callDeepSeek({
      system,
      prompt,
      jsonResponse: true,
      maxTokens: 3000,
      temperature: 0.2,
      timeoutMs: 40000,
      model: INSIGHTS_MODEL,
    });

    if (!r.ok) {
      return res.json({
        ok: true,
        generated: false,
        reason: r.reason,
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
    // as the prompt), normalized the same way on both sides.
    const sentTextNormalized = normalizeWhitespace(
      safeStr(rawText, INSIGHTS_TEXT_CAP),
    ).toLowerCase();

    const rawItems = Array.isArray(parsed.insights) ? parsed.insights : [];
    const validated = validateAndFilterInsights(rawItems, sentTextNormalized);

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

// ─── Reminder message generation ────────────────────────────────────
// Generate a personalized client follow-up message in Hinglish.
export async function generateReminderMessage(req, res, next) {
  try {
    const {
      clientName,
      serviceType,
      type, // "pending" | "risk"
      daysPending,
      lastDelayDays,
      dueDate,
      tone, // "polite" | "firm" | "casual"
    } = req.body || {};

    if (!clientName || typeof clientName !== "string") {
      return res.status(400).json({ ok: false, error: "clientName required" });
    }

    const fallbackMessage = (() => {
      const dueText = dueDate
        ? new Date(dueDate).toLocaleDateString("en-IN")
        : "upcoming due date";
      if (type === "pending") {
        return `Hi ${clientName},\n\nHum aapke ${serviceType || "compliance"} ke documents ka wait kar rahe hain. ${daysPending || 3}+ din se documents pending hain.\nDue: ${dueText}.\n\nKripya documents jaldi share karein.\n\n- CA PRO Toolkit`;
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

    const dueText = dueDate
      ? new Date(dueDate).toLocaleDateString("en-IN")
      : "upcoming";

    const system =
      "You write professional client follow-up messages for Indian Chartered Accountants. Tone is warm but professional. Use a natural Hinglish (Hindi-English mix) style common in CA-client communication. Keep messages 60-100 words. Sign off as '- CA PRO Toolkit'. Return only the message text, no quotes, no commentary.";

    const userPrompt =
      type === "risk"
        ? `Write a polite WhatsApp/email follow-up message to a chronically late client.

Client name: ${safeStr(clientName, 80)}
Service: ${safeStr(serviceType || "compliance", 30)}
Last period delay: ${Number(lastDelayDays || 0)} days late
Current due date: ${dueText}
Tone: ${tone === "firm" ? "firm but respectful" : "polite and supportive"}

Goal: gently remind them that last 2 filings were late and request they share documents earlier this time. Keep it short. Hinglish.`
        : `Write a polite WhatsApp/email follow-up message asking client to share pending documents.

Client name: ${safeStr(clientName, 80)}
Service: ${safeStr(serviceType || "compliance", 30)}
Days pending: ${Number(daysPending || 3)}
Due date: ${dueText}
Tone: ${tone === "firm" ? "firm but respectful" : "polite and warm"}

Goal: remind them documents have been pending for ${Number(daysPending || 3)}+ days and request they send them today. Keep it short. Hinglish.`;

    const r = await callDeepSeek({
      system,
      prompt: userPrompt,
      jsonResponse: false,
      maxTokens: 400,
      temperature: 0.6,
    });

    if (!r.ok || !r.content?.trim()) {
      return res.json({
        ok: true,
        generated: false,
        message: fallbackMessage,
        reason: r.reason || "LLM returned empty",
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
      return res.json({
        ok: true,
        generated: false,
        code,
        guidance: "",
        reason: r.reason || "LLM returned empty",
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
