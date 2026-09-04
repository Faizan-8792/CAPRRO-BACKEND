// Deterministic detection of statements in one document that cannot both hold as written.
//
// AA-03 in .kiro/audit-assistance-defects.md. The reviewer's cases:
//
//   "There are no related parties."          ... later ... "The director's spouse owns 12%."
//   "All statutory dues were paid on time."  ... later ... "Rs 5.2 lakh was paid after the due date."
//   "There is no outstanding legal uncertainty." ... later ... "Counsel cannot predict the outcome."
//
// Each pair is the single most useful thing in the document, and the product read straight past
// all three. A contradiction is not a subtle inference: it is the one finding an auditor can act on
// without any further evidence, because the document has already supplied both halves.
//
// THE RULE THAT SHAPES THIS MODULE: IT MUST NOT PICK A SIDE
// The tempting design is to decide which statement is right. That is exactly wrong. Which one is
// true is a question for evidence, and a product that quietly resolves the conflict destroys the
// finding - the reader never learns the document disagreed with itself. So both statements are
// quoted verbatim, side by side, and the reader is told to establish which holds. Nothing is
// resolved here and nothing is dropped.
//
// WHY DETERMINISTIC
// A contradiction is a property of two spans of text, not a judgement. It can be found without a
// model, it cannot be hallucinated, and it can be tested exactly. Everything the model contributes
// is a draft; this is not.

/** At most this many contradiction findings, so a messy document cannot flood the response. */
const MAX_CONTRADICTIONS = 4;

/** A quote shorter than this is not enough for a reader to locate the statement. */
const MIN_QUOTE_LENGTH = 12;

/**
 * Abbreviations whose full stop does not end a sentence. Without these, "Rs. 5.2 lakh was paid
 * after the due date" splits into fragments and the quote shown to the reader is unusable - which
 * matters more than usual here, because the whole finding IS the two quotes.
 */
const ABBREVIATION_ENDING =
  /\b(?:Rs|No|Nos|Ltd|Pvt|Co|Mr|Mrs|Ms|Dr|Prof|Smt|Shri|viz|etc|Inc|Corp|Sec|Cl|Para|Vol|Fig|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|i\.e|e\.g|w\.e\.f|a\.m|p\.m)\.$/i;

/**
 * Splits text into sentences, keeping each one's offset so a quote can be reported with its
 * position and so two matches can be proved to come from different statements.
 */
export function splitSentences(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const sentences = [];
  const boundary = /[.!?](?=\s|$)/g;
  let start = 0;
  let match;

  while ((match = boundary.exec(text))) {
    const end = match.index + 1;
    const candidate = text.slice(start, end);
    // A full stop that only closes an abbreviation is not a sentence boundary.
    if (ABBREVIATION_ENDING.test(candidate.trimEnd())) continue;

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      sentences.push({ text: trimmed, start: start + candidate.indexOf(trimmed.charAt(0)) });
    }
    start = end;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push({ text: tail, start: text.length - tail.length });

  return sentences;
}

/**
 * A denial that has been properly qualified is not a contradiction.
 *
 * "There are no related parties other than those disclosed in Note 32" followed by a related-party
 * disclosure is a correctly drafted note, not a conflict. Missing this distinction would make the
 * check fire on well-prepared financial statements, and a check that cries wolf on good documents
 * teaches the reader to ignore it - which costs more than the finding is worth.
 */
const DENIAL_QUALIFIERS =
  /\b(?:other than|apart from|except(?:ing)?|save (?:for|as)|besides|as (?:disclosed|reported|detailed|set out|listed|stated)|disclosed in note|refer(?:red)? to in note|note \d|listed below|stated below|detailed below|set out below|as follows)\b/i;

/**
 * The contradiction families.
 *
 * Each is a subject on which a document commonly asserts a clean position in one place and reveals
 * the opposite in another. `denials` are the clean assertion; `affirmations` are the facts that
 * cannot sit beside it. Families are kept separate rather than merged into one big pattern so each
 * can be shown independently load-bearing - a merged pattern lets the deletion of any one half
 * survive the tests, which is how a family silently stops working.
 */
const FAMILIES = [
  {
    id: "related-parties",
    subject: "related parties",
    standard: "SA 550",
    denials: [
      /\b(?:there\s+(?:are|were)\s+)?no\s+related\s+part(?:y|ies)\b/i,
      /\brelated\s+part(?:y|ies)[^.]{0,40}\b(?:nil|none|not\s+applicable)\b/i,
      /\bno\s+transactions?\s+with\s+related\s+part(?:y|ies)\b/i,
    ],
    affirmations: [
      /\b(?:director|promoter|key\s+managerial\s+personnel|KMP)(?:'s|s')?\s+(?:spouse|relative|son|daughter|brother|sister|father|mother|wife|husband)\b/i,
      /\b(?:spouse|relative|son|daughter)\s+of\s+(?:a|the)\s+director\b/i,
      /\bdirector[^.]{0,50}\b(?:owns|holds|holding|shareholding)\b/i,
      /\brelated\s+part(?:y|ies)\s+transactions?\s+(?:of|amounting|aggregating|totalling)\b/i,
      /\bcommon\s+director(?:ships?)?\b/i,
    ],
  },
  {
    id: "statutory-dues",
    subject: "statutory dues",
    standard: "SA 250",
    denials: [
      /\ball\s+statutory\s+dues[^.]{0,60}\b(?:paid|remitted|deposited)\b/i,
      /\bno\s+(?:outstanding\s+|arrears\s+of\s+)?statutory\s+dues\b/i,
      /\bno\s+delay\b[^.]{0,40}\bstatutory\s+dues\b/i,
      /\bstatutory\s+dues[^.]{0,40}\b(?:paid|remitted)\s+(?:on\s+time|within\s+(?:the\s+)?due\s+date)\b/i,
    ],
    affirmations: [
      /\b(?:paid|remitted|deposited)\b[^.]{0,40}\bafter\s+the\s+due\s+date\b/i,
      /\bdelay(?:s|ed)?\b[^.]{0,50}\b(?:remittances?|payments?|deposits?|remitting|depositing)\b/i,
      /\b(?:outstanding|unpaid|in\s+arrears)\b[^.]{0,40}\bmore\s+than\s+six\s+months\b/i,
      /\binterest\s+(?:on|for)\s+(?:late|delayed|belated)(?:ly)?\b/i,
      /\b(?:TDS|GST|PF|ESI|provident\s+fund)\b[^.]{0,50}\b(?:late(?:ly)?|delayed|belated(?:ly)?|after\s+the\s+due)\b/i,
    ],
  },
  {
    id: "litigation",
    subject: "litigation and legal uncertainty",
    standard: "SA 501",
    denials: [
      /\bno\s+(?:pending\s+)?litigation\b/i,
      /\bno\s+(?:material\s+)?legal\s+(?:uncertainty|proceedings|claims?|cases?)\b/i,
      /\bno\s+contingent\s+liabilit(?:y|ies)\b/i,
      /\bno\s+outstanding\s+legal\b/i,
      /\bno\s+claims?\s+(?:are\s+)?(?:pending|outstanding)\b/i,
    ],
    affirmations: [
      /\boutcome\s+cannot\s+be\s+(?:predicted|determined|estimated|assessed)\b/i,
      /\b(?:counsel|lawyer|advocate|legal\s+(?:advisor|adviser|counsel))\b[^.]{0,70}\b(?:cannot|unable|not\s+able|no\s+view)\b/i,
      /\bshow\s+cause\s+notices?\b/i,
      /\bpending\s+before\s+the\s+(?:tribunal|court|commissioner|authority|appellate)\b/i,
      /\bdisputed\s+demands?\b/i,
      /\blegal\s+claims?\s+of\b/i,
      /\bwrit\s+petitions?\b/i,
    ],
  },
  {
    id: "going-concern",
    subject: "going concern",
    standard: "SA 570",
    denials: [
      /\bno\s+(?:material\s+)?uncertaint(?:y|ies)\b[^.]{0,60}\bgoing\s+concern\b/i,
      /\bgoing\s+concern\b[^.]{0,60}\bno\s+(?:material\s+)?uncertaint(?:y|ies)\b/i,
      /\bno\s+going\s+concern\s+(?:issue|uncertainty|doubt|risk)\b/i,
      /\bability\s+to\s+continue\s+as\s+a\s+going\s+concern\s+is\s+not\s+in\s+doubt\b/i,
    ],
    affirmations: [
      /\bnet\s+current\s+liabilit(?:y|ies)\b/i,
      /\bunable\s+to\s+refinance\b/i,
      /\bdefault(?:ed)?\s+(?:on|in)\s+(?:the\s+)?repayments?\b/i,
      /\baccumulated\s+losses\b[^.]{0,50}\bexceed(?:s|ed)?\b/i,
      /\bgoing\s+concern\s+uncertaint(?:y|ies)\b/i,
      /\bnegative\s+(?:net\s+worth|operating\s+cash\s+flows?)\b/i,
    ],
  },
  {
    id: "internal-controls",
    subject: "internal controls",
    standard: "SA 265",
    denials: [
      /\binternal\s+(?:financial\s+)?controls?\b[^.]{0,70}\b(?:operating\s+effectively|were\s+effective|are\s+effective|adequate|no\s+weakness)\b/i,
      /\bno\s+(?:material\s+)?(?:weakness(?:es)?|deficienc(?:y|ies))\b[^.]{0,50}\bcontrols?\b/i,
      /\bcontrols?\b[^.]{0,50}\bno\s+(?:material\s+)?(?:weakness(?:es)?|deficienc(?:y|ies))\b/i,
    ],
    affirmations: [
      /\b(?:no|lack\s+of|without)\s+segregation\s+of\s+duties\b/i,
      /\bcontrols?\s+(?:was|were)\s+not\s+operating\b/i,
      /\bmanagement\s+overrides?\b/i,
      /\bmaterial\s+weakness(?:es)?\b/i,
      /\bsame\s+person\b[^.]{0,60}\b(?:approv|authoris|authoriz|record|reconcil)/i,
      /\bnot\s+(?:independently\s+)?reviewed\b/i,
    ],
  },
  {
    id: "physical-verification",
    subject: "physical verification of inventory",
    standard: "SA 501",
    denials: [
      /\bphysical\s+verification\b[^.]{0,70}\b(?:carried\s+out|conducted|performed|completed|done)\b/i,
      /\bstock\s+(?:count|taking|verification)\b[^.]{0,60}\b(?:carried\s+out|conducted|performed|completed)\b/i,
      /\ball\s+locations?\s+(?:were|was)\s+(?:physically\s+)?verified\b/i,
    ],
    affirmations: [
      /\bno\s+(?:cycle\s+)?counts?\b[^.]{0,50}\b(?:performed|carried\s+out|conducted|since|taken)\b/i,
      /\bnot\s+(?:been\s+)?(?:physically\s+)?verified\b/i,
      /\bcount\s+(?:was|were)\s+not\s+(?:performed|carried\s+out|conducted)\b/i,
      /\b(?:could\s+not|unable\s+to)\b[^.]{0,40}\b(?:attend|observe|verify|witness)\b/i,
      /\bno\s+physical\s+verification\b/i,
    ],
  },
  {
    id: "subsequent-events",
    subject: "events after the reporting date",
    standard: "SA 560",
    denials: [
      /\bno\s+(?:material\s+)?(?:subsequent\s+events?|events?\s+subsequent)\b/i,
      /\bno\s+(?:material\s+)?events?\b[^.]{0,50}\bafter\s+the\s+(?:year|reporting)[\s-]?end\b/i,
      /\bnothing\s+(?:has\s+)?(?:occurred|arisen)\b[^.]{0,50}\bafter\s+the\s+(?:year|reporting)[\s-]?end\b/i,
    ],
    affirmations: [
      /\bsubsequent\s+to\s+the\s+(?:year|reporting)[\s-]?end\b[^.]{0,90}\b(?:reduced|cancelled|terminated|filed|announced|lost|defaulted|withdrew|closed|resigned|insolven)/i,
      /\bafter\s+the\s+(?:year|reporting)[\s-]?end\b[^.]{0,90}\b(?:reduced|cancelled|terminated|filed|announced|lost|defaulted|withdrew|closed|resigned|insolven)/i,
      /\bpost[\s-]?(?:year|balance\s+sheet)[\s-]?(?:end|date)\b[^.]{0,90}\b(?:reduced|cancelled|terminated|filed|announced|lost|defaulted)/i,
    ],
  },
  {
    id: "borrowing-default",
    subject: "repayment of borrowings",
    standard: "SA 505",
    denials: [
      /\bno\s+default\b[^.]{0,50}\b(?:repayments?|principal|interest|borrowings?|loans?|instal?ments?)\b/i,
      /\ball\s+(?:loan\s+)?(?:repayments?|instal?ments?)\b[^.]{0,50}\b(?:on\s+time|regular|timely|as\s+per\s+schedule)\b/i,
      /\bno\s+(?:breach|covenant\s+breach|violation)\b[^.]{0,50}\bcovenant/i,
      /\bcovenants?\b[^.]{0,50}\b(?:were|was|have\s+been|has\s+been)\s+(?:complied|met|satisfied)\b/i,
    ],
    affirmations: [
      /\bdefault(?:ed|s)?\b[^.]{0,50}\b(?:repayments?|instal?ments?|principal|interest)\b/i,
      /\bcovenants?\b[^.]{0,50}\bbreach/i,
      /\bbreach(?:ed|es)?\b[^.]{0,50}\bcovenant/i,
      /\boverdue\b/i,
      /\bnot\s+(?:been\s+)?paid\s+on\s+(?:the\s+)?due\s+date\b/i,
      /\brecalled\s+the\s+facilit(?:y|ies)\b/i,
    ],
  },
];

/** Trims a sentence to something quotable without losing the part that matters. */
function quotable(sentence) {
  const text = sentence.replace(/\s+/g, " ").trim();
  return text.length <= 220 ? text : `${text.slice(0, 217)}...`;
}

/**
 * Every contradiction in the text, one per family at most.
 *
 * Both halves are returned with their offsets. A caller that wants to prove a quote is genuine can
 * check it against the submitted text, which is the same discipline the controller already applies
 * to model-supplied evidence.
 */
export function findContradictions(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const sentences = splitSentences(text);
  if (sentences.length < 2) return [];

  const found = [];

  for (const family of FAMILIES) {
    const denial = sentences.find(
      (sentence) =>
        sentence.text.length >= MIN_QUOTE_LENGTH &&
        family.denials.some((pattern) => pattern.test(sentence.text)) &&
        // A qualified denial is a correctly drafted note, not a conflict.
        !DENIAL_QUALIFIERS.test(sentence.text),
    );
    if (!denial) continue;

    const affirmation = sentences.find(
      (sentence) =>
        // A single sentence saying "no related parties other than the director's spouse" is one
        // statement, not two conflicting ones, so the halves must come from different sentences.
        sentence.start !== denial.start &&
        sentence.text.length >= MIN_QUOTE_LENGTH &&
        family.affirmations.some((pattern) => pattern.test(sentence.text)),
    );
    if (!affirmation) continue;

    found.push({
      id: family.id,
      subject: family.subject,
      standard: family.standard,
      denial: { quote: quotable(denial.text), position: denial.start },
      affirmation: { quote: quotable(affirmation.text), position: affirmation.start },
    });

    if (found.length >= MAX_CONTRADICTIONS) break;
  }

  return found;
}

/**
 * The contradictions as findings, ready to sit in the response beside everything else.
 *
 * The wording is chosen to state the conflict without resolving it, and without asserting anything
 * about the client beyond what the document already says on its own two pages. It passes the AA-04
 * over-conclusion guard unchanged, which the contract pins.
 */
export function buildContradictionInsights(text) {
  return findContradictions(text).map((item) => ({
    title: `Two statements about ${item.subject} cannot both be true`,
    detail:
      `This document states: "${item.denial.quote}" ` +
      `It also states: "${item.affirmation.quote}" ` +
      "Both cannot hold as written. Establish which one the evidence supports before relying on " +
      "either, and if the first was a management representation, obtain it again in corrected " +
      "form.",
    // High because it needs no further evidence to be worth acting on - the document has already
    // supplied both halves, which is rarely true of anything else on the page.
    risk: "high",
    standard: item.standard,
    // The denial is the quote a reader will want to find first, and it is verbatim from the
    // submitted text, so it satisfies the same grounding rule as model-supplied evidence.
    evidence: item.denial.quote,
    why:
      "A document that contradicts itself has already given away that one of the two statements " +
      "is unsupported, and which one it is cannot be settled by reading more carefully - only by " +
      "evidence. Choosing between them here would hide the most useful thing on the page.",
    nextAction:
      "Put both statements side by side, identify which is supported by evidence on file, and " +
      "document the resolution. Do not carry both forward.",
    // AA-04. That both statements appear in the document is checkable by reading it, so the
    // finding is a confirmed fact. Which of the two is TRUE remains open, and the detail says so.
    deterministic: true,
    amountMinor: null,
    workingPaperRef: null,
    contradiction: item,
  }));
}
