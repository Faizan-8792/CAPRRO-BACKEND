// Deterministic materiality guidance built from what the document actually states.
//
// AA-07 in .kiro/audit-assistance-defects.md. Given profit before tax, revenue, total assets and an
// explicit instruction not to invent a percentage, the product still answered "Determine
// materiality and performance materiality for this area and document the basis for sample size and
// item selection." That sentence would be identical on a blank page. It tells an auditor to do the
// thing they already know they must do, and says nothing about the figures sitting in front of both
// of them.
//
// WHAT IS PRESERVED
// extractStatedMateriality in the controller already finds a materiality figure the working paper
// states for itself, deterministically, and when it finds one the response already says something
// specific. That path is untouched. This module replaces only the OTHER branch - the placeholder
// that shipped when no figure was stated.
//
// THE ONE THING IT MUST NEVER DO
// Name a percentage. Not "5% of profit before tax", not "0.5% to 2% of revenue", not a range.
// Choosing a benchmark and a percentage is a judgement that depends on the entity, the users of the
// accounts, prior-year misstatements and the engagement partner - none of which is in a pasted
// working paper. A number invented here would be copied into a file and relied on, and it would be
// wrong for reasons nobody could see. So the module lists the BASES the document supplies, says
// what makes each one more or less suitable, and names precisely what is still missing before
// anyone can set a figure. A committed test asserts no percentage ever appears in its output.

import { extractRupeeAmounts } from "./audit-numerical-integrity.service.js";

/** How far before an amount a benchmark label may sit and still be describing it. */
const MAX_LABEL_DISTANCE_CHARS = 60;

/**
 * The benchmarks a materiality figure is conventionally set against, each with the reason it is or
 * is not a stable choice. The `note` is about the BENCHMARK's suitability, never about a rate.
 */
const BENCHMARKS = [
  {
    id: "profit-before-tax",
    label: "profit before tax",
    pattern: /\b(?:profit|loss)\s+before\s+tax(?:ation)?\b|\bPBT\b|\bprofit\s+before\s+taxation\b/i,
    note:
      "the usual starting point for a profit-oriented entity, because the users of the accounts " +
      "are usually most interested in earnings. It becomes an unstable base when profit is close " +
      "to breakeven or swings between years, since a small movement then changes the threshold a " +
      "great deal",
  },
  {
    id: "revenue",
    label: "revenue",
    pattern: /\b(?:revenue|turnover|sales)\b(?!\s+(?:tax|ledger|register))/i,
    note:
      "a steadier base than profit for an entity whose earnings are volatile or near breakeven, " +
      "and the more usual choice for a not-for-profit or a business measured on scale of activity",
  },
  {
    id: "total-assets",
    label: "total assets",
    pattern: /\btotal\s+assets\b|\bbalance\s+sheet\s+total\b|\bgross\s+assets\b/i,
    note:
      "usually preferred for an asset-holding entity - an investment company, a fund, a property " +
      "holding business - where the balance sheet rather than the income statement is what the " +
      "users of the accounts look at",
  },
  {
    id: "gross-profit",
    label: "gross profit",
    pattern: /\bgross\s+profit\b|\bgross\s+margin\b/i,
    note:
      "sometimes used where the entity's cost base is largely pass-through, so that revenue " +
      "overstates the scale of the business the entity actually controls",
  },
  {
    id: "net-assets",
    label: "net assets",
    pattern: /\bnet\s+(?:assets|worth)\b|\bshareholders?'?\s+(?:funds|equity)\b|\btotal\s+equity\b/i,
    note:
      "relevant where solvency or a capital requirement is what the users of the accounts are " +
      "testing the entity against",
  },
  {
    id: "total-expenses",
    label: "total expenditure",
    pattern: /\btotal\s+(?:expenses|expenditure|costs)\b/i,
    note:
      "the conventional base for an entity that does not exist to make a profit, such as a trust " +
      "or a society, where expenditure is the measure of activity",
  },
];

/**
 * Inputs that a materiality figure needs and that a pasted working paper rarely contains. Naming
 * them precisely is the difference between "determine materiality" and a next action somebody can
 * actually carry out.
 */
const REQUIRED_INPUTS = [
  {
    id: "benchmark-choice",
    text: "which benchmark the engagement has chosen for this entity, and why that one",
    satisfied: (bases) => bases.length === 1,
  },
  {
    id: "prior-year",
    text: "the prior-year figure for the chosen benchmark, to show whether it is stable enough to use",
    satisfied: (_bases, text) =>
      /\b(?:prior|previous|last|comparative|preceding)\s+(?:year|period)\b/i.test(text),
  },
  {
    id: "performance-materiality",
    text:
      "performance materiality, which is a separate and lower figure than overall materiality and " +
      "is the one that actually drives sample sizes",
    satisfied: (_bases, text) => /\bperformance\s+materiality\b/i.test(text),
  },
  {
    id: "trivial-threshold",
    text:
      "the threshold below which a misstatement is clearly trivial and need not be accumulated",
    satisfied: (_bases, text) =>
      /\b(?:clearly\s+trivial|trivial\s+threshold|de\s*minimis)\b/i.test(text),
  },
  {
    id: "user-profile",
    text:
      "who relies on these accounts - a lender testing a covenant, a regulator, or an owner-manager " +
      "- since that is what makes one benchmark more appropriate than another",
    satisfied: (_bases, text) =>
      /\b(?:lender|bank|covenant|regulator|shareholders?|investors?|users?\s+of\s+the\s+(?:accounts|financial\s+statements))\b/i.test(
        text,
      ),
  },
];

/** Formats integer paise as a readable rupee amount, matching the style used elsewhere. */
function formatPaise(paise) {
  const rupees = paise / 100;
  if (rupees >= 10000000) return `Rs ${(rupees / 10000000).toFixed(2)} crore`;
  if (rupees >= 100000) return `Rs ${(rupees / 100000).toFixed(2)} lakh`;
  return `Rs ${rupees.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * The quantitative bases this document actually supplies, each with its figure.
 *
 * A benchmark counts only when a monetary amount sits close enough after its label to be that
 * label's figure. "Revenue recognition was tested" names revenue but supplies no base, and offering
 * it as one would be the same emptiness the placeholder had.
 */
export function extractMaterialityBases(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const amounts = extractRupeeAmounts(text);
  if (amounts.length === 0) return [];

  const found = [];
  for (const benchmark of BENCHMARKS) {
    const match = benchmark.pattern.exec(text);
    if (!match) continue;

    const labelEnd = (match.index ?? 0) + match[0].length;
    // The nearest amount that follows the label closely enough to belong to it.
    const amount = amounts.find(
      (item) => item.index >= labelEnd && item.index - labelEnd <= MAX_LABEL_DISTANCE_CHARS,
    );
    if (!amount) continue;

    found.push({
      id: benchmark.id,
      label: benchmark.label,
      note: benchmark.note,
      amountMinor: amount.paise,
      formatted: formatPaise(amount.paise),
      quote: text.slice(match.index ?? 0, amount.index + amount.raw.length).replace(/\s+/g, " "),
    });
  }
  return found;
}

/** Which of the required inputs this document does not supply. */
export function findMissingMaterialityInputs(text, bases) {
  const safe = typeof text === "string" ? text : "";
  return REQUIRED_INPUTS.filter((input) => !input.satisfied(bases ?? [], safe));
}

/**
 * The materiality guidance for a document that does NOT state a materiality figure.
 *
 * Returns null when the document supplies nothing to work with, so the caller keeps its existing
 * wording rather than this module inventing a reason to speak.
 */
export function buildMaterialityGuidance(text) {
  const bases = extractMaterialityBases(text);
  const missing = findMissingMaterialityInputs(text, bases);

  if (bases.length === 0) return null;

  const listed = bases
    .map((base) => `${base.label} at ${base.formatted}`)
    .join("; ");

  const considerations = bases
    .map((base) => `${base.label} is ${base.note}`)
    .join(". ");

  const stillNeeded = missing.map((input) => input.text);

  return {
    detail:
      `This text supplies ${bases.length} quantitative base${bases.length === 1 ? "" : "s"} a ` +
      `materiality figure could be set against: ${listed}. ` +
      `Which one is appropriate depends on the entity and on who reads its accounts - ` +
      `${considerations}. ` +
      (stillNeeded.length > 0
        ? `No figure can be set from this text alone, because it does not state ${stillNeeded[0]}` +
          (stillNeeded.length > 1 ? `, and ${stillNeeded.length - 1} further input${stillNeeded.length - 1 === 1 ? "" : "s"} listed in the next step` : "") +
          "."
        : "Record the chosen benchmark and the resulting figures in the working paper."),
    nextAction:
      stillNeeded.length > 0
        ? `Record, before testing any item: ${stillNeeded.join("; ")}.`
        : "Record the chosen benchmark and the resulting overall and performance materiality figures before testing any item.",
    bases,
    missing: missing.map((input) => input.id),
  };
}
