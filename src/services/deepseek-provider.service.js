const DEEPSEEK_URL =
  process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
// Models are env-configurable so provider naming changes never need a code
// deploy ("deepseek-chat" is retired). Default general model is the cheaper/
// faster "flash"; callers that need maximum accuracy (e.g. the classifier) pass
// an explicit model. Fallback is the higher-accuracy "pro" for reliability.
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_MODEL_FALLBACK =
  process.env.DEEPSEEK_MODEL_FALLBACK || "deepseek-v4-pro";

function boundedString(value, max = 4000) {
  return String(value ?? "").slice(0, max);
}

// Best-effort redaction of Indian PII / financial identifiers before any text
// leaves our servers for the third-party LLM. Applied at the single egress
// point (callDeepSeek) so every caller — classifier, insights, reminder,
// working papers — is covered. Order matters: composite identifiers (a GSTIN
// embeds a PAN) are redacted before their sub-patterns. Audit-topic semantics
// are preserved because only identifiers, not domain terms, are removed.
function redactPII(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    // GSTIN (15 chars): 2-digit state + PAN(5A4D1A) + entity/Z/checksum
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}\b/gi, "[GSTIN]")
    // PAN: 5 letters + 4 digits + 1 letter
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, "[PAN]")
    // Email address
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]")
    // Aadhaar: 12 digits, optionally grouped 4-4-4
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[AADHAAR]")
    // Indian mobile: optional +91/0 prefix + 10 digits starting 6-9
    .replace(/\b(?:\+91[\s-]?|0)?[6-9]\d{9}\b/g, "[PHONE]")
    // Long bare digit runs (bank account / long IDs)
    .replace(/\b\d{11,18}\b/g, "[NUM]");
}

function isRetriable(status) {
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}

// Single request attempt against one model. Returns { ok, content } or
// { ok:false, status, reason } so the caller can decide to retry / fall back.
async function attemptDeepSeek({
  apiKey,
  model,
  system,
  prompt,
  jsonResponse,
  maxTokens,
  timeoutMs,
  temperature,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model,
      messages: [
        { role: "system", content: boundedString(system, 12000) },
        // User content carries the caller's data — redact identifiers first.
        { role: "user", content: boundedString(redactPII(prompt), 120000) },
      ],
      temperature: Math.max(0, Math.min(1, Number(temperature) || 0)),
      max_tokens: Math.max(1, Math.min(8000, Number(maxTokens) || 600)),
    };
    if (jsonResponse) body.response_format = { type: "json_object" };

    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const snippet = boundedString(errBody, 400).replace(/\s+/g, " ").trim();
      console.error(`DeepSeek HTTP ${response.status} (model=${model}): ${snippet}`);
      return {
        ok: false,
        status: response.status,
        reason: `LLM HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
      };
    }
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, status: 502, reason: "LLM returned no content" };
    }
    return { ok: true, content, provider: "DEEPSEEK", model };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return {
      ok: false,
      status: timeout ? 504 : 0,
      reason: timeout ? "LLM timeout" : "LLM request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Resilient DeepSeek call: retries transient failures (network/timeout/429/5xx)
// up to twice per model, and falls back to a second model on a hard 400 (e.g.
// a retired/invalid model name) so provider changes degrade gracefully.
async function callDeepSeek({
  system,
  prompt,
  jsonResponse = false,
  maxTokens = 600,
  timeoutMs = 25000,
  temperature = 0.3,
  model,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "DEEPSEEK_API_KEY not configured" };
  }
  const primary = model || DEEPSEEK_MODEL;
  const models = [primary];
  if (DEEPSEEK_MODEL_FALLBACK && DEEPSEEK_MODEL_FALLBACK !== primary) {
    models.push(DEEPSEEK_MODEL_FALLBACK);
  }
  let last = { ok: false, reason: "LLM not attempted", status: 0 };
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await attemptDeepSeek({
        apiKey,
        model,
        system,
        prompt,
        jsonResponse,
        maxTokens,
        timeoutMs,
        temperature,
      });
      if (r.ok) return r;
      last = r;
      if (!isRetriable(r.status)) break;
      await new Promise((s) => setTimeout(s, 400 * (attempt + 1)));
    }
    // Try the fallback model only when another model could help: a hard 400
    // (bad/retired model name) or an exhausted transient. Auth/balance/param
    // errors (401/402/422) won't be fixed by a different model.
    if (last.status && !isRetriable(last.status) && last.status !== 400) break;
  }
  return { ok: false, reason: last.reason, provider: "DEEPSEEK" };
}

function parseJsonObject(content) {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const candidate = content.match(/\{[\s\S]*\}/)?.[0];
    if (!candidate) return null;
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export {
  DEEPSEEK_MODEL,
  boundedString,
  redactPII,
  callDeepSeek,
  parseJsonObject,
};
