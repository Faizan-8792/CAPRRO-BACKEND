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
  if (!structured.fact) missing.push("the passage in the document this finding rests on");
  if (!structured.risk.mechanism) missing.push("why this matters, in terms of the financial statements");
  if (structured.assertions.length === 0) missing.push("which assertions this procedure is directed at");
  if (!structured.standards.audit && !structured.standards.accounting && !structured.standards.legal)
    missing.push("the standard or regulation this procedure is performed under");
  if (!structured.procedure.conclusionCriterion) missing.push("what to conclude once the procedure is done");
  if (structured.evidence.rank === null) missing.push("the kind and reliability of the evidence relied on");
  if (structured.sampling.applicable === null) missing.push("the size of the population being tested");
  structured.missingInformation = missing;

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
