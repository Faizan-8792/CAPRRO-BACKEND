// The structured finding object, and rendering as a separate step.
//
// AA-09 in .kiro/audit-assistance-defects.md, recorded there as "the architectural change that
// resolves several of these at once". A caller supplied a schema - FACT / RISK / ASSERTIONS /
// STANDARD / PROCEDURE / EVIDENCE / SAMPLING / ACCOUNTING IMPLICATION / FRAUD INDICATOR /
// ESCALATION / WORKING-PAPER STATUS / MISSING INFORMATION - and the pipeline ignored it in favour
// of its own flat shape, because the flat shape WAS the output. There was no finding object; there
// was a paragraph with a title.
//
// WHAT CHANGES AND WHAT DELIBERATELY DOES NOT
// The flat fields stay exactly as they are. The desktop app reads Title, Detail, Risk, Standard,
// Evidence, Why, NextAction, AmountMinor and WorkingPaperRef, and the extension reads the same
// wire shape; replacing them would break both products to satisfy an internal refactor. So the
// structured object is ADDED alongside as `structured`, and rendering becomes a separate function
// that can regenerate the reader-facing text FROM the object. That is what makes the shape data
// rather than prose: something else can now read a finding's parts without parsing a sentence.
//
// THE RULE THAT GOVERNS EVERY DERIVATION BELOW
// A field whose value the document does not supply is `null`, and null is reported in
// missingInformation. It is never filled with a plausible default. An assertion set nobody can
// justify, an evidence rank nobody can support, or a sampling basis nobody chose would each be a
// fabrication wearing a schema, and a schema makes a fabrication look more authoritative rather
// than less.

import {
  classifySubsequentEvent,
  findQualitativeMateriality,
} from "./audit-aggregation.service.js";
import {
  assessFraudTriangle,
  buildAlternativeProcedures,
  buildEscalationPath,
  buildEstimateFramework,
  findPrecedentQuestions,
} from "./audit-reasoning.service.js";
import {
  FINDING_STATUS,
  classifyFindingStatus,
  isStatusPermitted,
  findUnknownStandardReferences,
} from "./audit-finding-guard.service.js";

/** Bumped only when the shape changes in a way a consumer must notice. */
export const FINDING_SCHEMA_VERSION = 1;

/**
 * Every section the caller's schema asked for. The list is exported so a test can assert the
 * object carries all of them rather than the handful somebody remembered.
 */
export const STRUCTURED_SECTIONS = Object.freeze([
  "fact",
  "risk",
  "assertions",
  "standards",
  "procedure",
  "evidence",
  "sampling",
  "accountingImplication",
  "fraudIndicator",
  "escalation",
  "workingPaperStatus",
  "missingInformation",
  "priority",
  "subsequentEvent",
  "qualitativeMateriality",
  "precedentQuestions",
  "fraudTriangle",
  "estimateFramework",
  "alternativeProcedures",
]);

/** The assertions an audit procedure can be directed at. */
export const ASSERTIONS = Object.freeze({
  EXISTENCE: "existence or occurrence",
  COMPLETENESS: "completeness",
  VALUATION: "valuation and allocation",
  ACCURACY: "accuracy",
  RIGHTS: "rights and obligations",
  CUTOFF: "cut-off",
  CLASSIFICATION: "classification",
  PRESENTATION: "presentation and disclosure",
});

/**
 * AA-08. Which assertions a finding is actually about, derived from its subject matter.
 *
 * Deterministic on purpose: an assertion set is the kind of thing a model will happily produce for
 * any finding, and a plausible-looking wrong set is worse than none - it tells an auditor the
 * procedure is directed at completeness when it only ever tested existence.
 */
const ASSERTION_CUES = [
  {
    pattern: /\binventor|\bstock\b|\bphysical verification\b|\bcycle count\b|\bgodown\b/i,
    assertions: [ASSERTIONS.EXISTENCE, ASSERTIONS.VALUATION, ASSERTIONS.RIGHTS],
  },
  {
    pattern: /\brevenue\b|\bsales\b|\bdispatch|\bturnover\b|\bcut[- ]?off\b|\bbill of lading\b/i,
    assertions: [ASSERTIONS.EXISTENCE, ASSERTIONS.CUTOFF, ASSERTIONS.ACCURACY],
  },
  {
    pattern: /\breceivable|\bdebtor|\bageing\b|\brecoverab|\bECL\b|\bcirculari[sz]/i,
    assertions: [ASSERTIONS.EXISTENCE, ASSERTIONS.VALUATION, ASSERTIONS.RIGHTS],
  },
  {
    pattern: /\bpayable|\bcreditor|\baccrual|\bprovision\b|\bwarrant(?:y|ies)\b|\bgratuity\b/i,
    assertions: [ASSERTIONS.COMPLETENESS, ASSERTIONS.VALUATION],
  },
  {
    pattern: /\brelated part|\bdirector'?s?\b|\bkey managerial\b|\bcommon director/i,
    assertions: [ASSERTIONS.COMPLETENESS, ASSERTIONS.PRESENTATION],
  },
  {
    pattern: /\bgoing concern\b|\brefinanc|\bcovenant\b|\bnet current liabilit/i,
    assertions: [ASSERTIONS.PRESENTATION, ASSERTIONS.CLASSIFICATION],
  },
  {
    pattern: /\bfixed asset|\bdepreciat|\bcapitalis|\bcapitaliz|\bCWIP\b|\bimpairment\b/i,
    assertions: [ASSERTIONS.EXISTENCE, ASSERTIONS.VALUATION, ASSERTIONS.RIGHTS],
  },
  {
    pattern: /\bstatutory dues?\b|\bTDS\b|\bGST\b|\bprovident fund\b|\bESI\b/i,
    assertions: [ASSERTIONS.COMPLETENESS, ASSERTIONS.ACCURACY, ASSERTIONS.PRESENTATION],
  },
  {
    pattern: /\blitigation\b|\blegal claim|\bcontingent\b|\bshow cause\b|\bdisputed demand/i,
    assertions: [ASSERTIONS.COMPLETENESS, ASSERTIONS.VALUATION, ASSERTIONS.PRESENTATION],
  },
  {
    pattern: /\bsubsequent to the (?:year|reporting)|\bafter the (?:year|reporting)[\s-]?end\b/i,
    assertions: [ASSERTIONS.PRESENTATION, ASSERTIONS.CUTOFF],
  },
  {
    pattern: /\bjournal entr|\bmanual entr|\bJE\b|\breclassif/i,
    assertions: [ASSERTIONS.EXISTENCE, ASSERTIONS.ACCURACY, ASSERTIONS.CLASSIFICATION],
  },
  {
    pattern: /\bborrowing|\bloan\b|\brepayment|\binstal?ment\b|\boverdraft\b/i,
    assertions: [ASSERTIONS.COMPLETENESS, ASSERTIONS.CLASSIFICATION, ASSERTIONS.PRESENTATION],
  },
];

export function deriveAssertions(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return [];
  const found = new Set();
  for (const cue of ASSERTION_CUES) {
    if (cue.pattern.test(value)) for (const a of cue.assertions) found.add(a);
  }
  // Order is fixed so two runs on the same finding produce the same list.
  return Object.values(ASSERTIONS).filter((a) => found.has(a));
}

// ── AA-10: auditing, accounting and legal guidance are different questions ──

const AUDIT_STANDARD = /\b(?:SA|SQC|SRE|SAE|SRS)\s?\d{1,4}\b/g;
const ACCOUNTING_STANDARD = /\b(?:Ind\s+AS|IND\s+AS|AS|IFRS|IAS)\s?\d{1,3}\b/g;
const LEGAL_REFERENCE =
  /\b(?:section|sec\.?|rule|clause|schedule)\s+\d+[A-Za-z]*(?:\(\d+\))*(?:\([a-z]\))?\b|\bCARO\b|\bCompanies Act(?:,?\s*\d{4})?\b|\bCGST Act\b|\bIncome[- ]tax Act\b/gi;

/**
 * Splits a citation string into the three kinds of authority it may contain.
 *
 * SA 500 is an audit-evidence standard and cannot answer a recognition question; citing it for one
 * was the defect. Each field is null when the string names nothing of that kind, rather than
 * repeating the whole string three times so every field looks populated.
 */
export function splitStandards(standard) {
  const value = typeof standard === "string" ? standard : "";
  const pick = (pattern) => {
    pattern.lastIndex = 0;
    const hits = [...value.matchAll(pattern)].map((m) => m[0].replace(/\s+/g, " ").trim());
    return hits.length > 0 ? [...new Set(hits)].join(", ") : null;
  };
  const accounting = pick(ACCOUNTING_STANDARD);
  const audit = pick(AUDIT_STANDARD);
  const legal = pick(LEGAL_REFERENCE);
  return { audit, accounting, legal };
}

// ── AA-14: not all evidence is worth the same ──────────────────────────────

export const EVIDENCE_RANK = Object.freeze({
  EXTERNAL_DIRECT: "external, received directly by the auditor",
  EXTERNAL_INDIRECT: "external, but routed through the client",
  INTERNAL_DOCUMENT: "generated by the client",
  MANAGEMENT_REPRESENTATION: "a statement by management",
  UNKNOWN: null,
});

const EVIDENCE_RANK_CUES = [
  {
    rank: EVIDENCE_RANK.EXTERNAL_DIRECT,
    pattern:
      /\breceived directly\b|\bdirect(?:ly)? from the (?:bank|customer|supplier|lender)\b|\bindependent confirmation\b|\bcirculari[sz]ed\b/i,
  },
  {
    rank: EVIDENCE_RANK.EXTERNAL_INDIRECT,
    pattern:
      /\bforwarded by\b|\bprovided by the (?:finance|accounts) (?:manager|team)\b|\bcopy supplied by the client\b/i,
  },
  {
    rank: EVIDENCE_RANK.MANAGEMENT_REPRESENTATION,
    pattern:
      /\bmanagement (?:has )?(?:confirmed|represents?|stated|advised)\b|\brepresentation letter\b|\bmanagement asserts\b/i,
  },
  {
    rank: EVIDENCE_RANK.INTERNAL_DOCUMENT,
    pattern:
      /\bledger\b|\bregister\b|\bschedule\b|\binvoice\b|\bvoucher\b|\bchallan\b|\bworking paper\b|\binternal\b/i,
  },
];

/**
 * The rank of the evidence a finding rests on, or null when the wording does not say.
 *
 * Null matters here: "we could not tell what kind of evidence this is" is a different and more
 * honest statement than "internal", and it lands in missingInformation where an auditor will see
 * it.
 */
export function deriveEvidenceRank(evidenceText) {
  const value = typeof evidenceText === "string" ? evidenceText : "";
  if (!value.trim()) return null;
  for (const cue of EVIDENCE_RANK_CUES) {
    if (cue.pattern.test(value)) return cue.rank;
  }
  return null;
}

// ── AA-11 / AA-12: whether sampling is even the right instrument ────────────

const POPULATION_SIZE = /\b(\d{1,5})\s+(?:journal entr|entries|items|invoices|vouchers|transactions|balances|samples)/i;
// No closing \b: these are STEMS, and "journal entr" followed by \b cannot match "journal entries".
// That is the fifth time this one bug class has bitten in this project - see standing rule 6 in
// .kiro/audit-assistance-defects.md - and it was caught here by a fixture, again, rather than by
// reading the pattern.
const WHOLE_POPULATION_CUE =
  /\ball\s+(?:of\s+)?(?:the\s+)?(?:journal\s+entr|entr|item|invoice|voucher|transaction|balance)\w*/i;

/**
 * Whether the finding's population is small enough that testing all of it is the honest answer.
 *
 * "Select a sample" from a deliberately identified population of seventeen year-end journal entries
 * is the defect: the population was named, it is small, and it is high risk, so 100% testing is
 * both cheaper and better. Where the text names no population, `applicable` is null - not false -
 * because nobody has established anything either way.
 */
export function deriveSampling(text) {
  const value = typeof text === "string" ? text : "";
  const match = POPULATION_SIZE.exec(value);
  const population = match ? Number(match[1]) : null;

  if (population === null) {
    return {
      populationSize: null,
      applicable: null,
      basis: null,
      note: WHOLE_POPULATION_CUE.test(value)
        ? "The text refers to the whole population without stating its size; establish the size before deciding whether to sample."
        : null,
    };
  }

  // A threshold, not a rule: below it, testing everything is normally quicker than defending a
  // sample. The number is stated rather than hidden so a reviewer can disagree with it.
  const SMALL_POPULATION = 25;
  return {
    populationSize: population,
    applicable: population > SMALL_POPULATION,
    basis:
      population > SMALL_POPULATION
        ? "Sampling may be appropriate; record the method and the basis for the sample size before selecting items."
        : `The population is ${population} items. Testing all of them is normally the shorter route and needs no sampling justification.`,
    note: null,
  };
}

// ── AA-21: how far the evidence actually gets you ──────────────────────────

export const SUFFICIENCY = Object.freeze({
  SUFFICIENT: "sufficient",
  PARTIALLY_SUFFICIENT: "partially sufficient",
  INSUFFICIENT: "insufficient",
});

/**
 * Whether the evidence a finding rests on is enough to conclude on it, and what the least
 * additional evidence would be.
 *
 * The honest answer is usually "partially": a quote from the client's own document establishes that
 * something was written down, not that it is true. Only evidence obtained independently of the
 * client reaches `sufficient`, and even then only when nothing else is missing.
 */
export function deriveSufficiency(evidenceRank, missingInformation) {
  // Only EVIDENCE gaps bear on whether the evidence is sufficient. An unstated population size is a
  // sampling-planning input, not a defect in the evidence already held, and counting it here made
  // "sufficient" almost unreachable - a bank confirmation for a single balance has no population to
  // size. The other gaps still travel in missingInformation, where they belong.
  const EVIDENCE_RELEVANT = /\b(?:evidence|passage|document to inspect|rests on|reliability)\b/i;
  const missing = (Array.isArray(missingInformation) ? missingInformation : []).filter((entry) =>
    EVIDENCE_RELEVANT.test(String(entry)),
  );

  if (!evidenceRank) {
    return {
      level: SUFFICIENCY.INSUFFICIENT,
      minimumAdditionalEvidence:
        "Identify what the finding rests on and where it came from, before anything is concluded from it.",
    };
  }
  if (evidenceRank === EVIDENCE_RANK.MANAGEMENT_REPRESENTATION) {
    return {
      level: SUFFICIENCY.INSUFFICIENT,
      minimumAdditionalEvidence:
        "A written representation is the client's own assertion. Corroborate it with something obtained independently of management before relying on it.",
    };
  }
  if (evidenceRank === EVIDENCE_RANK.EXTERNAL_DIRECT && missing.length === 0) {
    return { level: SUFFICIENCY.SUFFICIENT, minimumAdditionalEvidence: null };
  }
  return {
    level: SUFFICIENCY.PARTIALLY_SUFFICIENT,
    minimumAdditionalEvidence:
      missing.length > 0
        ? `Still required before this can be concluded on: ${missing[0]}.`
        : "Corroborate the client-generated document with a source outside the client's own records.",
  };
}

// ── AA-22: what to do first ────────────────────────────────────────────────

export const PRIORITY = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

/**
 * Triage, derived rather than asked for.
 *
 * A fraud indicator and an information gap both outrank an ordinary risk rating, for different
 * reasons: the first because of what it might be, the second because an area nobody has looked at
 * cannot be signed off however small it looks.
 */
export function derivePriority(status, riskLevel) {
  if (status === FINDING_STATUS.POTENTIAL_FRAUD_INDICATOR) return PRIORITY.CRITICAL;
  if (status === FINDING_STATUS.INFORMATION_GAP) return PRIORITY.HIGH;
  const level = String(riskLevel ?? "").toLowerCase();
  if (level === "high") return PRIORITY.HIGH;
  if (level === "low") return PRIORITY.LOW;
  return PRIORITY.MEDIUM;
}

// ── AA-19: what the risk actually does to the accounts ─────────────────────

/** What each assertion, if wrong, does to the financial statements. */
const STATEMENT_IMPACT = Object.freeze({
  [ASSERTIONS.EXISTENCE]: "assets or income may be recorded that do not exist",
  [ASSERTIONS.COMPLETENESS]: "liabilities or expenses may exist that are not recorded",
  [ASSERTIONS.VALUATION]: "a balance may be carried at the wrong amount",
  [ASSERTIONS.ACCURACY]: "an amount may be recorded incorrectly even though the item is real",
  [ASSERTIONS.RIGHTS]: "an asset may be recorded that the entity does not control",
  [ASSERTIONS.CUTOFF]: "a transaction may fall in the wrong period",
  [ASSERTIONS.CLASSIFICATION]: "an item may sit under the wrong heading",
  [ASSERTIONS.PRESENTATION]: "a disclosure the reader needs may be absent or wrong",
});

/**
 * The three parts of a risk statement, replacing "this could misstate assets".
 *
 * `statementImpact` is derived from the assertions rather than written, so it cannot disagree with
 * them - a finding that says it tests completeness and then describes an existence impact is the
 * sort of thing a reader notices and stops trusting.
 */
export function deriveRiskParts(assertions, sufficiency) {
  const list = Array.isArray(assertions) ? assertions : [];
  const impacts = list.map((a) => STATEMENT_IMPACT[a]).filter(Boolean);
  return {
    statementImpact: impacts.length > 0 ? impacts.join("; ") : null,
    auditConsequence:
      sufficiency?.level === SUFFICIENCY.SUFFICIENT
        ? "The evidence on file supports a conclusion on this point."
        : "This area cannot be concluded on until the evidence above is obtained.",
  };
}

// ── AA-20: a procedure somebody can actually carry out ─────────────────────

const PROCEDURE_PART_CUES = [
  {
    key: "document",
    pattern:
      /\b(?:bank statement|confirmation|invoice|voucher|challan|ledger|register|schedule|agreement|contract|minutes|bill of lading|purchase order|goods receipt note|count sheet|ageing report|board minute)s?\b/i,
  },
  {
    key: "source",
    pattern:
      /\b(?:from|with|against)\s+the\s+(?:bank|customer|supplier|lender|counsel|registrar|department|third party|client)\b/i,
  },
  {
    key: "comparison",
    pattern: /\b(?:compare|agree|reconcile|trace|match|vouch|cross[- ]?check)\b[^.]{0,60}/i,
  },
  {
    key: "recalculation",
    pattern: /\b(?:recompute|recalculate|re[- ]?perform|cast|foot)\b[^.]{0,60}/i,
  },
];

/**
 * Pulls the executable parts out of a procedure instruction.
 *
 * "Investigate further" and "obtain evidence" name no document, no source and no comparison, and
 * every part comes back null - which is exactly the finding AA-20 is about, and it is then listed
 * as missing rather than dressed up.
 */
export function deriveProcedureParts(instruction) {
  const value = typeof instruction === "string" ? instruction : "";
  const parts = { document: null, source: null, comparison: null, recalculation: null };
  if (!value.trim()) return parts;
  for (const cue of PROCEDURE_PART_CUES) {
    const match = cue.pattern.exec(value);
    if (match) parts[cue.key] = match[0].replace(/\s+/g, " ").trim();
  }
  return parts;
}

// ── the object itself ──────────────────────────────────────────────────────

/**
 * Builds the structured object for one flat finding.
 *
 * Every section in STRUCTURED_SECTIONS is present on the result. Sections the document does not
 * support are null, and every null is listed in missingInformation, so "we do not know" is carried
 * as data rather than left for the reader to infer from an absent key.
 */
export function toStructuredFinding(flat) {
  if (!flat || typeof flat !== "object") return null;

  const subject = [flat.title, flat.detail, flat.evidence, flat.why, flat.nextAction]
    .filter((part) => typeof part === "string")
    .join(" ");

  const standards = splitStandards(flat.standard);
  const assertions = deriveAssertions(subject);
  const evidenceRank = deriveEvidenceRank(flat.evidence ? `${flat.evidence} ${subject}` : subject);
  const sampling = deriveSampling(subject);

  const status = isStatusPermitted(flat.status) ? flat.status : classifyFindingStatus(flat);

  const structured = {
    schemaVersion: FINDING_SCHEMA_VERSION,

    // FACT: what the document says, quoted. Never the product's paraphrase of it.
    fact: typeof flat.evidence === "string" && flat.evidence.trim() ? flat.evidence.trim() : null,

    // RISK: the level plus, where the finding supplies it, why it matters.
    risk: {
      level: typeof flat.risk === "string" && flat.risk.trim() ? flat.risk.trim() : null,
      mechanism: typeof flat.why === "string" && flat.why.trim() ? flat.why.trim() : null,
      status,
    },

    assertions,
    standards,

    procedure: {
      instruction:
        typeof flat.detail === "string" && flat.detail.trim() ? flat.detail.trim() : null,
      // AA-20. The executable parts, pulled out rather than left inside a sentence. "Investigate
      // further" yields nulls in all four, which is the honest description of it.
      ...deriveProcedureParts(flat.detail),
      conclusionCriterion:
        typeof flat.nextAction === "string" && flat.nextAction.trim()
          ? flat.nextAction.trim()
          : null,
    },

    evidence: {
      quote: typeof flat.evidence === "string" && flat.evidence.trim() ? flat.evidence.trim() : null,
      rank: evidenceRank,
      restsOnManagementRepresentationAlone:
        evidenceRank === EVIDENCE_RANK.MANAGEMENT_REPRESENTATION,
    },

    sampling,

    // The remaining sections are placeholders the later defects fill in. They are PRESENT and null
    // rather than absent, because a consumer must be able to tell "not applicable" from "this
    // build does not know about that section yet".
    accountingImplication: standards.accounting
      ? `Recognition or measurement is governed by ${standards.accounting}; confirm the treatment against it.`
      : null,
    fraudIndicator:
      status === FINDING_STATUS.POTENTIAL_FRAUD_INDICATOR
        ? { present: true, basis: flat.title ?? null }
        : { present: false, basis: null },
    escalation: null,
    workingPaperStatus:
      status === FINDING_STATUS.INFORMATION_GAP ? "EVIDENCE PENDING" : "AI DRAFT",
    missingInformation: [],
  };

  // AA-21. Every null is recorded rather than left to be noticed.
  const missing = [];
  if (!structured.procedure.document && !structured.procedure.comparison) {
    missing.push("the specific document to inspect and what to compare it against");
  }
  if (!structured.fact) missing.push("the passage in the document this finding rests on");
  if (!structured.risk.mechanism) missing.push("why this matters, in terms of the financial statements");
  if (structured.assertions.length === 0) missing.push("which assertions this procedure is directed at");
  if (!structured.standards.audit && !structured.standards.accounting && !structured.standards.legal)
    missing.push("the standard or regulation this procedure is performed under");
  if (!structured.procedure.conclusionCriterion) missing.push("what to conclude once the procedure is done");
  if (structured.evidence.rank === null) missing.push("the kind and reliability of the evidence relied on");
  if (structured.sampling.applicable === null) missing.push("the size of the population being tested");
  structured.missingInformation = missing;

  // AA-21 / AA-19 / AA-22, derived AFTER missingInformation, because each depends on it. Order
  // matters here and getting it wrong would silently produce a sufficiency rating that ignored
  // everything the finding was missing.
  structured.evidence.sufficiency = deriveSufficiency(evidenceRank, missing);
  const riskParts = deriveRiskParts(assertions, structured.evidence.sufficiency);
  structured.risk.statementImpact = riskParts.statementImpact;
  structured.risk.auditConsequence = riskParts.auditConsequence;
  structured.priority = derivePriority(status, structured.risk.level);

  // AA-13. Where the finding concerns a post-reporting-date event, the three-way classification
  // that decides whether the FIGURES change or only a note does. Null when the finding is not
  // about a subsequent event at all, rather than a fourth pseudo-category.
  structured.subsequentEvent = classifySubsequentEvent(subject);

  // AA-17. Why this item survives a purely quantitative filter. An empty list is the honest answer
  // for an ordinary difference; if everything were qualitatively material, nothing would be.
  structured.qualitativeMateriality = findQualitativeMateriality(subject);

  // AA-05. The question that must be answered BEFORE any treatment follows, plus the comparability
  // factors without which the tempting conclusion is unsupported. Empty when the document raises no
  // such trap - producing one for every mention of depreciation would bury the cases that matter.
  structured.precedentQuestions = findPrecedentQuestions(subject);

  // AA-15. The full ladder, in order, whenever the text records a refusal. Returning the whole
  // ladder is what stops a refusal reading as an automatic qualification.
  structured.escalation = buildEscalationPath(subject);

  // AA-23. Which legs of the fraud triangle the text actually supports, and - the useful half -
  // which it does not. Never a score: "two of three" would be read as a probability.
  structured.fraudTriangle = assessFraudTriangle(subject);

  // AA-24. The eight questions an accounting estimate has to answer, in full. The one most often
  // skipped is historical accuracy, which is the one that catches a method wrong for years.
  structured.estimateFramework = buildEstimateFramework(subject);

  // AA-25. What to do when the confirmation does not come back, ending where it has to end: an
  // unanswered confirmation that leaves no trace is indistinguishable from one never sent.
  structured.alternativeProcedures = buildAlternativeProcedures(subject);

  return structured;
}

/**
 * Rendering, as a SEPARATE step.
 *
 * This is the half of AA-09 that proves the shape is data: the reader-facing fields can be produced
 * FROM the object, so nothing downstream has to parse a sentence to recover a part. Round-tripping
 * a finding through toStructuredFinding and back must not change a word the reader sees, which the
 * contract pins.
 */
export function renderStructuredFinding(structured, flat = {}) {
  if (!structured || typeof structured !== "object") return null;
  return {
    ...flat,
    title: flat.title ?? null,
    detail: structured.procedure.instruction ?? flat.detail ?? "",
    risk: structured.risk.level ?? flat.risk ?? "medium",
    standard:
      [structured.standards.audit, structured.standards.accounting, structured.standards.legal]
        .filter(Boolean)
        .join(", ") || (flat.standard ?? ""),
    evidence: structured.evidence.quote ?? flat.evidence ?? "",
    why: structured.risk.mechanism ?? flat.why ?? "",
    nextAction: structured.procedure.conclusionCriterion ?? flat.nextAction ?? "",
    status: structured.risk.status,
  };
}

/**
 * The mandatory-field gate. Returns the list of violations, empty when the object is well formed.
 *
 * A gate that throws would make one malformed finding lose the whole response; returning violations
 * lets a caller decide, and lets a test name exactly what is wrong.
 */
export function validateStructuredFinding(structured) {
  const violations = [];
  if (!structured || typeof structured !== "object") return ["the finding is not an object"];

  for (const section of STRUCTURED_SECTIONS) {
    if (!(section in structured)) violations.push(`missing section: ${section}`);
  }
  if (structured.schemaVersion !== FINDING_SCHEMA_VERSION) {
    violations.push(`schemaVersion is ${structured.schemaVersion}, expected ${FINDING_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(structured.assertions)) violations.push("assertions is not an array");
  if (!Array.isArray(structured.missingInformation)) {
    violations.push("missingInformation is not an array");
  }
  if (!Object.values(PRIORITY).includes(structured.priority)) {
    violations.push(`priority ${structured.priority} is not one of the four triage levels`);
  }
  if (!structured.evidence || typeof structured.evidence !== "object") {
    violations.push("evidence is not an object");
  } else if (!Object.values(SUFFICIENCY).includes(structured.evidence.sufficiency?.level)) {
    violations.push(`evidence.sufficiency.level ${structured.evidence.sufficiency?.level} is not a sufficiency rating`);
  }
  if (!structured.risk || typeof structured.risk !== "object") {
    violations.push("risk is not an object");
  } else if (!isStatusPermitted(structured.risk.status)) {
    violations.push(`risk.status ${structured.risk.status} is not a permitted status`);
  }
  if (!structured.standards || typeof structured.standards !== "object") {
    violations.push("standards is not an object");
  } else {
    for (const kind of ["audit", "accounting", "legal"]) {
      if (!(kind in structured.standards)) violations.push(`standards.${kind} is missing`);
      const value = structured.standards[kind];
      if (value != null && findUnknownStandardReferences(value).length > 0) {
        violations.push(`standards.${kind} cites something unrecognised: ${value}`);
      }
    }
  }
  return violations;
}

/** Attaches the structured object to a flat finding, leaving every existing field untouched. */
export function withStructure(flat) {
  const structured = toStructuredFinding(flat);
  return structured ? { ...flat, structured } : flat;
}
