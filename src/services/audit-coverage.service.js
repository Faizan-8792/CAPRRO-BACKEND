// Deterministic, fact-level coverage accounting for submitted audit text.
//
// AA-01 in .kiro/audit-assistance-defects.md. The defect: a report with 18 numbered matters
// received findings for the first several and nothing for the rest, and the response said nothing
// about it. A reader assumes the whole document was reviewed. Silent incompleteness is worse than
// a visible error, because there is nothing on screen to disbelieve.
//
// WHAT ALREADY EXISTED, AND IS PRESERVED
// The controller already computes coverage deterministically for documents that use the
// `[WP Ref: ...]` convention (findUncoveredSections, buildCoverageCheckPrompt,
// extractAllWorkingPaperRefTags, sectionTextsByWorkingPaperRef). That machinery is good and is not
// replaced. Two things were missing from it and are added here:
//
//   1. An ORDINARY UNTAGGED REPORT had no coverage measure at all. Tags are a convention this
//      product suggests, not one a client's document follows, and the reviewer's own failing case
//      was untagged. This module finds addressable units in any document: numbered headings,
//      lettered clauses, bulleted items, and paragraphs carrying a monetary amount.
//   2. Coverage was ADVISORY. A second pass ran, and if it failed or found nothing the response
//      shipped as though complete. Here, an unaddressed material unit produces a finding that
//      names it, so the gap is on screen.
//
// WHAT "BLOCKING" HONESTLY MEANS HERE
// This module cannot invent an audit finding for a section the model did not address - inventing
// one would be a far worse defect than omitting it. So the gate does not fabricate: it forces the
// omission to be *declared*. A response may ship incomplete; it may not ship incomplete and
// silent. That is the difference the defect is actually about.

/** A unit must look substantive before its absence is worth reporting. */
const MIN_UNIT_TEXT_LENGTH = 40;

/**
 * A unit is MATERIAL - and so must be addressed or explicitly declared unaddressed - when it
 * carries a monetary amount or audit-relevant subject matter. Without this, a heading such as
 * "Introduction" or "Basis of preparation" would demand a finding and the gate would cry wolf on
 * every document.
 */
const MATERIALITY_CUES = [
  /(?:₹|Rs\.?|INR)\s*\d/i,
  /\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?|cr\b)/i,
  /\b(?:provision|accrual|impairment|write[- ]?off|written off)\b/i,
  /\b(?:related part(?:y|ies)|director|key managerial)\b/i,
  /\b(?:covenant|borrowing|loan|overdraft|facility)\b/i,
  /\b(?:going concern|liquidity|insolven\w+)\b/i,
  /\b(?:statutory dues?|TDS|GST|PF|ESI|income tax)\b/i,
  /\b(?:litigation|legal claim|dispute|contingent)\b/i,
  // A trailing \b after a STEM defeats the stem: /\bcapitalis\b/ cannot match "capitalised", and
  // /\bfixed asset\b/ cannot match "Fixed assets". Both were written that way and both silently
  // dropped a real matter from the coverage count - the exact failure mode this module exists to
  // prevent, reproduced inside the module itself. Stems are left open-ended on purpose; only whole
  // words keep the closing boundary.
  /\bsubsequent(?:ly)?\b|\bafter the (?:year|reporting)[- ]end\b|\bpost[- ]year[- ]end\b/i,
  /\bjournal entr|\bmanual entr|\bJE\b/i,
  /\brevenue\b|\bsales\b|\breceivable|\bdebtor|\bcreditor|\binventor|\bstock\b/i,
  /\bdepreciat|\bcapitalis|\bcapitaliz|\bfixed asset|\bCWIP\b/i,
  /\bfraud|\boverride\b|\bmisappropriat|\bunsupported\b|\bunauthoris|\bunauthoriz/i,
  /\bestimate|\bassumption|\bvaluation\b|\bfair value\b|\bECL\b/i,
  /\bwarrant(?:y|ies)\b|\bbonus\b|\bgratuity\b|\bleave encashment\b/i,
];

/**
 * Openings that begin an addressable unit in an untagged document. Deliberately conservative: a
 * numbered or lettered heading at the start of a line, or a bullet. A sentence beginning "1998 was
 * a different year" must not become a unit, so a number opening requires a following separator.
 */
const UNIT_OPENERS = [
  // "1." / "12)" / "3 -" at the start of a line
  { kind: "numbered", pattern: /^[ \t]*(\d{1,3})\s*[.)\-:]\s+\S/ },
  // "Section 5", "Note 12", "Para 3", "Item 7", "Matter 4"
  { kind: "labelled", pattern: /^[ \t]*((?:section|note|para(?:graph)?|item|matter|point|clause)\s+\d{1,3})\b/i },
  // "(a)" / "a)" / "A." / "b." lettered clauses.
  //
  // Uppercase and the full stop were both missing, and the cost was not theoretical: a schedule of
  // nine subsequent events written "A." to "I." matched nothing, so not one of them became a unit.
  // They were absorbed into the span of whatever numbered section preceded them - the last unit
  // runs to end of text - and a reviewer was told nothing about any of them.
  //
  // The looser pattern can also match an initial ("R. K. Sharma is a director"), so a lettered
  // opener is only honoured when the document contains at least two of them. Two is a list; one is
  // a name.
  { kind: "lettered", pattern: /^[ \t]*\(?([A-Za-z])[.)]\s+\S/, needsCompany: true },
  // Bulleted lines
  { kind: "bullet", pattern: /^[ \t]*[-*•–]\s+\S/ },
];

const WORKING_PAPER_REF_PATTERN = /\[WP Ref:\s*([^\]]+)\]/gi;

/**
 * How a model joins two separate passages inside one evidence quote: "first passage ... second
 * passage". The joined string exists nowhere in the document, so it must be split before any
 * containment test.
 *
 * Defined here as a named constant rather than written inline, because writing it inline through a
 * shell is how it first shipped with every backslash eaten - the "s" and "." lost their escapes,
 * "." then matched any character, ordinary quotes were split into fragments, and eight tests failed
 * at once. Standing rule 8 in .kiro/audit-assistance-defects.md: write regexes with an editor.
 */
const ELIDED_QUOTE_JOIN = /\s*(?:\.\.\.|…|\[\s*\.\.\.\s*\])\s*/;

/**
 * Every structural section opening in the document, in order.
 *
 * Shared by the coverage units and the section ledger so the two can never disagree about where a
 * section begins - which they would, sooner or later, if each found its own.
 */
function structuralStarts(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    for (const opener of UNIT_OPENERS) {
      const m = line.match(opener.pattern);
      if (m) {
        starts.push({
          kind: opener.kind,
          label: String(m[1] ?? "").trim(),
          start: offset,
          needsCompany: opener.needsCompany === true,
        });
        break;
      }
    }
    offset += line.length + 1;
  }

  // A lettered opener that stands alone is far more likely an initial than a list. Dropped as a
  // group, because "at least two" is a property of the kind, not of any one line.
  const letteredCount = starts.filter((s) => s.needsCompany).length;
  return letteredCount >= 2 ? starts : starts.filter((s) => !s.needsCompany);
}

/** Whether a unit's own text makes it worth accounting for. */
function isMaterialUnit(text) {
  if (text.trim().length < MIN_UNIT_TEXT_LENGTH) return false;
  return MATERIALITY_CUES.some((cue) => cue.test(text));
}

/**
 * Splits the document into the units a reader would expect to see addressed.
 *
 * Tagged documents keep their existing identity: a `[WP Ref: X]` section becomes a unit labelled
 * by its ref, so this agrees with the controller's own per-section accounting rather than
 * competing with it. Untagged documents fall back to structural openers, and a document with
 * neither falls back to paragraphs that carry an amount - which is the minimum needed for the
 * reviewer's failing case to be measurable at all.
 */
export function extractAddressableUnits(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  // 1. The existing convention wins where present.
  const tagged = [];
  WORKING_PAPER_REF_PATTERN.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = WORKING_PAPER_REF_PATTERN.exec(text))) {
    tagged.push({ ref: tagMatch[1].trim(), start: tagMatch.index });
  }
  if (tagged.length > 0) {
    return tagged
      .map((tag, i) => {
        const end = i + 1 < tagged.length ? tagged[i + 1].start : text.length;
        const body = text.slice(tag.start, end);
        return {
          id: `wp:${tag.ref}`,
          label: tag.ref,
          kind: "working-paper-ref",
          start: tag.start,
          end,
          text: body,
          material: isMaterialUnit(body),
        };
      })
      .filter((unit) => unit.material);
  }

  // 2. Structural openers, line by line.
  const starts = structuralStarts(text);

  if (starts.length >= 2) {
    return starts
      .map((s, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].start : text.length;
        const body = text.slice(s.start, end);
        return {
          id: `${s.kind}:${s.label || i + 1}`,
          label: s.label || String(i + 1),
          kind: s.kind,
          start: s.start,
          end,
          text: body,
          material: isMaterialUnit(body),
        };
      })
      .filter((unit) => unit.material);
  }

  // 3. Last resort: paragraphs carrying an amount. A document with no structure at all still has
  //    measurable content, and this is the case the reviewer's Test 3 shape reduces to when its
  //    numbering is lost by extraction.
  const units = [];
  let cursor = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const start = text.indexOf(para, cursor);
    cursor = start + para.length;
    if (!isMaterialUnit(para)) continue;
    units.push({
      id: `para:${units.length + 1}`,
      label: `paragraph ${units.length + 1}`,
      kind: "paragraph",
      start,
      end: start + para.length,
      text: para,
      material: true,
    });
  }
  return units;
}

/** Normalises for substring comparison the same way the controller's grounding does. */
const normalise = (value) =>
  String(value ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Which units the supplied findings actually reach.
 *
 * A unit counts as covered when a finding's grounded evidence quote, or its working-paper ref,
 * falls inside that unit. Evidence is the honest signal: the controller already guarantees a quote
 * appears verbatim in the submitted text, so a quote landing inside a unit is proof the finding is
 * about that unit rather than a guess from a similar title.
 */
export function computeCoverage(text, insights) {
  const units = extractAddressableUnits(text);
  const list = Array.isArray(insights) ? insights : [];

  const coveredIds = new Set();

  for (const unit of units) {
    const unitText = normalise(unit.text);

    for (const finding of list) {
      // The tagged case: an explicit ref match is decisive.
      if (
        finding?.workingPaperRef &&
        unit.kind === "working-paper-ref" &&
        normalise(finding.workingPaperRef) === normalise(unit.label)
      ) {
        coveredIds.add(unit.id);
        break;
      }

      // An evidence quote may be ELIDED: the model joins two passages it is reasoning across with
      // an ellipsis, as in "Management has confirmed there are no related parties ... The
      // shareholders schedule shows a director's spouse owns 12%". Such a string exists nowhere in
      // the document as one span, so a single containment test can never place it, and the finding
      // earned no coverage credit at all - which is how a live response came to name matters as
      // unreviewed directly above findings about them.
      //
      // Each fragment is still a verbatim quote, so each is checked separately and any one of them
      // landing in a unit is enough. This only ever ADDS credit, and only for text the document
      // actually contains; it cannot credit a unit for an invented quote.
      const fragments = normalise(finding?.evidence)
        .split(ELIDED_QUOTE_JOIN)
        .map((part) => part.trim())
        .filter((part) => part.length >= 12);
      if (fragments.length === 0) continue; // too short to locate anything

      // Containment in a unit IS the grounding check. Every unit's text is a slice of the
      // submitted document, so a quote found inside a unit is necessarily found in the document -
      // an earlier version tested both and the document-level test could never fail on its own.
      // Mutation testing exposed it as dead logic rather than defence in depth, and dead logic in
      // a gate is a liability: it reads like a safeguard and guarantees nothing.
      if (fragments.some((fragment) => unitText.includes(fragment))) {
        coveredIds.add(unit.id);
        break;
      }
    }
  }

  const uncovered = units.filter((unit) => !coveredIds.has(unit.id));

  return {
    units,
    unitCount: units.length,
    coveredCount: units.length - uncovered.length,
    uncovered,
    uncoveredCount: uncovered.length,
    // Undefined rather than 1 for a document with no measurable units, so "no units" is never
    // mistaken for "fully covered".
    ratio: units.length === 0 ? null : (units.length - uncovered.length) / units.length,
  };
}

/**
 * The gate. Returns the findings that must be added so an incomplete answer cannot ship silently,
 * plus the ledger a caller can attach to its response.
 *
 * It never fabricates an audit finding about an unaddressed section - it names the sections that
 * were not addressed and says plainly that they still need work. That is the whole point: the
 * reader learns what was not reviewed instead of assuming everything was.
 */
export function buildCoverageLedger(text, insights) {
  const coverage = computeCoverage(text, insights);

  if (coverage.unitCount === 0 || coverage.uncoveredCount === 0) {
    return { coverage, findings: [], complete: coverage.unitCount > 0 };
  }

  const named = coverage.uncovered
    .slice(0, 12)
    .map((unit) => unit.label)
    .join(", ");
  const more =
    coverage.uncoveredCount > 12 ? ` and ${coverage.uncoveredCount - 12} more` : "";

  return {
    coverage,
    complete: false,
    findings: [
      {
        title: "Parts of this document were not reviewed",
        detail:
          `This text contains ${coverage.unitCount} matters that call for audit attention. ` +
          `${coverage.coveredCount} of them have a finding above. The following did not: ` +
          `${named}${more}. ` +
          "Treat those as not yet reviewed rather than as reviewed and clear, and either run the " +
          "review again on those sections or work through them yourself.",
        // The absence of work is not itself an audit risk about the client, but it is the most
        // consequential thing on the page: it tells the reader what the rest of the page does not
        // cover.
        risk: "high",
        standard: "SA 230",
        evidence: "",
        why:
          "A review that addresses part of a document reads, on screen, exactly like a review " +
          "that addressed all of it. Without this line a reader would take the absence of a " +
          "finding as the absence of a problem, which is the one inference that must never be " +
          "available by accident.",
        nextAction:
          "Re-run the review on the sections named above, or record your own conclusion on each. " +
          "Do not sign off this area until every listed matter has been addressed or explicitly " +
          "cleared.",
        amountMinor: null,
        workingPaperRef: null,
      },
    ],
  };
}

// ── AA-31: every section of the document accounted for ────────────────────
//
// THE DEFECT
// Coverage counts MATTERS - units carrying a monetary amount or audit-relevant subject matter -
// and drops everything else before the reader ever sees it. On a 41-section memorandum that
// reported 31 units and said nothing at all about the other ten, and the ten were not filler:
// "segment disclosures were not prepared for the year", "IT general controls over the ERP were
// not tested by management", "the board minutes were not made available", "interest under the
// MSMED Act has not been computed". Every one of them is a real audit matter. They were dropped
// because they contain no rupee figure and no keyword.
//
// That is silent incompleteness, which is the failure this whole module exists to prevent, and
// AA-01's own numbers could not reveal it: 31 of 31 addressed reads as complete.
//
// WHY THIS IS SEPARATE FROM COVERAGE RATHER THAN A CHANGE TO IT
// "Matters that call for attention" and "sections of this document" are different questions and a
// reader needs both. Widening the coverage units to all 41 would answer the second by destroying
// the first - every narrative sentence would become an unaddressed matter and the declaration
// would cry wolf. So coverage is unchanged and the section ledger is additive: a count of matters
// is never offered as a substitute for a count of sections.

/** The dispositions a section may carry. Every section gets exactly one; there is no "unknown". */
export const SECTION_DISPOSITION = Object.freeze({
  COVERED: "covered",
  CONNECTED: "connected",
  INFORMATION_GAP: "information gap",
  CONTROL_DEFICIENCY: "control deficiency",
  POTENTIAL_ISSUE: "potential issue",
  NO_FURTHER_WORK: "no further work",
});

/**
 * Something the auditor asked for and did not get. The distinction from a control deficiency is
 * real and worth keeping: a gap is closed by obtaining a document, a deficiency by the client
 * fixing how it operates, and they land on different people.
 */
const INFORMATION_GAP_CUES = [
  /\b(?:not|never)\s+(?:made\s+)?(?:available|provided|furnished|produced|obtained|received|supplied|shared)\b/i,
  /\b(?:could\s+not|unable\s+to|failed\s+to|did\s+not)\s+(?:produce|provide|furnish|supply|obtain|locate|trace|substantiate)\b/i,
  /\b(?:refused|declined)\s+to\s+(?:provide|furnish|supply|give|share)\b/i,
  /\b(?:no|without)\s+(?:supporting\s+)?(?:evidence|documentation|confirmation|listing|records?|backup)\b/i,
  /\b(?:awaited|pending\s+receipt|yet\s+to\s+be\s+(?:received|provided))\b/i,
];

/**
 * Something the client should have been doing and was not. Deliberately about the OPERATION of a
 * control - performed, tested, reviewed, approved, reconciled, documented, disclosed - rather than
 * about any amount.
 */
const CONTROL_DEFICIENCY_CUES = [
  /\b(?:not|never)\s+(?:been\s+)?(?:tested|reviewed|approved|authorised|authorized|reconciled|documented|disclosed|prepared|performed|computed|restated|updated|signed|covered)\b/i,
  /\b(?:no|without)\s+(?:disclosure|approval|authorisation|authorization|documentation|second\s+approval|review)\b/i,
  /\b(?:was|were|has\s+been|have\s+been)\s+(?:changed|bypassed|overridden|circumvented)\b/i,
  /\bdid\s+not\s+(?:cover|test|review|reconcile|operate)\b/i,
];

/**
 * Every structural section of the document with its text, whether or not it looks material.
 *
 * Exported so other deterministic services can account for the document SECTION BY SECTION rather
 * than finding by finding. That distinction is the recurring root cause in this area: anything
 * driven by the findings can only describe what the model happened to write about, and is silent
 * about the rest.
 */
export function extractDocumentSections(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const starts = structuralStarts(text);
  if (starts.length < 2) return [];
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].start : text.length;
    return {
      label: sectionLabel(start, index),
      kind: start.kind,
      start: start.start,
      end,
      text: text.slice(start.start, end),
    };
  });
}

/** The label a reader would use for a section, from its opener. */
const sectionLabel = (start, index) => {
  if (start.kind === "numbered") return `section ${start.label}`;
  if (start.kind === "lettered") return `item ${start.label}`;
  if (start.kind === "labelled") return start.label;
  return `section ${index + 1}`;
};

/**
 * Every structural section of the document with exactly one disposition each.
 *
 * Returns null when the document has no structural sections at all - an unstructured note has
 * nothing to enumerate, and inventing "1 section" for it would be a worse answer than none.
 *
 * Precedence is deliberate. `covered` outranks everything, because the question a reader is
 * actually asking is "did the review address this"; the other labels then describe what was NOT
 * addressed and what kind of thing it is, which is the part they have to act on.
 */
export function buildSectionLedger(text, insights = [], links = []) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const starts = structuralStarts(text);
  if (starts.length < 2) return null;

  const normalisedText = normalise(text);
  const coveredRanges = [];
  for (const insight of insights) {
    for (const fragment of String(insight?.evidence ?? "").split(ELIDED_QUOTE_JOIN)) {
      const needle = normalise(fragment);
      if (needle.length < 12) continue;
      const at = normalisedText.indexOf(needle);
      if (at !== -1) coveredRanges.push({ at, to: at + needle.length });
    }
  }

  // The link ends, by title, so a section named on either end of a cross-issue link is reported as
  // connected rather than as an isolated matter.
  const linkedTitles = new Set();
  for (const link of links) {
    for (const key of ["fromTitle", "toTitle"]) {
      const value = String(link?.[key] ?? "").trim().toLowerCase();
      if (value) linkedTitles.add(value);
    }
  }
  const linkedRanges = [];
  for (const insight of insights) {
    if (!linkedTitles.has(String(insight?.title ?? "").trim().toLowerCase())) continue;
    for (const fragment of String(insight?.evidence ?? "").split(ELIDED_QUOTE_JOIN)) {
      const needle = normalise(fragment);
      if (needle.length < 12) continue;
      const at = normalisedText.indexOf(needle);
      if (at !== -1) linkedRanges.push({ at, to: at + needle.length });
    }
  }

  const items = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].start : text.length;
    const body = text.slice(start.start, end);

    // Positions are compared in the normalised text, so the section bounds are normalised too.
    const from = normalise(text.slice(0, start.start)).length;
    const to = from + normalise(body).length;
    const touches = (ranges) => ranges.some((r) => r.at >= from - 1 && r.at <= to);

    let disposition;
    if (touches(coveredRanges)) {
      disposition = touches(linkedRanges)
        ? SECTION_DISPOSITION.CONNECTED
        : SECTION_DISPOSITION.COVERED;
    } else if (INFORMATION_GAP_CUES.some((cue) => cue.test(body))) {
      disposition = SECTION_DISPOSITION.INFORMATION_GAP;
    } else if (CONTROL_DEFICIENCY_CUES.some((cue) => cue.test(body))) {
      disposition = SECTION_DISPOSITION.CONTROL_DEFICIENCY;
    } else if (isMaterialUnit(body)) {
      disposition = SECTION_DISPOSITION.POTENTIAL_ISSUE;
    } else {
      disposition = SECTION_DISPOSITION.NO_FURTHER_WORK;
    }

    return { label: sectionLabel(start, index), kind: start.kind, disposition };
  });

  const byDisposition = {};
  for (const value of Object.values(SECTION_DISPOSITION)) byDisposition[value] = 0;
  for (const item of items) byDisposition[item.disposition] += 1;

  return {
    total: items.length,
    // Equal to total by construction, and reported anyway: a reader is entitled to see the two
    // numbers agree rather than take it on trust, and a future change that starts dropping
    // sections will show up here as a difference instead of as silence.
    classified: items.filter((item) => item.disposition).length,
    byDisposition,
    items,
  };
}
