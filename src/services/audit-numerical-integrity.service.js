// Deterministic numerical-integrity checks on audit text, run BEFORE any model call.
//
// AA-02 in .kiro/audit-assistance-defects.md. The defect that produced this file, from the owner's
// Test 5: the input itemised corporate-card transactions of
//
//     restaurant  2.10 lakh
//     hotel       1.40 lakh
//     electronics 0.72 lakh
//     retail      0.38 lakh
//                 -----------
//                 4.60 lakh
//
// and then narrated "no reimbursement evidence for Rs 2.86 lakh". The engine repeated 2.86 lakh and
// tested against it, never noticing that the itemised population it had been given adds to a
// different number. Testing a reconciled population is the first thing an auditor does; accepting
// an unreconciled one silently is the kind of error that survives review because nothing on screen
// looks wrong.
//
// WHY THIS IS CODE AND NOT A PROMPT
// Arithmetic is the one part of this pipeline that needs no judgement, so it should not be asked of
// a language model at all. Deterministic code cannot hallucinate a total, costs nothing, runs
// before the model call, and can be pinned exactly by a test. The .kiro ledger says to do the
// deterministic stages first for precisely this reason.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It never says a figure is wrong. It says two figures in the same document disagree and the
// population needs reconciling before testing. A false claim of a misstatement would be a worse
// defect than the one being fixed, so the finding is a RISK_INDICATOR - AA-04's category - and the
// wording asks for reconciliation rather than asserting an error.

/** Indian numbering words this recogniser understands, as multipliers of one rupee. */
const SCALE_WORDS = Object.freeze({
  lakh: 100000,
  lakhs: 100000,
  lac: 100000,
  lacs: 100000,
  crore: 10000000,
  crores: 10000000,
  cr: 10000000,
  thousand: 1000,
});

/**
 * Words that mark an amount as an AGGREGATE claim about other amounts rather than another item in
 * the list. Only an amount carrying one of these is ever compared against a sum, which is what
 * keeps this from firing on any two numbers that happen to differ.
 */
// Patterns, not exact strings. The first version listed literal phrases including
// "no reimbursement evidence for", and the very document it was written for said "could not
// produce reimbursement evidence for" - so the detector found the arithmetic correctly and then
// declined to compare it. Matching a fixed phrase against prose written by a person is a losing
// game; the shape of the claim is what is stable.
const AGGREGATE_CUES = [
  // Plain aggregation.
  /\btotal(?:s|led|ling|ing)?\b[^.]{0,24}$/,
  /\baggregat(?:e|es|ing)\b[^.]{0,24}$/,
  /\bamount(?:s|ing)? to\b[^.]{0,12}$/,
  /\bsum of\b[^.]{0,12}$/,
  /\b(?:in all|altogether|combined|put together)\b[^.]{0,20}$/,

  // Evidence or support lacking for some portion of the list. This is the family that matters most
  // in audit text, and the one the literal version missed.
  /\b(?:evidence|support|documentation|substantiation|backup|vouchers?)\s+(?:for|of)\b[^.]{0,20}$/,
  /\bunsupported\b[^.]{0,40}$/,
  /\bunverified\b[^.]{0,40}$/,
  /\b(?:could not|couldn't|unable to|failed to|did not)\b[^.]{0,60}$/,
  /\bwithout\b[^.]{0,40}$/,
  /\bto the extent of\b[^.]{0,12}$/,
  /\bout of (?:which|the above)\b[^.]{0,20}$/,
  /\bof (?:the above|these|this)\b[^.]{0,12}$/,
];

/** Rupees are held as integer paise everywhere in this codebase; money never touches a float. */
const PAISE_PER_RUPEE = 100;

/**
 * A tolerance for rounding in the SOURCE DOCUMENT, not in our arithmetic. A report that states
 * amounts to two decimal places in lakh can legitimately have a stated total one paisa away from
 * the sum of its parts. One rupee per item is generous enough to absorb that and far too small to
 * absorb a real discrepancy - Test 5's gap is 1.74 lakh.
 */
const ROUNDING_TOLERANCE_PAISE_PER_ITEM = 100;

/**
 * The smallest run of itemised amounts worth reconciling. Two numbers and a total is a coincidence
 * waiting to happen; three or more is a list.
 */
const MIN_ITEMS_IN_LIST = 3;

/**
 * How far after the last item an aggregate claim may sit and still be read as summarising it.
 * Wide enough for "... and retail 0.38 lakh. The company could not produce reimbursement evidence
 * for 2.86 lakh", narrow enough that an unrelated figure two paragraphs later is not roped in.
 */
const MAX_AGGREGATE_DISTANCE_CHARS = 400;

/**
 * Parses every rupee amount in the text into integer paise, keeping each one's position so the
 * grouping below can tell a list from a total.
 *
 * Handles the forms this product actually receives: `Rs 2.10 lakh`, `₹1,40,000`, `2.4 Cr`,
 * `₹48,00,000`, `12600000`. A bare number with no currency marker and no scale word is ignored
 * on purpose - a section number, a year or a page count must never be read as money.
 */
export function extractRupeeAmounts(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  const found = [];
  const pattern = new RegExp(
    [
      // An optional currency marker, then a number, then an optional scale word.
      "(?:(?<currency>₹|Rs\\.?|INR)\\s*)?",
      "(?<number>\\d[\\d,]*(?:\\.\\d+)?)",
      "\\s*(?<scale>lakhs?|lacs?|crores?|cr\\b|thousand)?",
    ].join(""),
    "giu",
  );

  for (const match of text.matchAll(pattern)) {
    const { currency, number, scale } = match.groups ?? {};
    const scaleKey = scale ? scale.toLowerCase().replace(/\./g, "").trim() : "";
    const multiplier = scaleKey ? SCALE_WORDS[scaleKey] : undefined;

    // Money must be marked as money: either a currency symbol or an Indian scale word. Otherwise a
    // bare "18" from "18 sections" would enter the arithmetic.
    if (!currency && multiplier === undefined) continue;

    const numeric = Number(String(number).replace(/,/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) continue;

    const rupees = numeric * (multiplier ?? 1);
    // Rounded to whole paise; the source cannot express finer than that.
    const paise = Math.round(rupees * PAISE_PER_RUPEE);
    if (!Number.isSafeInteger(paise)) continue;

    found.push({
      paise,
      index: match.index ?? 0,
      raw: match[0].trim(),
    });
  }

  return found;
}

/**
 * Whether an aggregate cue appears close enough before an amount to be describing it, and if so
 * the words that said so, for quoting back to the reader.
 *
 * Each pattern is anchored to the END of the preceding window, so the cue has to sit immediately
 * before the figure. A "total" earlier in the paragraph is describing something else.
 */
function aggregateCueBefore(text, amountIndex) {
  const windowStart = Math.max(0, amountIndex - 90);
  const before = text.slice(windowStart, amountIndex).toLowerCase();

  for (const pattern of AGGREGATE_CUES) {
    const match = before.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

/**
 * A sentence ending inside the span between two amounts.
 *
 * Deliberately requires the terminator to be FOLLOWED by whitespace, because the amounts
 * themselves have already been consumed by the time this looks at the gap - so the "." in
 * "Rs 2.10 lakh" is never inside this span. What is inside it is text like ", " (a list) or
 * ". Trade payables include " (a different subject).
 */
const SENTENCE_END_BETWEEN = /[.;!?]\s|\n\s*\n/;

/**
 * A line that opens a new numbered or lettered item: "12.", "(12)", "A.", "iv)".
 *
 * Bullets are deliberately NOT here. A number or letter marks a distinct enumerated section of a
 * memorandum - section 12 is about payables and section 13 about borrowings, and their figures
 * have nothing to do with each other. A bullet marks a member of the list it hangs under, which
 * is exactly the case this must not break.
 */
const ENUMERATED_ITEM_START = /(?:^|\n)[ \t]*(?:\(?\d{1,3}[.)]|\(?[A-Za-z][.)])[ \t]+/;

/**
 * Whether a population boundary sits between two positions - that is, whether two amounts belong
 * to different populations and must never be added together.
 *
 * WHY THIS EXISTS
 * Runs used to be grouped by PROXIMITY alone: any three amounts within 400 characters, none
 * carrying an aggregate cue, became "an itemised list". On a 41-section audit memorandum that
 * swept 24 unrelated figures - revenue, receivables, capital work in progress, inventory,
 * payables, borrowings, gratuity, related-party sales, deferred tax, contingent liabilities, CSR -
 * into a single "population" of Rs 1,034.46 crore and reconciled it against the Rs 2.86 lakh of
 * unsupported reimbursement claims in section 33, reporting a Rs 1,034.43 crore difference that
 * does not exist.
 *
 * That is worse than missing a finding. A fabricated reconciliation sends a reviewer looking for a
 * difference that was never there, and it destroyed the one real reconciliation in the document:
 * the runaway run swallowed section 33's four itemised claims, so the genuine finding never
 * appeared at all.
 *
 * THE RULE
 * Amounts may be added together only when they are itemised members of the same explicitly
 * identified population. Two independent, individually sufficient signals of a different
 * population:
 *
 *   1. A sentence ends between them. An enumeration of members of one population is one sentence
 *      ("claims of Rs A, Rs B, Rs C and Rs D were settled"); once a full stop intervenes, the text
 *      has moved to a different subject.
 *   2. A new numbered or lettered item begins between them. Section 12 and section 13 of a
 *      memorandum are different populations by construction.
 *
 * Neither signal is a keyword, and neither depends on the wording of any particular document.
 * That is the point: a rule that recognised the words "Reimbursement claims" would be an overfit
 * to one file and would fail the next one.
 */
function populationBoundaryBetween(text, fromIndex, toIndex) {
  if (toIndex <= fromIndex) return false;
  const span = text.slice(fromIndex, toIndex);
  return SENTENCE_END_BETWEEN.test(span) || ENUMERATED_ITEM_START.test(span);
}

/**
 * Groups amounts into runs that read as one itemised list: consecutive amounts none of which
 * carries an aggregate cue, separated by short gaps, and none separated from the one before it by
 * a population boundary.
 */
function itemisedRuns(text, amounts) {
  const runs = [];
  let current = [];

  for (let i = 0; i < amounts.length; i += 1) {
    const amount = amounts[i];
    const isAggregate = aggregateCueBefore(text, amount.index) !== null;
    const previous = amounts[i - 1];
    const previousEnd = previous ? previous.index + previous.raw.length : 0;
    const gap = previous ? amount.index - previousEnd : 0;
    const crossesPopulation =
      previous !== undefined && populationBoundaryBetween(text, previousEnd, amount.index);

    // An aggregate claim, a long gap, or a different population ends the run.
    if (isAggregate || (previous && gap > MAX_AGGREGATE_DISTANCE_CHARS) || crossesPopulation) {
      if (current.length >= MIN_ITEMS_IN_LIST) runs.push(current);
      current = isAggregate ? [] : [amount];
      continue;
    }

    current.push(amount);
  }

  if (current.length >= MIN_ITEMS_IN_LIST) runs.push(current);
  return runs;
}

const formatRupees = (paise) => {
  const rupees = paise / PAISE_PER_RUPEE;
  if (rupees >= 10000000) return `Rs ${(rupees / 10000000).toFixed(2)} crore`;
  if (rupees >= 100000) return `Rs ${(rupees / 100000).toFixed(2)} lakh`;
  return `Rs ${rupees.toLocaleString("en-IN")}`;
};

/**
 * Finds places where a stated aggregate does not equal the sum of the itemised amounts it appears
 * to summarise.
 *
 * Returns one entry per genuine disagreement, each carrying both figures and the gap, so the
 * caller can quote real numbers rather than say "something does not add up".
 */
export function findNumericalInconsistencies(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const amounts = extractRupeeAmounts(text);
  if (amounts.length < MIN_ITEMS_IN_LIST + 1) return [];

  const runs = itemisedRuns(text, amounts);
  if (runs.length === 0) return [];

  const inconsistencies = [];

  for (const run of runs) {
    const lastItem = run[run.length - 1];
    const runEnd = lastItem.index + lastItem.raw.length;
    const sum = run.reduce((total, item) => total + item.paise, 0);

    // The first aggregate claim that follows this run, within reach of it AND still describing the
    // same population.
    //
    // A sentence break is allowed here, unlike inside a run: the total of a list is very often
    // stated in the sentence after it ("...were settled during the year. Evidence for Rs 2.86 lakh
    // could not be produced."). A new numbered section is not allowed, because a figure in the
    // next section of a memorandum is about a different subject - which is precisely how the
    // Rs 2.86 lakh of section 33 came to be presented as the total of twenty-four figures drawn
    // from sections 9 to 32.
    const aggregate = amounts.find((candidate) => {
      if (candidate.index < runEnd) return false;
      if (candidate.index - runEnd > MAX_AGGREGATE_DISTANCE_CHARS) return false;
      if (ENUMERATED_ITEM_START.test(text.slice(runEnd, candidate.index))) return false;
      return aggregateCueBefore(text, candidate.index) !== null;
    });

    if (!aggregate) continue;

    const tolerance = ROUNDING_TOLERANCE_PAISE_PER_ITEM * run.length;
    const gap = Math.abs(aggregate.paise - sum);
    if (gap <= tolerance) continue;

    inconsistencies.push({
      itemCount: run.length,
      itemisedTotalPaise: sum,
      statedTotalPaise: aggregate.paise,
      differencePaise: gap,
      cue: aggregateCueBefore(text, aggregate.index),
      itemisedTotalText: formatRupees(sum),
      statedTotalText: formatRupees(aggregate.paise),
      differenceText: formatRupees(gap),
      statedRaw: aggregate.raw,
    });
  }

  return inconsistencies;
}

/**
 * Turns each inconsistency into an insight in the same shape the audit controller already emits,
 * so it can be prepended alongside the mandatory procedures with no rendering change.
 *
 * These lead the list on purpose. A population that does not reconcile has to be settled before
 * any test performed on it means anything, so it belongs above the procedures that would test it.
 */
export function buildNumericalIntegrityInsights(text) {
  return findNumericalInconsistencies(text).map((item) => ({
    title: "Reconcile the population before testing it",
    detail:
      `The ${item.itemCount} itemised amounts in this text add up to ` +
      `${item.itemisedTotalText}, but the text also states ${item.statedTotalText}` +
      `${item.cue ? ` (as "${item.cue} ${item.statedRaw}")` : ""}. ` +
      `The two differ by ${item.differenceText}. ` +
      "Establish which figure describes the population you are testing, and what the difference " +
      "consists of, before performing or concluding on any test of it.",
    // A disagreement between two figures is an indicator, not proof either is wrong. AA-04.
    risk: "high",
    standard: "SA 500",
    evidence: "",
    why:
      "A test performed on an unreconciled population cannot support a conclusion, because the " +
      "population tested is not known to be the population that matters. The difference may be a " +
      "second group of items, a partial figure, or an error in the record - and which of those it " +
      "is changes both the scope of the work and what the result means.",
    nextAction:
      "Obtain the underlying listing, agree it to the stated figure, and identify every item " +
      "making up the difference. Do not treat either figure as the population until they agree " +
      "or the difference is explained.",
    // AA-04. This finding is arithmetic: anyone with a calculator reaches the same answer, so
    // it is a fact about the document rather than a judgement about the accounts. That earns
    // CONFIRMED_FACT and still, deliberately, not CONFIRMED_MISSTATEMENT - whether the accounts
    // are wrong is a conclusion only a person can reach.
    deterministic: true,
    amountMinor: item.differencePaise,
    workingPaperRef: null,
  }));
}
