// src/controllers/audit.controller.js
// Hybrid NLP + DeepSeek LLM audit text classifier.
// Plus: insights generation, reminder message generation.

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

function safeStr(v, max = 4000) {
  return String(v ?? "").slice(0, max);
}

// ─── Reusable DeepSeek call helper ─────────────────────────────────
async function callDeepSeek({
  system,
  prompt,
  jsonResponse = false,
  maxTokens = 600,
  timeoutMs = 25000,
  temperature = 0.3,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "DEEPSEEK_API_KEY not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonResponse) body.response_format = { type: "json_object" };

    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return { ok: false, reason: `LLM HTTP ${r.status}`, detail: errText.slice(0, 300) };
    }

    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content || "";
    return { ok: true, content };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: err.name === "AbortError" ? "LLM timeout" : err.message };
  }
}

function buildPrompt(rawText, candidates) {
  const candidatesBlock = candidates
    .map(
      (c, i) =>
        `[${i + 1}] id="${c.id}" name="${c.name || c.id}" score=${c.score} hits=${c.hits} keywords=${(c.keywords || []).slice(0, 8).join(", ")}`
    )
    .join("\n");

  return `You are an expert auditing text classifier for Indian Chartered Accountants.

Task: Decide whether the provided EXTRACTED_TEXT is genuinely about an audit/accounting topic, and if so pick the single best matching candidate id.

Rules:
- If the text is unrelated to audit/accounting/finance (e.g. job applications, news, marketing, recipes), respond with isAuditText=false.
- If the text mentions audit terminology incidentally only (e.g. "software" used to describe a job listing, not a software intangible asset), set isAuditText=false.
- Only set isAuditText=true when the text describes an audit area, financial transaction, accounting standard, compliance, or similar.
- Pick the candidate id that BEST matches the meaning of the text. If none match well, set chosenId=null and isAuditText=false.
- confidence is 0.0 to 1.0 reflecting your certainty. Be strict; do not inflate.

Respond ONLY with a JSON object of this exact shape (no markdown, no commentary):
{"isAuditText": boolean, "chosenId": string|null, "confidence": number, "reason": string}

EXTRACTED_TEXT:
"""
${safeStr(rawText, 3500)}
"""

CANDIDATES (from local NLP engine):
${candidatesBlock || "(none)"}
`;
}

export async function refineAuditClassification(req, res, next) {
  try {
    const { rawText, candidates } = req.body || {};

    if (!rawText || typeof rawText !== "string") {
      return res.status(400).json({ ok: false, error: "rawText required" });
    }
    if (!Array.isArray(candidates)) {
      return res.status(400).json({ ok: false, error: "candidates array required" });
    }

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        ok: true,
        refined: false,
        reason: "DEEPSEEK_API_KEY not configured on server",
      });
    }

    if (!candidates.length) {
      return res.json({
        ok: true,
        refined: true,
        isAuditText: false,
        chosenId: null,
        confidence: 0.05,
        reason: "No NLP candidates",
      });
    }

    const prompt = buildPrompt(rawText, candidates);
    const r = await callDeepSeek({
      system: "You are a strict JSON-only classifier. Output only valid JSON, no extra text.",
      prompt,
      jsonResponse: true,
      maxTokens: 400,
      temperature: 0.1,
    });

    if (!r.ok) {
      console.error("DeepSeek refine error:", r.reason);
      return res.json({ ok: true, refined: false, reason: r.reason });
    }

    let parsed = null;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      const m = r.content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {}
      }
    }

    if (!parsed || typeof parsed !== "object") {
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

    const validIds = new Set(candidates.map((c) => String(c.id || "")));
    const chosenId =
      chosenIdRaw && validIds.has(chosenIdRaw) ? chosenIdRaw : null;

    return res.json({
      ok: true,
      refined: true,
      isAuditText,
      chosenId,
      confidence: confidence ?? (isAuditText ? 0.6 : 0.1),
      reason,
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
      "You are a senior Chartered Accountant audit advisor. Return only valid JSON. No markdown.";

    const prompt = `Given this audit text and the matched topic, generate 3-5 SPECIFIC, ACTIONABLE insights an auditor should pay attention to in THIS specific text. Avoid generic advice. Focus on concrete things mentioned in the text.

Topic: ${safeStr(topicName || topicId || "General Audit", 100)}

EXTRACTED TEXT:
"""
${safeStr(rawText, 3500)}
"""

Respond ONLY with JSON of this exact shape:
{"insights": [{"title": "short title", "detail": "1-2 sentence specific recommendation", "risk": "high|medium|low"}]}

Keep title under 60 characters. Detail under 200 characters. Be precise to the text content.`;

    const r = await callDeepSeek({
      system,
      prompt,
      jsonResponse: true,
      maxTokens: 800,
      temperature: 0.3,
    });

    if (!r.ok) {
      return res.json({ ok: true, generated: false, reason: r.reason, insights: [] });
    }

    let parsed = null;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      const m = r.content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {}
      }
    }

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
