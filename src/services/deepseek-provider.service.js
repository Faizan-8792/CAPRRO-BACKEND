const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

function boundedString(value, max = 4000) {
  return String(value ?? "").slice(0, max);
}

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
        { role: "system", content: boundedString(system, 12000) },
        { role: "user", content: boundedString(prompt, 120000) },
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
      await response.text().catch(() => "");
      return { ok: false, reason: `LLM HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, reason: "LLM returned no content" };
    }
    return { ok: true, content, provider: "DEEPSEEK", model: DEEPSEEK_MODEL };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "LLM timeout" : "LLM request failed",
    };
  } finally {
    clearTimeout(timer);
  }
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
  callDeepSeek,
  parseJsonObject,
};
