// src/controllers/audit.controller.js
// Hybrid NLP + DeepSeek LLM audit text classifier.
// Plus: insights generation, reminder message generation.

import { callDeepSeek, parseJsonObject } from "../services/deepseek-provider.service.js";

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

// Canonical audit-area taxonomy (mirrors the extension's data/topics.json ids).
// Used so the LLM can classify against ALL areas even when the local keyword
// engine returns weak or no candidates (broken/OCR/garbled text). If a caller
// sends its own catalog, that is used instead (keeps ids single-sourced).
const AUDIT_TOPICS = [
  { id: "Inventory", name: "Inventory & Stock" },
  { id: "Revenue", name: "Revenue Recognition" },
  { id: "Receivables", name: "Accounts Receivable / Debtors" },
  { id: "Payables", name: "Accounts Payable / Creditors & Provisions" },
  { id: "FixedAssets", name: "Property, Plant & Equipment / Fixed Assets" },
  { id: "IntangibleAssets", name: "Intangible Assets & Goodwill" },
  { id: "CashBank", name: "Cash & Bank" },
  { id: "Borrowings", name: "Borrowings & Loans" },
  { id: "Equity", name: "Share Capital & Equity / Reserves" },
  { id: "Tax", name: "Taxation (Income Tax, GST, TDS, Deferred Tax)" },
  { id: "Payroll", name: "Payroll & Employee Benefits" },
  { id: "RelatedParty", name: "Related Party Transactions" },
  { id: "GoingConcern", name: "Going Concern" },
  { id: "EventsAfter", name: "Events After the Reporting Period" },
  { id: "Contingencies", name: "Contingencies, Provisions & Litigation" },
  { id: "Segment", name: "Segment Reporting" },
  { id: "Consolidation", name: "Consolidation & Group Accounts" },
  { id: "Fraud", name: "Fraud Risk (SA 240)" },
  { id: "InternalControls", name: "Internal Controls / ICFR" },
  { id: "CSR", name: "Corporate Social Responsibility (CSR)" },
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

Respond with ONLY this JSON (no markdown, no commentary):
{"isAuditText": boolean, "chosenId": string|null, "confidence": number, "reason": string}

TEXT:
"""
${safeStr(rawText, 3500)}
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
      maxTokens: 400,
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
      return res.json({ ok: true, refined: false, reason: "Could not parse LLM response" });
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
      isAuditText && chosenIdRaw && validIds.has(chosenIdRaw) ? chosenIdRaw : null;

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
// Given extracted text + chosen topic, generate 3-5 actionable, audit-specific
// insights tailored to the text (not generic).
export async function generateInsights(req, res, next) {
  try {
    const { rawText, topicId, topicName } = req.body || {};
    if (!rawText || typeof rawText !== "string") {
      return res.status(400).json({ ok: false, error: "rawText required" });
    }

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({ ok: true, generated: false, reason: "LLM not configured", insights: [] });
    }

    const system =
      "You are a senior Indian Chartered Accountant and audit manager. Return ONLY valid JSON. No markdown, no commentary.";

    const prompt = `Read the audit text below. It may contain OCR noise, broken grammar, misspellings, abbreviations, ALL CAPS, or a Hindi-English (Hinglish) mix — infer the real meaning and do not be thrown off by formatting.

For the audit area "${safeStr(topicName || topicId || "General audit", 100)}", list 3 to 6 SPECIFIC, ACTIONABLE checks a Chartered Accountant must perform for THIS text. Tie each point to something the text actually mentions (amounts, parties, dates, transactions). Reference the relevant Indian authority where apt (e.g. SA 501, SA 505, SA 240, Ind AS 2, Ind AS 36, Ind AS 37, Schedule II, Companies Act 2013, CGST Act, Income-tax Act). Avoid generic filler and do not repeat points.

Respond ONLY with JSON of this exact shape:
{"insights": [{"title": "short imperative title", "detail": "1-2 sentence concrete step tied to the text", "risk": "high|medium|low", "standard": "relevant standard/section or empty string"}]}

Keep title under 70 characters and detail under 220 characters. Be precise to the text content.

EXTRACTED TEXT:
"""
${safeStr(rawText, 3500)}
"""`;

    const r = await callDeepSeek({
      system,
      prompt,
      jsonResponse: true,
      maxTokens: 900,
      temperature: 0.25,
    });

    if (!r.ok) {
      return res.json({ ok: true, generated: false, reason: r.reason, insights: [] });
    }

    const parsed = parseJsonObject(r.content);
    const arr = Array.isArray(parsed?.insights) ? parsed.insights : [];
    const insights = arr
      .filter((i) => i && typeof i === "object")
      .slice(0, 6)
      .map((i) => ({
        title: safeStr(i.title, 100),
        detail: safeStr(i.detail, 350),
        risk: ["high", "medium", "low"].includes(String(i.risk).toLowerCase())
          ? String(i.risk).toLowerCase()
          : "medium",
        standard: safeStr(i.standard, 60),
      }))
      .filter((i) => i.title && i.detail);

    return res.json({ ok: true, generated: true, insights });
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
    message = message.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
    // Remove surrounding quotes if any
    if ((message.startsWith('"') && message.endsWith('"')) ||
        (message.startsWith("'") && message.endsWith("'"))) {
      message = message.slice(1, -1).trim();
    }

    return res.json({ ok: true, generated: true, message });
  } catch (err) {
    console.error("generateReminderMessage error:", err);
    next(err);
  }
}
