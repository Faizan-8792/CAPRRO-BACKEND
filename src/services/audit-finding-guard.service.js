// Deterministic safety guards applied to every audit finding before it is rendered.
//
// Covers AA-04 (risk indicator vs confirmed misstatement) and AA-26 (fabricated standard
// references) from .kiro/audit-assistance-defects.md. Both are safety properties rather than
// quality ones: the product is allowed to be less insightful than an auditor, and is not allowed
// to tell one that a client committed fraud, or to cite a standard that does not exist.
//
// WHY A GUARD RATHER THAN A BETTER PROMPT
// A prompt is a request. This runs after the model has answered, on the text that is about to
// reach a chartered accountant, so it holds whatever the model actually produced rather than what
// it was asked to produce. It is also the only form of this rule that a test can pin.
//
// WHAT IT DOES NOT DO
// It does not silently rewrite a conclusion into something milder and leave the reader believing
// the model said it. Where a field over-concludes, the finding is downgraded and the fact of the
// downgrade is recorded on the finding, so the behaviour is visible rather than cosmetic.

/**
 * Statuses a finding may carry. AA-04: these are not interchangeable, and collapsing them is the
 * defect. Suspicious is not wrong. A shared employee bank account, an early supplier payment taken
 * at a discount, a related-party transaction and a late journal entry are all *indicators* - each
 * has an innocent explanation that is more common than the guilty one - and a product that reports
 * them as findings of fact puts an assertion in a working paper that the evidence cannot carry.
 *
 * The six names are the ledger's. INFORMATION_GAP is a seventh, added because AA-01's coverage
 * declaration is genuinely none of the others: it is a statement about the review, not the client.
 */
export const FINDING_STATUS = Object.freeze({
  INFORMATION_GAP: "INFORMATION_GAP",
  CONFIRMED_FACT: "CONFIRMED_FACT",
  RISK_INDICATOR: "RISK_INDICATOR",
  CONTROL_DEFICIENCY: "CONTROL_DEFICIENCY",
  POTENTIAL_MISSTATEMENT: "POTENTIAL_MISSTATEMENT",
  POTENTIAL_FRAUD_INDICATOR: "POTENTIAL_FRAUD_INDICATOR",
  CONFIRMED_MISSTATEMENT: "CONFIRMED_MISSTATEMENT",
});

/**
 * Statuses this product may never assign on its own.
 *
 * CONFIRMED_MISSTATEMENT is a conclusion only a person can reach, after evidence. Nothing in this
 * pipeline - model or deterministic - is entitled to it, so it is unreachable by construction
 * rather than merely discouraged in a prompt. An auditor can set it in their own working paper;
 * the product cannot set it for them.
 */
export const STATUSES_THE_PRODUCT_MAY_NOT_ASSIGN = Object.freeze([
  FINDING_STATUS.CONFIRMED_MISSTATEMENT,
]);

/** Fraud-adjacent subject matter. An indicator, never a conclusion - see AA-23. */
const FRAUD_INDICATOR_CUES = [
  /\bfraud|\bmisappropriat|\bdiversion of funds\b|\bfictitious\b/i,
  /\bmanagement\s+overrides?\b|\bcircumvent/i,
  /\bshared\s+(?:bank\s+)?account\b|\bemployee[^.]{0,30}\bbank\s+account\b/i,
  /\bround[- ]?trip|\bcircular\s+(?:transaction|trading)\b/i,
  /\bbackdated?\b|\bpost[- ]?dated\b/i,
];

/** Subject matter that is about a control rather than a balance. */
const CONTROL_CUES = [
  /\bsegregation\s+of\s+duties\b/i,
  /\bcontrols?\b[^.]{0,40}\b(?:not|weak|absent|missing|ineffective|deficien)/i,
  /\b(?:approval|authorisation|authorization)\b[^.]{0,40}\b(?:not|without|missing|absent)\b/i,
  /\bno\s+(?:maker[- ]checker|dual\s+control|independent\s+review)\b/i,
  /\bnot\s+(?:independently\s+)?reviewed\b/i,
];

/** Subject matter that is about what the reviewer could not see. */
const INFORMATION_GAP_CUES = [
  /\bwere\s+not\s+reviewed\b/i,
  /\bnot\s+yet\s+reviewed\b/i,
  /\b(?:could\s+not|unable\s+to)\s+(?:be\s+)?(?:produce|produced|obtain|obtained|locate|verify)/i,
  /\bnot\s+(?:made\s+)?available\b/i,
  /\bmissing\s+(?:information|evidence|documentation)\b/i,
];

/**
 * Assigns the weakest status the finding's own text can support.
 *
 * The direction of the default matters. Defaulting to RISK_INDICATOR means a finding this cannot
 * classify understates its claim rather than overstating it, and understating is recoverable - an
 * auditor reading "risk indicator" can upgrade it once they have the evidence, whereas nobody
 * re-reads a working paper to downgrade a conclusion they already believed.
 */
export function classifyFindingStatus(finding) {
  if (!finding || typeof finding !== "object") return FINDING_STATUS.RISK_INDICATOR;

  const text = RENDERED_FIELDS.map((field) => finding[field] ?? "")
    .join(" ")
    .trim();

  if (INFORMATION_GAP_CUES.some((cue) => cue.test(text))) {
    return FINDING_STATUS.INFORMATION_GAP;
  }
  if (FRAUD_INDICATOR_CUES.some((cue) => cue.test(text))) {
    // An indicator. The name carries the qualification so the status cannot be read as a verdict.
    return FINDING_STATUS.POTENTIAL_FRAUD_INDICATOR;
  }
  if (CONTROL_CUES.some((cue) => cue.test(text))) {
    return FINDING_STATUS.CONTROL_DEFICIENCY;
  }
  // A deterministic arithmetic difference IS a fact about the document - it is checkable by anyone
  // with a calculator and does not depend on judgement. It is still not a misstatement, which is a
  // conclusion about the accounts rather than about the arithmetic.
  if (finding.deterministic === true) return FINDING_STATUS.CONFIRMED_FACT;

  return FINDING_STATUS.RISK_INDICATOR;
}

/**
 * Whether a status is one this product is allowed to have put there.
 *
 * Exported so a caller - or a test - can assert the invariant rather than trusting it.
 */
export function isStatusPermitted(status) {
  return (
    Object.values(FINDING_STATUS).includes(status) &&
    !STATUSES_THE_PRODUCT_MAY_NOT_ASSIGN.includes(status)
  );
}

/**
 * Every field of a finding that a person actually reads. AA-02's mutation run found an
 * over-conclusion hiding in `title` because only `detail` and `nextAction` were checked, so the
 * list is explicit and shared rather than written out at each call site.
 */
export const RENDERED_FIELDS = Object.freeze([
  "title",
  "detail",
  "why",
  "nextAction",
  "procedure",
  "escalation",
  "summary",
  "conclusion",
]);

/**
 * Assertions that a finding has crossed from indicating a risk to declaring a fact about the
 * client. Each is phrased to catch the declaration, not the discussion: "may be misstated" and
 * "test whether revenue is overstated" are legitimate and must survive.
 */
const OVER_CONCLUSION_PATTERNS = [
  {
    id: "confirmed-misstatement",
    pattern:
      /\b(?:is|are|has been|have been|was|were)\s+(?:clearly\s+|definitely\s+|certainly\s+)?(?:misstated|overstated|understated|misappropriated)\b/i,
    milder: "may be misstated",
  },
  {
    id: "confirmed-fraud",
    pattern:
      /\b(?:is|are|was|were)\s+(?:a\s+)?fraud(?:ulent)?\b|\bconfirms?\s+(?:the\s+)?fraud\b|\bfraud has (?:occurred|been committed)\b/i,
    milder: "carries a fraud risk indicator",
  },
  {
    id: "declared-incorrect",
    pattern: /\b(?:the\s+)?(?:treatment|accounting|provision|entry|balance)\s+(?:is|was)\s+(?:incorrect|wrong|improper)\b/i,
    milder: "the treatment requires evidence before it can be accepted",
  },
  {
    id: "asserted-conclusion",
    pattern: /\bwe\s+conclude\s+that\b|\bit is concluded that\b|\bthis (?:proves|establishes)\b/i,
    milder: "this indicates, subject to evidence,",
  },
  {
    id: "management-guilt",
    pattern: /\bmanagement\s+(?:has\s+)?(?:deliberately|intentionally|knowingly)\b/i,
    milder: "the circumstances require explanation from management",
  },
];

/**
 * A phrase near the assertion that shows it is conditional after all, so a legitimate sentence is
 * not downgraded. "If the amount is misstated, ..." is analysis, not a verdict.
 */
const CONDITIONAL_GUARDS =
  /\b(?:may|might|could|whether|if|appears?|possibl|potential|indicat|suggest|assess|test|consider|evaluate|verify|subject to|cannot be (?:confirmed|established))/i;

/** Whether an over-conclusion in this sentence is defused by conditional language around it. */
function isConditional(sentence) {
  return CONDITIONAL_GUARDS.test(sentence);
}

/**
 * Finds over-conclusions in one string, sentence by sentence so a conditional clause elsewhere in
 * a long paragraph cannot excuse a flat assertion.
 */
export function findOverConclusions(value) {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) return [];

  const hits = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const rule of OVER_CONCLUSION_PATTERNS) {
      if (!rule.pattern.test(sentence)) continue;
      if (isConditional(sentence)) continue;
      hits.push({ id: rule.id, sentence: sentence.trim().slice(0, 160), milder: rule.milder });
    }
  }
  return hits;
}

// ── AA-26: fabricated standards ────────────────────────────────────────────

/**
 * The Indian standards a finding may cite. Deliberately a list rather than a pattern: "SA 999"
 * matches any sensible pattern for a standard reference and does not exist, and a document that
 * says "According to SA 999" must not persuade the product to repeat it.
 *
 * Ranges rather than every number, because the families are contiguous and a new standard within a
 * family is a real reference this must not reject.
 */
const KNOWN_STANDARD_FAMILIES = [
  { prefix: "SA", min: 200, max: 810 }, // Standards on Auditing
  { prefix: "SQC", min: 1, max: 1 },
  { prefix: "SRE", min: 2400, max: 2410 },
  { prefix: "SAE", min: 3000, max: 3420 },
  { prefix: "SRS", min: 4400, max: 4410 },
  { prefix: "AS", min: 1, max: 32 }, // Accounting Standards
  { prefix: "IND AS", min: 1, max: 141 },
  { prefix: "IFRS", min: 1, max: 18 },
  { prefix: "IAS", min: 1, max: 41 },
];

/**
 * Any prefix-and-number citation, not only the recognised ones.
 *
 * Two deliberate choices here, both of which an earlier version got wrong:
 *
 * CASE MATTERS. This was `/gi`, and case-insensitively "such as 88 vouchers" matches AS 88, which
 * is outside the AS range and was therefore reported as a fabricated standard. A citation is
 * written in capitals; ordinary prose is not. Matching case-sensitively is what separates the two.
 *
 * THE PREFIX IS CAPTURED BROADLY AND JUDGED AFTERWARDS. Listing only the nine known prefixes here
 * made the "unrecognised prefix" branch below unreachable - the regex could only ever produce a
 * prefix that was in the list - so the rule that this judges only families it knows was an
 * accident of the pattern rather than a decision the code makes. It also meant `\bSA` never matched
 * inside "ISA", so ISA 500 was ignored for the wrong reason. Capturing any capitalised prefix makes
 * the family lookup the real decision, and a test of it can actually fail.
 */
const STANDARD_REFERENCE_PATTERN = /\b(Ind\s+AS|[A-Z]{2,6}(?:\s+AS)?)[\s-]?(\d{1,4})\b/g;

/**
 * Standard references in a string that do not correspond to a real standard.
 *
 * Section references to statutes are deliberately out of scope: "section 188" is a Companies Act
 * reference whose validity this list cannot judge, and rejecting it would be worse than silence.
 */
export function findUnknownStandardReferences(value) {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) return [];

  const unknown = [];
  STANDARD_REFERENCE_PATTERN.lastIndex = 0;
  let match;
  while ((match = STANDARD_REFERENCE_PATTERN.exec(text))) {
    const prefix = match[1].replace(/\s+/g, " ").toUpperCase();
    const number = Number(match[2]);
    const family = KNOWN_STANDARD_FAMILIES.find((f) => f.prefix === prefix);
    if (!family) continue; // an unrecognised prefix is not a claim this can judge
    if (number >= family.min && number <= family.max) continue;
    unknown.push({ reference: `${prefix} ${number}`, raw: match[0] });
  }
  return unknown;
}

// ── the guard applied to a finding ─────────────────────────────────────────

/**
 * Runs both guards over one finding and returns a safe version of it.
 *
 * A finding whose text declares a fact about the client is downgraded to an indicator and the
 * downgrade is recorded in `guard.downgraded`, so the change is auditable rather than invisible.
 * A finding citing a standard this cannot recognise has that citation replaced with an explicit
 * statement that the guidance needs verifying - which is the honest answer and safer than echoing
 * a reference the reader may take on trust.
 */
export function guardFinding(finding) {
  if (!finding || typeof finding !== "object") return finding;

  const notes = [];
  const guarded = { ...finding };

  for (const field of RENDERED_FIELDS) {
    const hits = findOverConclusions(guarded[field]);
    if (hits.length === 0) continue;

    let text = String(guarded[field]);
    for (const hit of hits) {
      notes.push({ field, rule: hit.id, sentence: hit.sentence });
      // The assertion is neutralised in place rather than the sentence being deleted: a reader
      // needs to know what was observed, only not to be told it is settled.
      const rule = OVER_CONCLUSION_PATTERNS.find((r) => r.id === hit.id);
      if (rule) text = text.replace(rule.pattern, rule.milder);
    }
    guarded[field] = text;
  }

  // AA-26. An unrecognised standard reference is replaced, never echoed.
  const standardFields = ["standard", "auditStandard", "accountingGuidance"];
  for (const field of standardFields) {
    if (!guarded[field]) continue;
    const unknown = findUnknownStandardReferences(guarded[field]);
    if (unknown.length === 0) continue;
    notes.push({
      field,
      rule: "unknown-standard-reference",
      sentence: unknown.map((u) => u.reference).join(", "),
    });
    guarded[field] = "Requires verification against the applicable reporting framework";
  }

  // AA-04. The status is MANDATORY, not optional, so every finding leaves here carrying an
  // explicit claim about how strong a claim it is. A missing status is the defect: it lets a
  // reader supply their own reading, and readers supply the strong one.
  //
  // An incoming status is honoured only if the product is entitled to it. A CONFIRMED_MISSTATEMENT
  // arriving from anywhere - a model, a caller, a future code path - is replaced rather than
  // trusted, which is what makes the prohibition structural instead of advisory.
  if (!isStatusPermitted(guarded.status)) {
    guarded.status = classifyFindingStatus(guarded);
  }

  if (notes.length > 0) guarded.guard = { downgraded: notes };

  return guarded;
}

/** Applies the guard across a list, preserving order and dropping nothing. */
export function guardFindings(findings) {
  return Array.isArray(findings) ? findings.map((item) => guardFinding(item)) : [];
}
