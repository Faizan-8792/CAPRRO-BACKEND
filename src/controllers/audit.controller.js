// src/controllers/audit.controller.js
// Hybrid NLP + DeepSeek LLM audit text classifier.
// The extension runs local NLP first, sends top-N candidates here.
// We ask DeepSeek to (a) confirm the text is actually audit/finance content,
// and (b) pick the best matching candidate or reject all.

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

function safeStr(v, max = 4000) {
  return String(v ?? "").slice(0, max);
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

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      // Graceful fallback: no key configured, return passthrough so extension can use its NLP result.
      return res.json({
        ok: true,
        refined: false,
        reason: "DEEPSEEK_API_KEY not configured on server",
      });
    }

    // If no candidates, short-circuit
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    let dsResp;
    try {
      dsResp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are a strict JSON-only classifier. Output only valid JSON, no extra text.",
            },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 400,
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      console.error("DeepSeek fetch error:", fetchErr.message);
      return res.json({
        ok: true,
        refined: false,
        reason: "LLM unreachable, falling back to NLP",
      });
    }
    clearTimeout(timeoutId);

    if (!dsResp.ok) {
      const errText = await dsResp.text().catch(() => "");
      console.error("DeepSeek error:", dsResp.status, errText.slice(0, 500));
      return res.json({
        ok: true,
        refined: false,
        reason: `LLM HTTP ${dsResp.status}`,
      });
    }

    const dsJson = await dsResp.json().catch(() => null);
    const content = dsJson?.choices?.[0]?.message?.content || "";

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try to extract a JSON block from the content
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* ignore */
        }
      }
    }

    if (!parsed || typeof parsed !== "object") {
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

    // Validate chosenId is one of the candidate IDs
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
