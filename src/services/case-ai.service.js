import { CASE_FIELD_NAMES } from "../models/CaseMatter.js";
import {
  boundedStringArray,
  boundedText,
  hashText,
  httpError,
  stableJson,
} from "./case-validation.service.js";
import {
  callDeepSeek,
  parseJsonObject,
} from "./deepseek-provider.service.js";

const FIELD_SET = new Set(CASE_FIELD_NAMES);
const ANALYSIS_KEYS = Object.freeze([
  "confirmedFacts",
  "missingInformation",
  "requestedActions",
  "deadlineSummary",
  "potentialResponseStructure",
  "riskIndicators",
  "professionalReviewQuestions",
]);
const REFERENCE_TOKEN = /\[\[REF:([a-f0-9]{24})\]\]/gi;
const VERIFIED_REFERENCE_MARKER_GLOBAL = /\[\[REF:[a-f0-9]{24}\]\]/gi;
const REPORTER_CITATION = /\b(?:AIR|SCC|ITR|Taxman|taxmann\.com|CTR|ELT|GSTL|STC|Comp Cas)\b/i;
const COURT_ASSERTION = /\b(?:Supreme Court|High Court|Tribunal|CESTAT|NCLAT|NCLT|ITAT)\b.{0,120}\b(?:held|ruled|observed|clarified|decided|directed)\b/i;
const CASE_NAME_CITATION = /\b[A-Z][A-Za-z0-9&.,'() -]{1,80}\s+(?:v\.?|vs\.?|versus)\s+[A-Z][A-Za-z0-9&.,'() -]{1,80}\b/;
const IDENTIFIED_AUTHORITY_INSTRUMENT = /\b(?:circular|notification|instruction|office memorandum|master (?:circular|direction)|guidance note|guideline|press release|order)\s+(?:(?:no|nos)\.?\s*)?[A-Z0-9][A-Z0-9./()_-]*(?:\s+of\s+\d{4})?\b/gi;
const AUTHORITY_DOCUMENT = /\b(?:circular|notification|instruction|office memorandum|master (?:circular|direction)|guidance note|guideline|press release|faq|order)\b/i;
const REGULATORY_AUTHORITY = /\b(?:CBDT|CBIC|Central Board of Direct Taxes|Central Board of Indirect Taxes(?: and Customs)?|RBI|Reserve Bank of India|SEBI|Securities and Exchange Board of India|MCA|Ministry of Corporate Affairs|GST Council|Income Tax Department|Ministry of Finance)\b/i;
const STATUTORY_AUTHORITY_SPAN = /\b(?:section|sec(?:tion)?\.?|u\/s|s\.|rule|r\.|regulation|reg\.|article|art\.)\s*[0-9A-Za-z][0-9A-Za-z()./-]*\b/gi;
const NAMED_LEGISLATION_SPAN = /\b(?:the\s+)?[A-Z][A-Za-z&'()-]*(?:\s+[A-Z0-9][A-Za-z0-9&'()-]*){0,8}\s+(?:Act|Rules|Regulations)(?:,\s*\d{4})?\b/gi;
const TRAILING_REFERENCE_MARKERS = /(?:\s*\[\[REF:[a-f0-9]{24}\]\])+\s*[.!?;:]?\s*$/i;

function regexMatchCount(value, expression) {
  return [...String(value || "").matchAll(new RegExp(expression.source, expression.flags))].length;
}

function splitAuthorityClaimUnits(content) {
  const units = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    const splitClauses = line
      .split(/(?<=[.!?;])\s+|\s+(?=(?:and|but|while|whereas)\s+(?:(?:section|sec(?:tion)?\.?|u\/s|s\.|rule|r\.|regulation|reg\.|article|art\.)\s*[0-9A-Za-z]|(?:the\s+)?[A-Z][A-Za-z&'()-]+\s+(?:Act|Rules|Regulations)\b))/i)
      .map((value) => value.trim())
      .filter(Boolean);
    const clauses = [];
    for (const clause of splitClauses) {
      const previous = clauses.at(-1);
      if (
        previous &&
        /(?:^|\s)(?:sec|s|r|reg|art)\.$/i.test(previous) &&
        /^\d[0-9A-Za-z()./-]*\b/.test(clause)
      ) {
        clauses[clauses.length - 1] = `${previous} ${clause}`;
      } else {
        clauses.push(clause);
      }
    }
    for (const clause of clauses) {
      if (/^(?:\[\[REF:[a-f0-9]{24}\]\]\s*)+$/i.test(clause) && units.length) {
        units[units.length - 1] = `${units[units.length - 1]} ${clause}`;
      } else {
        units.push(clause);
      }
    }
  }
  return units;
}

function strippedAuthorityRemainder(value, expressions) {
  let remainder = String(value || "").replace(VERIFIED_REFERENCE_MARKER_GLOBAL, " ");
  for (const expression of expressions) {
    remainder = remainder.replace(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`), " ");
  }
  return remainder
    .replace(/\b(?:and|or|of|the)\b/gi, " ")
    .replace(/[\d\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function authorityClaimShape(unit) {
  const value = String(unit || "");
  const statutorySpanCount = regexMatchCount(value, STATUTORY_AUTHORITY_SPAN);
  const legislationSpanCount = regexMatchCount(value, NAMED_LEGISLATION_SPAN);
  const instrumentCount = regexMatchCount(value, IDENTIFIED_AUTHORITY_INSTRUMENT);
  const bareStatutoryMention =
    statutorySpanCount + legislationSpanCount === 1 &&
    strippedAuthorityRemainder(value, [
      STATUTORY_AUTHORITY_SPAN,
      NAMED_LEGISLATION_SPAN,
    ]) === "";

  let count = bareStatutoryMention || statutorySpanCount + legislationSpanCount === 0
    ? 0
    : 1;
  count += instrumentCount;

  const genericAuthorityClaim =
    /https?:\/\/\S+/i.test(value) ||
    REPORTER_CITATION.test(value) ||
    COURT_ASSERTION.test(value) ||
    CASE_NAME_CITATION.test(value) ||
    (REGULATORY_AUTHORITY.test(value) &&
      strippedAuthorityRemainder(value, [REGULATORY_AUTHORITY]) !== "") ||
    (AUTHORITY_DOCUMENT.test(value) &&
      strippedAuthorityRemainder(value, [AUTHORITY_DOCUMENT]) !== "");
  if (genericAuthorityClaim && count === 0) count = 1;

  return {
    count,
    ambiguous:
      statutorySpanCount > 1 ||
      legislationSpanCount > 1 ||
      count > 1,
  };
}

function providerFailure(result) {
  throw httpError(503, result?.reason || "AI provider is unavailable", "CASE_AI_UNAVAILABLE");
}

function ensureJson(result) {
  if (!result.ok) providerFailure(result);
  const parsed = parseJsonObject(result.content);
  if (!parsed) throw httpError(502, "AI provider returned invalid structured output", "CASE_AI_INVALID_OUTPUT");
  return parsed;
}

function excerptAppearsInSource(excerpt, source) {
  const normalizedExcerpt = String(excerpt || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedSource = String(source || "").replace(/\s+/g, " ").toLowerCase();
  return normalizedExcerpt.length >= 3 && normalizedSource.includes(normalizedExcerpt);
}

async function proposeCaseExtraction(caseMatter) {
  const source = String(caseMatter?.source?.extractedText || "").trim();
  if (!source) throw httpError(422, "Source text is required for AI extraction");
  const fields = CASE_FIELD_NAMES.join(", ");
  const result = await callDeepSeek({
    system: "You extract facts from Indian tax and regulatory notices. Use source text only. Return strict JSON. Never infer a missing date, amount, DIN, period, section, authority, or citation.",
    prompt: `Return {"fields":[{"field":"allowed field","value":"source value","sourceText":"exact verbatim excerpt","confidence":0.0}]}.
Allowed fields: ${fields}.
Rules: sourceText must be an exact excerpt from SOURCE. Omit unknown fields. Dates use YYYY-MM-DD only when explicitly present. Monetary values remain source text; do not calculate. requestedDocuments value may be a JSON string array.
SOURCE:\n${source.slice(0, 90000)}`,
    jsonResponse: true,
    maxTokens: 2200,
    temperature: 0,
  });
  const parsed = ensureJson(result);
  const proposals = [];
  for (const item of Array.isArray(parsed.fields) ? parsed.fields.slice(0, 100) : []) {
    const field = typeof item?.field === "string" ? item.field.trim() : "";
    const value = typeof item?.value === "string" ? item.value.trim().slice(0, 4000) : "";
    const sourceText = typeof item?.sourceText === "string" ? item.sourceText.trim().slice(0, 1200) : "";
    const confidence = Number(item?.confidence);
    if (
      !FIELD_SET.has(field) ||
      !value ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !excerptAppearsInSource(sourceText, source)
    ) continue;
    proposals.push({
      field,
      value,
      sourceText,
      confidence,
      provider: result.provider,
      model: result.model,
      proposedAt: new Date(),
    });
  }
  if (!proposals.length) {
    throw httpError(422, "AI extraction produced no source-verifiable proposals", "CASE_AI_NO_VERIFIABLE_FIELDS");
  }
  return { proposals, provider: result.provider, model: result.model };
}

function confirmedFactsForPrompt(caseMatter) {
  const facts = caseMatter?.confirmedFacts?.toObject
    ? caseMatter.confirmedFacts.toObject()
    : { ...(caseMatter?.confirmedFacts || {}) };
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) =>
      value != null && value !== "" && (!Array.isArray(value) || value.length)
    )
  );
}

async function generateCaseAnalysis(caseMatter) {
  const facts = confirmedFactsForPrompt(caseMatter);
  if (!Object.keys(facts).length) {
    throw httpError(422, "Confirm at least one case fact before AI analysis");
  }
  const source = String(caseMatter?.source?.extractedText || "").slice(0, 80000);
  const result = await callDeepSeek({
    system: "You assist an Indian Chartered Accountant. Produce working analysis only. Confirmed facts are authoritative; source text is evidence, not permission to infer. Say Unknown when insufficient. Do not cite or invent case law, circulars, notifications, dates, sections, or legal conclusions.",
    prompt: `Return strict JSON with arrays for exactly these keys: ${ANALYSIS_KEYS.join(", ")}.
Each array contains concise strings. Never add citations. Any date/amount/section/DIN in output must appear in CONFIRMED_FACTS. Clearly label unknowns and professional-review questions.
CONFIRMED_FACTS:\n${stableJson(facts)}\nSOURCE_TEXT:\n${source}`,
    jsonResponse: true,
    maxTokens: 2600,
    temperature: 0.1,
  });
  const parsed = ensureJson(result);
  const output = {};
  for (const key of ANALYSIS_KEYS) {
    output[key] = boundedStringArray(parsed[key], key, { maxItems: 100, maxLength: 2000 });
  }
  if (!ANALYSIS_KEYS.some((key) => output[key].length)) {
    throw httpError(502, "AI analysis returned no usable sections", "CASE_AI_INVALID_OUTPUT");
  }
  assertDraftCitationSafety(
    ANALYSIS_KEYS.flatMap((key) => output[key]).join("\n"),
    []
  );
  return {
    output,
    provider: result.provider,
    model: result.model,
    confirmedFactsHash: hashText(stableJson(facts)),
  };
}

function assertDraftCitationSafety(
  content,
  references,
  { includeBindings = false } = {}
) {
  const allowed = new Set(references.map((reference) => String(reference._id).toLowerCase()));
  const used = [];
  REFERENCE_TOKEN.lastIndex = 0;
  let match;
  while ((match = REFERENCE_TOKEN.exec(content)) !== null) {
    const id = match[1].toLowerCase();
    if (!allowed.has(id)) {
      throw httpError(422, `Draft contains unverified reference ${id}`, "UNVERIFIED_CASE_REFERENCE");
    }
    used.push(id);
  }
  if (/\[\[REF:(?![a-f0-9]{24}\]\])/i.test(content)) {
    throw httpError(422, "Draft contains a malformed reference marker", "UNVERIFIED_CASE_REFERENCE");
  }
  const boundClaimMarkers = new Set();
  const authorityClaims = [];
  for (const unit of splitAuthorityClaimUnits(content)) {
    const claim = authorityClaimShape(unit);
    if (!claim.count) continue;
    if (claim.ambiguous) {
      throw httpError(
        422,
        "Put each authority claim in its own sentence or clause with its own verified [[REF:id]] marker",
        "AMBIGUOUS_CASE_CITATION_BINDING"
      );
    }
    const markers = [...unit.matchAll(new RegExp(
      VERIFIED_REFERENCE_MARKER_GLOBAL.source,
      VERIFIED_REFERENCE_MARKER_GLOBAL.flags
    ))].map((item) => item[0].toLowerCase());
    const trailing = unit.match(TRAILING_REFERENCE_MARKERS)?.[0] || "";
    const trailingMarkers = [...trailing.matchAll(new RegExp(
      VERIFIED_REFERENCE_MARKER_GLOBAL.source,
      VERIFIED_REFERENCE_MARKER_GLOBAL.flags
    ))].map((item) => item[0].toLowerCase());
    if (
      !markers.length ||
      trailingMarkers.length !== markers.length ||
      new Set(markers).size !== markers.length
    ) {
      throw httpError(
        422,
        "Each authority claim requires unique verified [[REF:id]] marker(s) at the end of that claim",
        "UNSOURCED_CASE_CITATION"
      );
    }
    if (markers.some((marker) => boundClaimMarkers.has(marker))) {
      throw httpError(
        422,
        "A verified [[REF:id]] marker can bind to only one authority claim",
        "AMBIGUOUS_CASE_CITATION_BINDING"
      );
    }
    markers.forEach((marker) => boundClaimMarkers.add(marker));
    const claimText = unit
      .replace(
        new RegExp(
          VERIFIED_REFERENCE_MARKER_GLOBAL.source,
          VERIFIED_REFERENCE_MARKER_GLOBAL.flags
        ),
        " "
      )
      .replace(/\s+/g, " ")
      .trim();
    authorityClaims.push({
      claimTextHash: hashText(claimText),
      referenceIds: markers.map((marker) =>
        marker.slice("[[REF:".length, -2).toLowerCase()
      ),
    });
  }
  const usedReferenceIds = [...new Set(used)];
  return includeBindings
    ? { usedReferenceIds, authorityClaims }
    : usedReferenceIds;
}

function buildDraftAuthorityBindings(content, references) {
  return assertDraftCitationSafety(content, references, {
    includeBindings: true,
  });
}

async function generateCaseDraft(caseMatter, references, instructions = "") {
  const facts = confirmedFactsForPrompt(caseMatter);
  if (!Object.keys(facts).length) {
    throw httpError(422, "Confirm case facts before generating a response draft");
  }
  const referenceBlock = references.length
    ? references.map((reference) => `[[REF:${reference._id}]] ${reference.title} | ${reference.locator} | ${reference.excerpt}`).join("\n")
    : "No verified references supplied. Do not cite any authority.";
  const result = await callDeepSeek({
    system: "Draft a professional response structure for review, never a final legal opinion. Use confirmed facts only. Do not invent facts, dates, authorities, cases, circulars, notifications, or citations. A supplied reference may be cited only with its exact [[REF:id]] token.",
    prompt: `Return strict JSON {"content":"draft text"}. Use placeholders for missing facts. Preserve every reference marker exactly. No automatic-submission language and no claim of legal correctness.
CONFIRMED_FACTS:\n${stableJson(facts)}\nVERIFIED_REFERENCES:\n${referenceBlock}\nUSER_INSTRUCTIONS:\n${boundedText(instructions, 4000, { label: "instructions" })}`,
    jsonResponse: true,
    maxTokens: 4000,
    temperature: 0.15,
  });
  const parsed = ensureJson(result);
  const content = boundedText(parsed.content, 250000, { required: true, label: "AI draft content" });
  const { usedReferenceIds, authorityClaims } = buildDraftAuthorityBindings(
    content,
    references
  );
  return {
    content,
    usedReferenceIds,
    authorityClaims,
    provider: result.provider,
    model: result.model,
  };
}

export {
  assertDraftCitationSafety,
  buildDraftAuthorityBindings,
  confirmedFactsForPrompt,
  generateCaseAnalysis,
  generateCaseDraft,
  proposeCaseExtraction,
};
