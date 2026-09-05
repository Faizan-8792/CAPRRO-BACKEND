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

/**
 * Text that says IN WORDS that an event falls after the reporting date.
 *
 * April and May survive only as a last-resort fallback for a document that states no reporting
 * date at all, where an Indian 31 March year-end is the overwhelming default. They are no longer
 * the main route, and must not be: hardcoding two month names meant an event in June, July or
 * August was not recognised as a subsequent event at all. On a schedule of nine events spanning
 * May to August, seven were invisible - not misclassified, never seen.
 *
 * The two months stay capped on purpose rather than extended to every month after March. For an
 * Indian financial year running 1 April to 31 March, October is INSIDE the year under audit, not
 * after it - so "any month after March" would be wrong, not merely loose. April and May are the
 * window between a March year end and the date a report is normally signed.
 *
 * AA-34: the month is now recognised however the date is WRITTEN. Requiring the preposition "in"
 * meant "On 12 April the customer returned goods" - the ordinary way a date appears in an audit
 * document - was not recognised, while "In April the customer returned goods" was. The shapes
 * below are date shapes, not one preposition: a temporal preposition, a day number, or a year.
 */
const SUBSEQUENT_WINDOW =
  /\bsubsequent(?:ly)? to the (?:year|reporting|balance sheet)[\s-]?(?:end|date)\b|\bafter the (?:year|reporting|balance sheet)[\s-]?(?:end|date)\b|\bpost[\s-]?(?:year|balance sheet)[\s-]?(?:end|date)\b|\bsubsequent event\b|\b(?:on|in|during|by|dated|until|till)\s+(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:April|May)\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:April|May)\b|\b(?:April|May)\s+\d{1,2}(?:st|nd|rd|th)?\b|\b(?:April|May)\s+\d{4}\b/i;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const MONTH_ALTERNATION = MONTH_NAMES.join("|");

/**
 * "year ended 31 March 2026", "period ending 30 June 2025", "as at 31 March 2026", and the form
 * that actually declares the boundary in a subsequent-events schedule: "The following occurred
 * after 31 March 2026".
 *
 * AA-36. The last family was missing, and its absence cost far more than a date. A document that
 * says "The following occurred after 31 March 2026" and then lists nine events was read as stating
 * no reporting date at all, so the window fell back to the April/May default and five of the nine
 * events were never recognised. The phrase that opens a subsequent-events schedule is the single
 * most explicit statement of a reporting date a document ever makes; it is not a passing mention.
 */
const REPORTING_DATE_PATTERN = new RegExp(
  `\\b(?:(?:year|period|quarter|half[\\s-]?year)\\s+end(?:ed|ing)|as\\s+at|as\\s+of|(?:occurred|arose|took\\s+place|happened|arising)\\s+(?:after|subsequent\\s+to)|(?:after|subsequent\\s+to)\\s+the\\s+(?:year|reporting|balance\\s+sheet)[\\s-]?(?:end|date)\\s+(?:of\\s+)?)\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`,
  "i",
);

/**
 * Text that declares the block that follows to be a schedule of post-reporting-date events.
 *
 * AA-37. Every item in such a block is a subsequent event BY DECLARATION, whatever its own wording
 * says. Two of Test #6's nine events - "Bank issued no formal covenant waiver" and "Former
 * distributor legal claim remains unresolved" - carry no date of any kind, so no date rule could
 * ever reach them. The document states the boundary once and lists the items under it, which is
 * precisely how an SA 560 schedule is written, and reading each item in isolation throws that
 * structure away.
 */
const SUBSEQUENT_CONTEXT_DECLARATION =
  /\bsubsequent\s+events?\b|\bevents?\s+after\s+the\s+(?:reporting|balance\s+sheet)\s+(?:period|date)\b|\bthe\s+following\s+(?:occurred|arose|took\s+place|happened)\s+(?:after|subsequent\s+to)\b/i;

/**
 * A stated boundary date, which a genuine schedule always carries and a heading about schedules
 * does not. This is what separates "The following occurred after 31 March 2026:" from an
 * instruction reading "SUBSEQUENT EVENTS - analyse each event from section 30 separately".
 */
const DECLARES_A_BOUNDARY_DATE = new RegExp(
  `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?:${MONTH_ALTERNATION})\\s+\\d{4}\\b|\\b(?:year|reporting|balance\\s+sheet)[\\s-]?(?:end|date)\\b`,
  "i",
);

/** Every explicit month-and-year reference, so an event's own date can be compared. */
const MONTH_YEAR_PATTERN = new RegExp(`\\b(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`, "gi");

/**
 * The reporting date the document states, as `{ month, year }` with month 0-11, or null.
 *
 * Deriving the window from the document rather than from a list of month names is the whole point:
 * a 30 June year-end makes a July event subsequent and a May event not, and no fixed list of month
 * names can express that.
 */
export function findReportingDate(text) {
  if (typeof text !== "string") return null;
  const match = text.match(REPORTING_DATE_PATTERN);
  if (!match) return null;
  const month = MONTH_NAMES.indexOf(match[1].toLowerCase());
  const year = Number(match[2]);
  if (month === -1 || !Number.isFinite(year)) return null;
  return { month, year };
}

/** Whether the text names a month and year strictly after the reporting date. */
function namesADateAfter(text, reportingDate) {
  if (!reportingDate) return false;
  for (const match of String(text ?? "").matchAll(MONTH_YEAR_PATTERN)) {
    const month = MONTH_NAMES.indexOf(match[1].toLowerCase());
    const year = Number(match[2]);
    if (month === -1 || !Number.isFinite(year)) continue;
    if (year > reportingDate.year) return true;
    if (year === reportingDate.year && month > reportingDate.month) return true;
  }
  return false;
}

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
  /\bcourt\b(?:[^.]|\.(?=\d)){0,40}\b(?:judgment|judgement|order|ruling|decree)\b/i,
  /\b(?:claim|dispute|case|litigation)\b(?:[^.]|\.(?=\d)){0,40}\b(?:settled|decided|adjudicated)\b/i,
  /\bsettled the (?:claim|dispute|case)\b/i,
  // An article intervenes in ordinary prose: "negotiated A settlement". Requiring adjacency missed
  // it, which is the same shape of miss as the court-judgment cue above.
  /\bnegotiated\s+(?:a|an|the)?\s*(?:price|settlement)\b|\bfinal(?:ised|ized)\s+(?:a|an|the)?\s*(?:price|claim|settlement)\b/i,
  // Both word orders. "sale of the inventory below cost" and "inventory was sold below recorded
  // cost" are the same event, and only the first was matched - the adjacency class again, which is
  // why the cue below it now names the verb in either position.
  /\bsale of (?:the )?inventory\b(?:[^.]|\.(?=\d)){0,40}\bbelow cost\b|\binventor\w*\b(?:[^.]|\.(?=\d)){0,40}\bsold\b(?:[^.]|\.(?=\d)){0,30}\bbelow\b(?:[^.]|\.(?=\d)){0,20}\bcost\b|\brealisable value\b|\brealizable value\b/i,
  /\bdetermin(?:ed|ation) of\b(?:[^.]|\.(?=\d)){0,40}\b(?:bonus|profit[- ]share|incentive)\b/i,
  /\bdiscovery of (?:a )?(?:fraud|error)\b|\bfraud (?:was )?discovered\b/i,
  /\breceivable\b(?:[^.]|\.(?=\d)){0,60}\b(?:defaulted|failed to pay|written off)\b/i,
  // Goods returned because they were defective. The defect existed when the goods were despatched,
  // so the return is evidence about the year-end position rather than a new event - the textbook
  // adjusting case, and it had no cue at all.
  /\b(?:returned|return of|sales? return)\b(?:[^.]|\.(?=\d)){0,60}\b(?:defect\w*|damaged|quality|faulty|not conforming)\b|\b(?:defect\w*|damaged|faulty)\b(?:[^.]|\.(?=\d)){0,40}\b(?:returned|return)\b/i,
  // A warranty claim received after the year end is evidence about goods sold before it.
  /\bwarranty claims?\b(?:[^.]|\.(?=\d)){0,40}\b(?:received|made|lodged|notified)\b|\b(?:received|lodged)\b(?:[^.]|\.(?=\d)){0,30}\bwarranty claims?\b/i,
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
  // "share issue" and "issued equity shares" are the same event in two word orders, and only the
  // first was matched. SEVENTH time this adjacency class has bitten in this file, and again a
  // fixture found it rather than anyone reading the pattern - an equity issue after the reporting
  // date is about as textbook a non-adjusting event as exists, and it was falling to UNCLEAR.
  /\b(?:share|rights|bonus)\s+issue\b|\bissu\w*\b(?:[^.]|\.(?=\d)){0,30}\b(?:equity|shares?|debentures?|securities)\b|\bbuy[- ]?back\b|\bdividend\b(?:[^.]|\.(?=\d)){0,25}\bdeclar|\bdeclar\w*\b(?:[^.]|\.(?=\d)){0,25}\bdividend\b/i,
  // A disposal after the reporting date is a new condition, not evidence about an old one. The
  // list had every way of BUYING something and no way of selling one.
  //
  // BOTH word orders, because "a subsidiary was sold" and "sold the subsidiary" are the same event
  // and the first version of this line matched only the second. Written one-directional while the
  // comment three lines above it describes that exact mistake - which is the argument for testing
  // patterns with fixtures rather than reading them.
  /\b(?:sold|sale|disposal|disposed|divest\w*)\b(?:[^.]|\.(?=\d)){0,40}\b(?:subsidiary|division|undertaking|business|segment|investment|stake)\b|\b(?:subsidiary|division|undertaking|segment|investment|stake)\b(?:[^.]|\.(?=\d)){0,40}\b(?:was|were|been)\s+(?:sold|disposed|divested)\b/i,
  // "new borrowing" was the only adjective allowed, so "obtained a Rs 3 crore EMERGENCY borrowing
  // facility in July" - a financing arrangement entered into after the year end, which is a new
  // condition by definition - fell to UNCLEAR. Any borrowing OBTAINED after the reporting date is
  // the same event whatever the adjective in front of it.
  /\b(?:new|fresh|additional|emergency|further|standby|bridge)\s+(?:borrowing|loan|facility|credit line)\b|\b(?:obtained|secured|arranged|raised|entered into)\b(?:[^.]|\.(?=\d)){0,50}\b(?:borrowing|loan|facility|credit line)\b/i,
  /\b(?:announced|commenced|launched|entered into)\b(?:[^.]|\.(?=\d)){0,60}\b(?:plan|expansion|restructuring|contract)\b/i,
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
export function classifySubsequentEvent(text, options = {}) {
  const value = typeof text === "string" ? text : "";
  // Three independent routes into the window, and the third is the one that reaches an item with
  // no date of its own: a phrase saying so, a date the document's own reporting date places after
  // the year end, or a DECLARED context - the item sits inside a block the document itself
  // introduced as "the following occurred after 31 March 2026". Both options are optional, so
  // every existing caller keeps working unchanged.
  const inWindow =
    options.inDeclaredWindow === true
    || SUBSEQUENT_WINDOW.test(value)
    || namesADateAfter(value, options.reportingDate ?? null);
  if (!value.trim() || !inWindow) {
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

/**
 * Every subsequent event in the document, individually classified.
 *
 * WHY THIS EXISTS
 * classifySubsequentEvent was only ever reached through a FINDING - the structured model attaches
 * it to a finding's subject. So an event the model did not write about was never classified at
 * all, and a schedule of nine events could produce two classifications and seven silences. The
 * reader has no way to tell a silence from a clean event.
 *
 * Driven from the document's own sections, so the count is a property of the document rather than
 * of what the model chose to mention. Same principle as AA-01 and AA-31, applied to SA 560.
 *
 * @param sections from extractDocumentSections
 * @param text the whole document, used only to find its stated reporting date
 */
export function buildSubsequentEventRegister(sections, text) {
  if (!Array.isArray(sections) || sections.length === 0) return null;

  const reportingDate = findReportingDate(text);

  // AA-37. The spans the document itself declares to be schedules of post-reporting-date events.
  //
  // A declaration opens the block; the block runs to the next section that is NOT one of the items
  // listed under it. Items in a schedule are lettered or bulleted, so the block ends at the next
  // numbered or labelled section - which is exactly where the document moves on to another subject.
  const declaredSpans = [];
  for (const section of sections) {
    if (!SUBSEQUENT_CONTEXT_DECLARATION.test(section.text)) continue;
    // The declaration must also state the boundary it is declaring. A real schedule says which
    // date its items fall after; a heading that merely uses the words - an instruction saying
    // "SUBSEQUENT EVENTS: analyse each event from section 30 separately" - does not, and without
    // this the instruction block swallowed its own bullets and reported them as client events.
    if (!DECLARES_A_BOUNDARY_DATE.test(section.text)) continue;
    const after = sections.filter(
      (s) => s.start > section.start && (s.kind === "numbered" || s.kind === "labelled"),
    );
    declaredSpans.push({ start: section.start, end: after.length > 0 ? after[0].start : Infinity });
  }
  const inDeclaredWindow = (section) =>
    declaredSpans.some((span) => section.start >= span.start && section.start < span.end);

  const events = [];

  // When the document declares a schedule, THAT is the register. Elsewhere in a long file, many
  // sections mention an April or May date in passing - depreciation starting 1 April, a payment
  // made in April, a bank email of 20 April - and reporting twenty-six "subsequent events" for a
  // document that lists nine is noise that buries the nine. The other sections are not lost: they
  // are accounted for by the section ledger and by the findings themselves.
  //
  // A document with no declared schedule keeps the per-section behaviour, which is the only way to
  // find events in a file that never gathers them under a heading.
  const considered =
    declaredSpans.length > 0 ? sections.filter((s) => inDeclaredWindow(s)) : sections;

  for (const section of considered) {
    // The section that DECLARES the schedule is not itself one of the events. Its text is the
    // boundary statement, and listing it beside the nine items would report ten.
    if (SUBSEQUENT_CONTEXT_DECLARATION.test(section.text) && DECLARES_A_BOUNDARY_DATE.test(section.text)) {
      continue;
    }
    const verdict = classifySubsequentEvent(section.text, {
      reportingDate,
      inDeclaredWindow: inDeclaredWindow(section),
    });
    if (verdict.classification === SUBSEQUENT_EVENT.NOT_A_SUBSEQUENT_EVENT) continue;
    events.push({
      label: section.label,
      classification: verdict.classification,
      // What the classification MEANS for the accounts, in the vocabulary a reviewer works in:
      // whether the condition existed at the reporting date, and whether the answer changes the
      // figures or only a note.
      conditionAtReportingDate:
        verdict.classification === SUBSEQUENT_EVENT.ADJUSTING
          ? true
          : verdict.classification === SUBSEQUENT_EVENT.NON_ADJUSTING
            ? false
            : null,
      treatment:
        verdict.classification === SUBSEQUENT_EVENT.ADJUSTING
          ? "adjustment"
          : verdict.classification === SUBSEQUENT_EVENT.NON_ADJUSTING
            ? "disclosure"
            : "further evidence required",
      basis: verdict.basis,
      action: verdict.action,
    });
  }

  if (events.length === 0) return null;

  const byClassification = {};
  for (const value of Object.values(SUBSEQUENT_EVENT)) {
    if (value !== null) byClassification[value] = 0;
  }
  for (const event of events) byClassification[event.classification] += 1;

  return {
    total: events.length,
    // Equal to total by construction and reported anyway, for the same reason the section ledger
    // reports it: a reader should see the two numbers agree rather than take it on trust.
    classified: events.filter((e) => e.classification).length,
    reportingDate: reportingDate
      ? { month: reportingDate.month + 1, year: reportingDate.year }
      : null,
    byClassification,
    events,
  };
}
