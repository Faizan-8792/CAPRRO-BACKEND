// Reasoning frameworks that stop a finding jumping to the end of an argument.
//
// AA-05, AA-15, AA-23, AA-24 and AA-25 in .kiro/audit-assistance-defects.md. Each is the same
// failure in a different subject: a conclusion reached before the question that decides it has been
// asked.
//
//   AA-05  Depreciation steered to "should it start 15 March" when the first question is when the
//          asset was available for use. One lower quotation treated as evidence a related-party
//          price was excessive. Rs 19L of subsequent claims treated as proving a Rs 22L provision
//          inadequate.
//   AA-15  A refusal to discuss year-end journal entries went straight towards a qualified opinion.
//   AA-23  Fraud named without naming the pressure, the opportunity or the rationalisation.
//   AA-24  An estimate assessed without its method, data, assumptions or historical accuracy.
//   AA-25  A confirmation not received, with no branch for what to do instead.
//
// Everything here is deterministic and additive: it supplies the question that was skipped, never a
// conclusion. Where the document does not raise the subject, nothing is produced.

// ── AA-05: the question that comes first ───────────────────────────────────

/**
 * Conditional-accounting traps. Each names the PRECEDENT question - the one that must be answered
 * before any treatment follows - and the comparability factors without which the tempting
 * conclusion is unsupported.
 */
const PRECEDENT_QUESTIONS = [
  {
    id: "depreciation-start",
    pattern:
      /\bdepreciat\w*/i,
    requires: /\b(?:capitalis|capitaliz|commission|install|put to use|available for use|commercial production|trial run|ready for use)\w*/i,
    question:
      "When was the asset available for use in the condition and location management intended? Depreciation follows that date, not the invoice date, the payment date or the date it was recorded.",
    factors: [
      "the date installation and commissioning were completed",
      "whether trial runs had ended and commercial production begun",
      "whether the asset was capable of operating as intended even if not yet operating",
    ],
    prohibited:
      /\bdepreciation (?:should|must) (?:start|commence|begin) (?:on|from) \d/i,
  },
  {
    id: "related-party-price",
    pattern: /\brelated part\w*|\bdirector'?s?\b|\bpromoter\b/i,
    requires: /\b(?:quotation|quote|price|rate|market|comparab|arm'?s?[- ]length)\w*/i,
    question:
      "Is the comparator actually comparable? A single lower quotation does not establish that a related-party price was excessive until the two are shown to be for the same thing on the same terms.",
    factors: [
      "the quantity and specification each price relates to",
      "the credit terms, delivery obligations and warranty attached to each",
      "the date of each price, and whether the market moved between them",
      "whether the quotation was ever capable of being accepted, or was indicative only",
    ],
    prohibited: /\bthe (?:related[- ]party )?price (?:is|was) excessive\b/i,
  },
  {
    id: "provision-adequacy",
    pattern: /\bprovision\b/i,
    requires: /\b(?:subsequent|after the (?:year|reporting)|claims? (?:of|totalling|amounting)|settled|paid)\w*/i,
    question:
      "Do the later amounts relate to the same period and the same obligation as the provision? A total paid afterwards only bears on the provision to the extent it settles obligations that existed at the reporting date.",
    factors: [
      "which reporting period each later claim relates to",
      "whether the obligation existed at the reporting date or arose after it",
      "what the provision was intended to cover, and over what period",
      "whether any later amount is a new obligation rather than a settlement of an old one",
    ],
    prohibited: /\bthe provision (?:is|was) (?:inadequate|insufficient|understated)\b/i,
  },
];

/**
 * The precedent questions a document raises, with the comparability factors each needs.
 *
 * A subject only qualifies when BOTH the subject and the triggering circumstance are present:
 * "depreciation was recomputed" raises no question on its own, and producing one for every mention
 * of depreciation would bury the cases that matter.
 */
export function findPrecedentQuestions(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return [];
  return PRECEDENT_QUESTIONS.filter(
    (entry) => entry.pattern.test(value) && entry.requires.test(value),
  ).map((entry) => ({ id: entry.id, question: entry.question, factors: entry.factors }));
}

/** The conclusions these findings must never state. Exported so a test can assert their absence. */
export const PROHIBITED_CONCLUSIONS = PRECEDENT_QUESTIONS.map((e) => ({
  id: e.id,
  pattern: e.prohibited,
}));

// ── AA-15: the ladder, and the fact that it is a ladder ────────────────────

export const ESCALATION_LADDER = Object.freeze([
  "Understand why the information is being withheld, and record the reason given.",
  "Discuss the refusal with management at a level above the person who refused.",
  "Discuss it with those charged with governance, since a refusal to provide audit evidence is itself something they need to know.",
  "Seek the same assurance from another source - the underlying records, third-party confirmation, or analytical evidence that would reveal the same thing.",
  "Assess whether the evidence now available is sufficient for the area, taking the alternative procedures into account.",
  "Only if the matter is still unresolved AND material, consider what it means for the report.",
]);

/** Language that signals a refusal or a limitation on the auditor's access. */
const REFUSAL_CUE =
  /\b(?:refus\w+|declin\w+|withheld|would not (?:provide|give|share|allow)|denied access|not (?:made )?available to us|unable to obtain|no access)\b/i;

/**
 * The escalation branch for a refusal, always as the full ladder.
 *
 * The defect was arriving at the last rung first. Returning the whole ladder, in order, with the
 * reporting consequence explicitly conditional on the first five having been worked through, is
 * what stops a refusal reading as an automatic qualification.
 */
export function buildEscalationPath(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim() || !REFUSAL_CUE.test(value)) return null;
  return {
    steps: [...ESCALATION_LADDER],
    // Stated separately so it cannot be read off the list as just another step.
    note:
      "A refusal is not itself a qualification. The reporting consequence is the last rung and only arises if the matter is still unresolved after the others, and is material.",
  };
}

// ── AA-23: fraud needs a mechanism, not an adjective ───────────────────────

const FRAUD_TRIANGLE = [
  {
    leg: "pressure",
    pattern:
      /\bcovenant\b|\btarget\b|\bforecast\b|\bbonus\b|\bincentive\b|\blisting\b|\bloss\b|\bbreak[- ]?even\b|\bdeadline\b|\bmonth end no matter what\b/i,
    prompt: "what would make someone want the numbers to be different",
  },
  {
    leg: "opportunity",
    pattern:
      /\bno segregation\b|\bsame person\b|\bmanual (?:journal|entr)\w*|\boverride\b|\bno (?:independent )?review\b|\bsole (?:signatory|approver)\b|\bweak control\w*/i,
    prompt: "what would let them do it without being stopped",
  },
  {
    leg: "rationalisation",
    pattern:
      /\byear[- ]end adjustment\b|\beveryone does\b|\btemporar(?:y|ily)\b|\bwill be reversed\b|\bcatch[- ]?up entry\b|\bimmaterial anyway\b/i,
    prompt: "what story would let them tell themselves it was acceptable",
  },
];

/**
 * Which legs of the fraud triangle the text actually supports, and which are missing.
 *
 * Naming the missing leg is the useful half. A fraud risk with pressure and opportunity but no
 * rationalisation is a different and weaker thing than one with all three, and an assessment that
 * does not say which legs it rests on cannot be argued with.
 */
export function assessFraudTriangle(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return null;

  const present = FRAUD_TRIANGLE.filter((leg) => leg.pattern.test(value)).map((l) => l.leg);
  if (present.length === 0) return null;

  const missing = FRAUD_TRIANGLE.filter((leg) => !present.includes(leg.leg));
  return {
    present,
    missing: missing.map((leg) => ({ leg: leg.leg, prompt: leg.prompt })),
    // Deliberately not a score. Two legs out of three is not "67% fraud", and a number here would
    // be read as one.
    note:
      missing.length === 0
        ? "All three legs are present in this text, which is the strongest form this indicator takes. It is still an indicator."
        : `Present: ${present.join(" and ")}. Not established from this text: ${missing
            .map((l) => l.leg)
            .join(" and ")}. Establish ${missing[0].prompt} before treating this as more than a risk factor.`,
  };
}

// ── AA-24: an estimate is a method plus its inputs ─────────────────────────

export const ESTIMATE_DIMENSIONS = Object.freeze([
  { id: "method", question: "What method was used, and is it the same one as last year?" },
  { id: "data", question: "What data was the estimate built from, and where did that data come from?" },
  { id: "assumptions", question: "Which assumptions drive the answer, and who set them?" },
  {
    id: "historical-accuracy",
    question:
      "How accurate was last year's estimate when the outcome became known? A method that was wrong last year is not made right by being applied consistently.",
  },
  {
    id: "subsequent-outcome",
    question: "What has happened since the reporting date that bears on the same obligation?",
  },
  {
    id: "bias-indicators",
    question:
      "Do the individual assumptions each sit at the favourable end of their reasonable range? Each may be defensible alone while the combination is not.",
  },
  {
    id: "sensitivity",
    question: "How much does the answer move if the key assumption moves within its reasonable range?",
  },
  {
    id: "independent-expectation",
    question: "What range would we arrive at independently, before looking at management's number?",
  },
]);

const ESTIMATE_CUE =
  /\bprovision\b|\bestimat\w+|\bimpairment\b|\bfair value\b|\bvaluation\b|\bECL\b|\bexpected credit loss\b|\buseful (?:life|lives)\b|\bwarrant(?:y|ies)\b|\bobsolescence\b/i;

/**
 * The eight questions an accounting estimate has to answer.
 *
 * Returned in full rather than filtered: the value is in the list being complete, because the one
 * an auditor skips is usually historical accuracy, and that is the one that catches a method which
 * has been quietly wrong for years.
 */
export function buildEstimateFramework(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim() || !ESTIMATE_CUE.test(value)) return null;
  return {
    dimensions: ESTIMATE_DIMENSIONS.map((d) => ({ id: d.id, question: d.question })),
    note:
      "Answer all eight before concluding on the estimate. The one most often skipped is historical accuracy, and it is the one that reveals a method that has been wrong for several years running.",
  };
}

// ── AA-25: what to do when the confirmation does not come back ─────────────

const CONFIRMATION_CUE =
  /\bconfirmation\w*|\bcirculari[sz]\w+|\bbalance confirmation\b|\bbank letter\b/i;
const NOT_RECEIVED_CUE =
  /\bnot (?:been )?received\b|\bno (?:reply|response)\b|\bnon[- ]?response\b|\bunanswered\b|\bfailed to (?:reply|respond)\b|\bawaited\b|\bpending\b/i;

/**
 * The alternative-procedure branch, ending where it has to end.
 *
 * The last step is the one that was missing: if the alternatives do not close the gap, the
 * limitation is documented rather than quietly absorbed. An unanswered confirmation that leaves no
 * trace is indistinguishable from one that was never sent.
 */
export function buildAlternativeProcedures(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return null;
  if (!CONFIRMATION_CUE.test(value) || !NOT_RECEIVED_CUE.test(value)) return null;
  return {
    steps: [
      "Send the request again, and check it went to a person and an address the counterparty actually uses rather than one supplied only by the client.",
      "Examine subsequent cash: receipts or payments after the reporting date that settle the same balance are often better evidence than the confirmation would have been.",
      "Inspect the underlying documents - the invoice, the delivery evidence, the contract and the account statement - and agree them to the balance.",
      "Test the reconciling items between the counterparty's records and the client's, where any part of the counterparty's records is available.",
      "Assess whether what the alternatives establish is sufficient for this balance, and say which assertion remains uncovered if it is not.",
      "If the gap remains, document the limitation and its amount. An unanswered confirmation that leaves no trace is indistinguishable from one that was never sent.",
    ],
  };
}
