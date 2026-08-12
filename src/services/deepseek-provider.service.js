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

// A business-document reference number, never itself PII, immediately preceding a
// digit run. A purchase order, GRN, cheque, invoice, bill, voucher, challan, sales
// order or generic order/transaction/receipt reference has exactly the same 8-14
// digit shape as an Aadhaar number or a long account-style ID, so the label alone is
// what tells the two apart. Deliberately does NOT include A/c, Account, DD or UTR:
// those name a bank or payment identifier, which is exactly the PII this function
// exists to remove, not a reference this function should protect.
const REFERENCE_LABEL =
  "(?:P\\.?O\\.?|Purchase\\s*Order|GRN|Cheque|Chq|Invoice|Inv|Bill|Voucher|Challan|" +
  "Order|Ref(?:erence)?|Txn|Transaction|Receipt|Sale\\s*Order|SO)" +
  "\\.?\\s*(?:No\\.?|Number|#)?\\s*[:#-]?\\s*";

// Aadhaar: 12 digits, optionally grouped 4-4-4, unless immediately preceded by a
// business-document reference label. Narrowed under B14/B6
// (EXTENSION-DESKTOP-FEATURE-PARITY.md §4): the original bare `\d{4}...` rule matched
// a purchase-order, GRN or cheque reference exactly as readily as a real Aadhaar
// number and destroyed it as "[AADHAAR]" before the model ever saw it, at the same
// time as the redaction correctly removing a genuine Aadhaar number a few words away.
const AADHAAR_RULE = new RegExp(
  `(?<!${REFERENCE_LABEL})\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b`,
  "gi",
);

// Long bare digit runs (bank account / long IDs), unless immediately preceded by a
// rupee sign, "Rs"/"INR", or a colon - the three shapes a stated integer-paise amount
// or a JSON minor-unit field actually takes on this surface. Narrowed under B14/B6:
// the original rule matched any 11-18 digit run with no such exemption, so an
// ordinary amount above roughly Rs 2.5 crore (>= 25,000,000,000 paise, 11 digits)
// was replaced with "[NUM]" and the figure the reviewer needed named was gone before
// the model read it - silently, since callDeepSeek never logs what redactPII changed.
const NUM_RULE =
  /(?<![:\uFF1A]\s*|\u20B9\s*|\bRs\.?\s*|\bINR\s*)\b\d{11,18}\b/gi;

// Best-effort redaction of Indian PII / financial identifiers before any text
// leaves our servers for the third-party LLM. Applied at the single egress
// point (callDeepSeek) so every caller — classifier, insights, reminder,
// working papers — is covered. Order matters: composite identifiers (a GSTIN
// embeds a PAN) are redacted before their sub-patterns. Audit-topic semantics
// are preserved because only identifiers, not domain terms, are removed.
function redactPII(text) {
  if (typeof text !== "string" || !text) return text;
  return (
    text
      // GSTIN (15 chars): 2-digit state + PAN(5A4D1A) + entity/Z/checksum
      .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}\b/gi, "[GSTIN]")
      // PAN: 5 letters + 4 digits + 1 letter
      .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, "[PAN]")
      // Email address
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]")
      .replace(AADHAAR_RULE, "[AADHAAR]")
      // Indian mobile: optional +91/0 prefix + 10 digits starting 6-9
      .replace(/\b(?:\+91[\s-]?|0)?[6-9]\d{9}\b/g, "[PHONE]")
      .replace(NUM_RULE, "[NUM]")
  );
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
      console.error(
        `DeepSeek HTTP ${response.status} (model=${model}): ${snippet}`,
      );
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

const asJsonObject = (p) =>
  p && typeof p === "object" && !Array.isArray(p) ? p : null;

// Light repair of common LLM JSON quirks: smart quotes and trailing commas.
function sanitizeJsonish(s) {
  return s
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

// Extract the first balanced { ... } object, ignoring braces inside strings, so
// prose/markdown around the object does not defeat parsing. Returns null if the
// object never closes (truncated output).
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Recover a JSON object truncated mid-value (model hit the token cap): drop any
// dangling partial key/value, close an open string, and append the missing
// closing brackets so the fields already emitted (e.g. the classification)
// still parse.
function repairTruncatedJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let s = text.slice(start);
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) s += '"'; // close an unterminated string literal
  // Strip a dangling partial trailer so the completed fields still parse:
  //   , "key": "val   (half value)   |   , "partialKey   (no colon yet)   |   ,
  s = s
    .replace(/,\s*"[^"]*"\s*:\s*("[^"]*")?\s*$/, "")
    .replace(/,\s*"[^"]*"?\s*$/, "")
    .replace(/,\s*$/, "");
  while (stack.length) s += stack.pop();
  return s;
}

// Robustly extract a JSON object from LLM output. Handles pure JSON, markdown
// code fences, surrounding prose, minor formatting quirks, and truncation.
function parseJsonObject(content) {
  if (typeof content !== "string") return null;
  const tryParse = (s) => {
    try {
      return asJsonObject(JSON.parse(s));
    } catch {
      return null;
    }
  };

  const trimmed = content.trim();
  let out = tryParse(trimmed);
  if (out) return out;

  // Strip markdown code fences the model may add despite JSON mode.
  const cleaned = trimmed
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  out = tryParse(cleaned) || tryParse(sanitizeJsonish(cleaned));
  if (out) return out;

  // First balanced object (tolerates surrounding prose).
  const balanced = extractFirstJsonObject(cleaned);
  if (balanced) {
    out = tryParse(balanced) || tryParse(sanitizeJsonish(balanced));
    if (out) return out;
  }

  // Truncated object: repair and retry so emitted fields are recovered.
  const repaired = repairTruncatedJson(cleaned);
  if (repaired) {
    out = tryParse(repaired) || tryParse(sanitizeJsonish(repaired));
    if (out) return out;
  }

  // Last resort: greedy first-{ to last-} with light sanitising.
  const greedy = cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) {
    out = tryParse(greedy) || tryParse(sanitizeJsonish(greedy));
    if (out) return out;
  }
  return null;
}

// True only when parseJsonObject can succeed at all, and only via the
// truncation-repair path above - i.e. the raw model output hit max_tokens
// mid-object and never closed cleanly. Mirrors parseJsonObject's own attempt
// order exactly so the two can never disagree about which path a given
// response actually took.
//
// Exported so a caller can label a recovered result as partial rather than
// silently returning it as complete. Added under B4 (EXTENSION-DESKTOP-FEATURE-
// PARITY.md): the insights endpoint previously returned generated:true with no
// signal that repairTruncatedJson had fired, so the document-specific findings
// lost to truncation were dropped without anyone - server log or client - ever
// being told.
function wasJsonTruncated(content) {
  if (typeof content !== "string") return false;
  const tryParse = (s) => {
    try {
      return asJsonObject(JSON.parse(s));
    } catch {
      return null;
    }
  };

  const trimmed = content.trim();
  if (tryParse(trimmed)) return false;

  const cleaned = trimmed
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  if (tryParse(cleaned) || tryParse(sanitizeJsonish(cleaned))) return false;

  const balanced = extractFirstJsonObject(cleaned);
  if (balanced && (tryParse(balanced) || tryParse(sanitizeJsonish(balanced)))) {
    return false;
  }

  // Every clean path failed. Only the repair path is left, so success from here
  // on means the object was genuinely truncated mid-value.
  const repaired = repairTruncatedJson(cleaned);
  return Boolean(
    repaired && (tryParse(repaired) || tryParse(sanitizeJsonish(repaired))),
  );
}

export {
  DEEPSEEK_MODEL,
  boundedString,
  redactPII,
  callDeepSeek,
  parseJsonObject,
  wasJsonTruncated,
};
