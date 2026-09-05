// Things that are only visible when you look at ALL the findings at once.
//
// AA-13, AA-16 and AA-17 in .kiro/audit-assistance-defects.md. Each is invisible to a per-finding
// check by construction:
//
//   AA-16  Rs 10L + Rs 15L + Rs 3L + Rs 4.6L + Rs 2.3L = Rs 34.9L. Every one of those is small.
//          The total is not. Nothing that looks at one finding can ever see that.
//   AA-17  A Rs 4 crore related-party item under a Rs 20 crore threshold is not immaterial, because
//          materiality is not only a number. Filtering by amount alone deletes exactly the items an
//          auditor most needs to see.
//   AA-13  "Subsequent payment, so was the provision adequate" skips the question that decides the
//          answer: did the event reveal a condition that already existed at the reporting date, or
//          did it arise afterwards? The first changes the figures; the second changes only a note.

import { FINDING_STATUS } from "./audit-finding-guard.service.js";

// ── AA-13: what a post-year-end event actually tells you ───────────────────

export const SUBSEQUENT_EVENT = Object.freeze({
  ADJUSTING: "ADJUSTING",
  NON_ADJUSTING: "NON_ADJUSTING",
  UNCLEAR: "UNCLEAR",
  NOT_A_SUBSEQUENT_EVENT: null,
});

/** Text that places an event after the reporting date at all. */
const SUBSEQUENT_WINDOW =
  /\bsubsequent(?:ly)? to the (?:year|reporting|balance sheet)[\s-]?(?:end|date)\b|\bafter the (?:year|reporting|balance sheet)[\s-]?(?:end|date)\b|\bpost[\s-]?(?:year|balance sheet)[\s-]?(?:end|date)\b|\bsubsequent event\b|\bin April\b|\bin May\b/i;

/**
 * Events that reveal a condition ALREADY PRESENT at the reporting date. These change the figures.
 *
 * The distinguishing feature is not the date but what the event is evidence OF: a customer failing
 * in April was usually already failing in March, and the receivable was already doubtful then.
 */
const ADJUSTING_CUES = [
  /\b(?:insolven|bankrupt|liquidat|winding up|NCLT)\w*/i,
  // Words intervene in real prose: "the court DELIVERED ITS judgment", "the claim WAS settled BY
  // the court". Requiring adjacency missed both, and a passive settlement was then read as
  // non-adjusting because only the other half of the sentence matched.
  /\bcourt\b[^.]{0,40}\b(?:judgment|judgement|order|ruling|decree)\b/i,
  /\b(?:claim|dispute|case|litigation)\b[^.]{0,40}\b(?:settled|decided|adjudicated)\b/i,
  /\bsettled the (?:claim|dispute|case)\b/i,
  // An article intervenes in ordinary prose: "negotiated A settlement". Requiring adjacency missed
  // it, which is the same shape of miss as the court-judgment cue above.
  /\bnegotiated\s+(?:a|an|the)?\s*(?:price|settlement)\b|\bfinal(?:ised|ized)\s+(?:a|an|the)?\s*(?:price|claim|settlement)\b/i,
  /\bsale of (?:the )?inventory\b[^.]{0,40}\bbelow cost\b|\brealisable value\b|\brealizable value\b/i,
  /\bdetermin(?:ed|ation) of\b[^.]{0,40}\b(?:bonus|profit[- ]share|incentive)\b/i,
  /\bdiscovery of (?:a )?(?:fraud|error)\b|\bfraud (?:was )?discovered\b/i,
  /\breceivable\b[^.]{0,60}\b(?:defaulted|failed to pay|written off)\b/i,
];

/**
 * Events arising from conditions that did NOT exist at the reporting date. These change a note, not
 * a number.
 */
const NON_ADJUSTING_CUES = [
  /\b(?:fire|flood|earthquake|cyclone|accident)\b/i,
  /\b(?:acquisition|acquired|merger|amalgamation|takeover)\b/i,
  // Both word orders occur in real prose: "dividend declared" and "declared a dividend". A
  // dividend declared after the reporting date is a textbook non-adjusting event, and requiring
  // adjacency in one direction only missed it. Sixth time this adjacency class has bitten here,
  // and again a fixture found it rather than anyone reading the pattern.
  /\b(?:share|rights|bonus)\s+issue\b|\bbuy[- ]?back\b|\bdividend\b[^.]{0,25}\bdeclar|\bdeclar\w*\b[^.]{0,25}\bdividend\b/i,
  /\b(?:new|fresh)\s+(?:borrowing|loan|facility)\b/i,
  /\b(?:announced|commenced|launched|entered into)\b[^.]{0,60}\b(?:plan|expansion|restructuring|contract)\b/i,
  /\bchange in (?:law|regulation|tax rate)\b/i,
  /\bstrike\b|\blabour unrest\b/i,
];

/**
 * Classifies a post-reporting-date event three ways.
 *
 * UNCLEAR is a real answer and the most important one to keep. An event this cannot place is the
 * event an auditor must go and ask about; guessing between adjusting and non-adjusting would
 * produce a confident wrong number in the accounts, and the whole point of the three-way split is
 * that the third way exists.
 */
export function classifySubsequentEvent(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim() || !SUBSEQUENT_WINDOW.test(value)) {
    return { classification: SUBSEQUENT_EVENT.NOT_A_SUBSEQUENT_EVENT, basis: null, action: null };
  }

  const adjusting = ADJUSTING_CUES.some((cue) => cue.test(value));
  const nonAdjusting = NON_ADJUSTING_CUES.some((cue) => cue.test(value));

  // Both matching means the text describes two things, or one thing ambiguously. Either way it is
  // not this module's place to pick.
  if (adjusting && !nonAdjusting) {
    return {
      classification: SUBSEQUENT_EVENT.ADJUSTING,
      basis:
        "The event is evidence of a condition that already existed at the reporting date, so the figures themselves may need to change.",
      action:
        "Quantify the effect on the reported figures and propose the adjusting entry, rather than treating this as a disclosure matter.",
    };
  }
  if (nonAdjusting && !adjusting) {
    return {
      classification: SUBSEQUENT_EVENT.NON_ADJUSTING,
      basis:
        "The condition arose after the reporting date, so the figures stand and the question is whether the note is adequate.",
      action:
        "Assess whether the event is material enough to require disclosure, and check the wording of any note against what actually happened.",
    };
  }
  return {
    classification: SUBSEQUENT_EVENT.UNCLEAR,
    basis:
      "The text does not establish whether the underlying condition existed at the reporting date, and that is what decides whether the figures change or only a note does.",
    action:
      "Establish the date the underlying condition arose, and the date the financial statements were approved, before deciding whether this adjusts the figures or is disclosed.",
  };
}

// ── AA-16: small things that are large together ────────────────────────────

/** Below this, an item is clearly trivial and is not accumulated. Stated so it can be argued with. */
const CLEARLY_TRIVIAL_PAISE = 100000; // Rs 1,000

/**
 * Accumulates the amounts attached to findings and compares the total against materiality.
 *
 * The defect is arithmetic, not judgement: five items of Rs 10L, Rs 15L, Rs 3L, Rs 4.6L and Rs 2.3L
 * are each individually unremarkable and together are Rs 34.9L. An auditor who never adds them up
 * concludes on five small things instead of one large one.
 *
 * `materialityPaise` is null when nobody has set a figure, and the register is still produced -
 * the total is a fact whether or not a threshold exists to compare it with.
 */
export function buildMisstatementRegister(findings, materialityPaise = null) {
  const list = Array.isArray(findings) ? findings : [];

  const items = list
    .filter((f) => Number.isFinite(f?.amountMinor) && f.amountMinor > CLEARLY_TRIVIAL_PAISE)
    // A finding that states a fact about the document rather than a possible misstatement does not
    // belong in a misstatement total. AA-02's reconciliation difference is the obvious case: it is
    // a gap to explain, not an amount to accumulate against materiality.
    .filter((f) => f.status !== FINDING_STATUS.CONFIRMED_FACT)
    .map((f) => ({ title: f.title ?? null, amountMinor: f.amountMinor }));

  const totalMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);

  return {
    items,
    count: items.length,
    totalMinor,
    materialityPaise,
    // null, not false, when no threshold exists: "nobody set materiality" is not "the total is
    // immaterial", and collapsing them would assert something nobody checked.
    exceedsMateriality:
      materialityPaise === null ? null : totalMinor > materialityPaise,
    individuallyBelowMateriality:
      materialityPaise === null
        ? null
        : items.every((item) => item.amountMinor <= materialityPaise),
  };
}

// ── AA-17: material for reasons that are not the amount ────────────────────

/**
 * Reasons an item matters regardless of its size. Each is a reason a real engagement partner would
 * give, not a category label.
 */
const QUALITATIVE_CUES = [
  {
    id: "related-party",
    pattern: /\brelated part|\bdirector'?s?\b|\bkey managerial\b|\bpromoter\b|\bcommon director/i,
    reason:
      "it involves a related party, where the question is the relationship and the disclosure rather than the size of the amount",
  },
  {
    id: "fraud-adjacent",
    pattern: /\bfraud|\bmisappropriat|\boverride\b|\bfictitious\b|\bunauthoris|\bunauthoriz|\bbackdated?\b/i,
    reason:
      "it is fraud-adjacent, and an amount is not what makes a suspected fraud worth pursuing",
  },
  {
    id: "covenant",
    pattern: /\bcovenant\b|\bborrowing base\b|\bdebt service\b|\bratio (?:test|breach)\b/i,
    reason:
      "it bears on a covenant, where a small movement can change whether a facility remains available",
  },
  {
    id: "regulatory",
    pattern: /\bstatutory dues?\b|\bTDS\b|\bGST\b|\bprovident fund\b|\bregulator|\bpenalt(?:y|ies)\b|\bnon[- ]compliance\b/i,
    reason:
      "it is a compliance matter, where the consequence is a penalty or a reporting obligation rather than the amount itself",
  },
  {
    id: "going-concern",
    pattern: /\bgoing concern\b|\brefinanc|\bliquidit|\bnet current liabilit/i,
    reason: "it bears on going concern, which is not a question of size",
  },
  {
    id: "management-remuneration",
    pattern: /\bremuneration\b|\bmanagerial remuneration\b|\bbonus\b[^.]{0,30}\bdirector/i,
    reason:
      "it affects managerial remuneration, which is separately regulated and separately disclosed",
  },
  {
    id: "earnings-threshold",
    pattern: /\bturn(?:s|ed)? a loss into a profit\b|\bbreak[- ]?even\b|\bmeets? the (?:forecast|target|covenant)\b/i,
    reason:
      "it changes which side of a threshold the result falls on, which matters however small the amount",
  },
];

/**
 * Why an item survives a purely quantitative filter.
 *
 * Returns an empty list when nothing qualitative applies, which is the honest answer for an
 * ordinary small difference - not every immaterial item is secretly important, and pretending
 * otherwise would make the check worthless.
 */
export function findQualitativeMateriality(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return [];
  return QUALITATIVE_CUES.filter((cue) => cue.pattern.test(value)).map((cue) => ({
    id: cue.id,
    reason: cue.reason,
  }));
}

/**
 * Whether a finding may be dropped for being below a threshold.
 *
 * This is the gate AA-17 asks for: a Rs 4 crore related-party item under a Rs 20 crore threshold is
 * NOT immaterial, and a filter that only compares numbers would remove it. The answer is always
 * accompanied by the reason, so a reader can disagree with the reason rather than with a verdict.
 */
export function mayBeFilteredAsImmaterial(finding, materialityPaise) {
  if (!finding || typeof finding !== "object") return { filterable: false, reasons: [] };
  if (materialityPaise === null || materialityPaise === undefined) {
    return {
      filterable: false,
      reasons: [{ id: "no-threshold", reason: "no materiality figure has been set to filter against" }],
    };
  }

  const subject = [finding.title, finding.detail, finding.evidence, finding.why]
    .filter((part) => typeof part === "string")
    .join(" ");
  const qualitative = findQualitativeMateriality(subject);

  const amount = Number.isFinite(finding.amountMinor) ? finding.amountMinor : null;
  const belowThreshold = amount !== null && amount <= materialityPaise;

  if (qualitative.length > 0) {
    return { filterable: false, reasons: qualitative };
  }
  if (!belowThreshold) {
    return {
      filterable: false,
      reasons: [{ id: "above-threshold", reason: "the amount is at or above the materiality figure" }],
    };
  }
  return { filterable: true, reasons: [] };
}
