// Stratification, and the fact that findings are not independent of each other.
//
// AA-11, AA-12 and AA-18 in .kiro/audit-assistance-defects.md.
//
//   AA-11/12  "Select a sample" for a population the text has already divided for you. Where the
//             document identifies sub-populations - March, the last six days, manual entries,
//             related-party ones - each stratum carries a different risk and deserves a different
//             approach. Sampling the whole thing uniformly tests the boring part hardest.
//   AA-18     A covenant breach in one section and a going-concern paragraph in another are the
//             same problem seen twice. Presented as independent cards, the reader has to notice
//             the connection themselves, and the whole value of reading the document at once is
//             that the tool should not need them to.

// ── AA-11 / AA-12: the population is already divided ───────────────────────

/**
 * Dimensions along which an audit population is commonly split, each with the reason that stratum
 * carries different risk. The reason matters: a stratum without one is a filter, not a strategy.
 */
const STRATIFICATION_DIMENSIONS = [
  {
    id: "period-end-timing",
    pattern: /\blast (?:six|seven|ten|few) days\b|\bfinal week\b|\b3[01] March\b|\bat the year[- ]?end\b|\bperiod[- ]?end\b/i,
    stratum: "entries posted in the final days of the period",
    why: "cut-off error and deliberate manipulation both concentrate here, and the window is small enough to test in full",
    approach: "test every item in the window rather than sampling it",
  },
  {
    id: "manual-entries",
    pattern: /\bmanual (?:journal|entr)\w*|\btop[- ]?side\b|\badjusting entr\w*/i,
    stratum: "manual journal entries",
    why: "they bypass the controls that make system-generated entries reliable",
    approach: "test all of them, or state the criteria used to select from them and why those criteria",
  },
  {
    id: "related-party",
    pattern: /\brelated part\w*|\bdirector'?s?\b|\bgroup compan\w*|\bassociate\b/i,
    stratum: "transactions with related parties",
    why: "the terms cannot be assumed to be arm's length, so the usual reasonableness test does not apply",
    approach: "test each one against an external comparator rather than against internal consistency",
  },
  {
    id: "unusual-terms",
    pattern: /\bunusual terms?\b|\bnon[- ]standard\b|\bsale and repurchase\b|\bside letter\b|\bconsignment\b/i,
    stratum: "transactions on non-standard terms",
    why: "the substance may differ from the form, which no amount of vouching to the invoice will reveal",
    approach: "read the underlying agreement in full for each, rather than testing the ledger entry",
  },
  {
    id: "credit-notes",
    pattern: /\bcredit notes?\b|\breturns?\b|\breversal\w*/i,
    stratum: "credit notes and reversals, especially those raised after the period end",
    why: "a reversal after the period end can undo revenue that was recognised before it",
    approach: "trace each back to the original invoice and the reason for the reversal",
  },
  {
    id: "high-value",
    pattern: /\babove Rs\b|\bexceeding Rs\b|\blarge(?:st)? (?:items?|balances?|transactions?)\b|\bkey items?\b/i,
    stratum: "individually significant items",
    why: "each one can matter on its own, so leaving them to chance in a sample wastes the sample",
    approach: "test all items above the threshold, and sample only what remains below it",
  },
  {
    id: "new-counterparties",
    pattern: /\bnew (?:customers?|suppliers?|vendors?)\b|\bfirst[- ]time\b|\brecently (?:added|onboarded)\b/i,
    stratum: "counterparties added during the period",
    why: "there is no history to compare against, and a fictitious counterparty is necessarily a new one",
    approach: "verify existence independently of the client's own master data",
  },
];

/**
 * The strata a document's own wording identifies.
 *
 * Returns an empty list when the text names no sub-population. Inventing strata would be worse than
 * offering none: it would tell an auditor the population divides in a way the document never said.
 */
export function findStrata(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return [];
  return STRATIFICATION_DIMENSIONS.filter((d) => d.pattern.test(value)).map((d) => ({
    id: d.id,
    stratum: d.stratum,
    why: d.why,
    approach: d.approach,
  }));
}

/**
 * A stratification plan, with the residual population named explicitly.
 *
 * The residual is the part that matters: strata that do not add up to the whole population leave a
 * remainder nobody has decided about, and that remainder is where an untested item hides.
 */
export function buildStratificationPlan(text) {
  const strata = findStrata(text);
  if (strata.length === 0) return null;
  return {
    strata,
    residual:
      "Everything not falling in a stratum above. Decide and record how that remainder is tested - it is where an item nobody chose to look at would sit.",
    note:
      strata.length === 1
        ? "One sub-population is identifiable from this text. Sampling the rest uniformly is defensible only once it is separated from this one."
        : `${strata.length} sub-populations are identifiable from this text, each carrying different risk. A single uniform sample across all of them tests the least risky part hardest.`,
  };
}

// ── AA-18: findings that are the same problem seen twice ───────────────────

/**
 * Pairs of subjects that are causally connected in an audit, with the direction stated.
 *
 * The direction matters. A covenant breach raises going-concern doubt; going-concern doubt does not
 * cause a covenant breach. A link that does not say which way it runs is a hint, not a finding.
 */
const LINKAGE_RULES = [
  {
    id: "covenant-to-going-concern",
    from: /\bcovenant\b|\bnet debt to EBITDA\b|\bborrowing base\b|\bratio (?:test|breach)\b/i,
    to: /\bgoing concern\b|\brefinanc\w*|\bfacility renewal\b|\bliquidit\w*/i,
    because:
      "A breached or nearly-breached covenant can make borrowings repayable on demand, which is a going-concern question rather than a disclosure one.",
    then: "Establish whether a waiver exists in writing and whether it was obtained before the reporting date.",
  },
  {
    id: "customer-loss-to-recoverability",
    from: /\bdistributor\b|\bmajor customer\b|\bkey customer\b|\border book\b|\blost (?:a )?contract\b/i,
    to: /\breceivable\w*|\brecoverab\w*|\bECL\b|\bexpected credit loss\b|\bimpair\w*|\bforecast\b/i,
    because:
      "A customer reducing or ending its commitment bears directly on whether amounts already owed by it are recoverable, and on the forecast any impairment test relies upon.",
    then: "Re-run the recoverability assessment using the reduced commitment rather than the historical run rate.",
  },
  {
    id: "control-weakness-to-fraud-risk",
    from: /\bno segregation\b|\bsame person\b|\bno (?:independent )?review\b|\bcontrol\w* (?:was|were) not\b/i,
    to: /\bfraud\b|\boverride\b|\bmisappropriat\w*|\bunauthoris\w*|\bunauthoriz\w*/i,
    because:
      "A control weakness is the opportunity leg of a fraud risk; the two findings describe one exposure from two directions.",
    then: "Assess them together rather than separately, and say whether the weakness is the opportunity the fraud risk relies on.",
  },
  {
    id: "refusal-to-scope",
    from: /\brefus\w+|\bdeclin\w+|\bwithheld\b|\bdenied access\b|\bnot (?:made )?available\b/i,
    to: /\bsufficient\w*|\bscope\b|\bevidence\b|\blimitation\b/i,
    because:
      "A refusal is not only a fact about one balance; it bears on whether the evidence for the area as a whole is sufficient.",
    then: "Carry the refusal into the sufficiency assessment for the whole area, not just the item it concerned.",
  },
  {
    id: "statutory-dues-to-going-concern",
    from: /\bstatutory dues?\b|\bTDS\b|\bGST\b|\bprovident fund\b/i,
    to: /\bgoing concern\b|\bliquidit\w*|\bcash flow\b|\bworking capital\b/i,
    because:
      "Statutory dues left unpaid are usually a symptom of cash pressure rather than an oversight, which is a going-concern indicator as well as a compliance one.",
    then: "Ask why they were not paid, rather than only when they will be.",
  },
  {
    id: "estimate-to-management-bias",
    from: /\bprovision\b|\bestimat\w*|\bimpair\w*|\bfair value\b|\buseful (?:life|lives)\b/i,
    to: /\bbonus\b|\btarget\b|\bcovenant\b|\bforecast\b|\bremuneration\b/i,
    because:
      "An estimate whose outcome affects a bonus, a target or a covenant is an estimate with a direction someone would prefer it to take.",
    then: "Evaluate the estimate's assumptions against that incentive explicitly, rather than only against the data.",
  },
];

/** Normalises a finding into the text its links are computed from. */
const subjectOf = (finding) =>
  [finding?.title, finding?.detail, finding?.evidence, finding?.why]
    .filter((p) => typeof p === "string")
    .join(" ");

/**
 * Links between findings, computed across the whole list.
 *
 * A link is only reported between DIFFERENT findings: one finding that mentions both a covenant and
 * going concern is already whole, and linking it to itself would be noise. Each link states the
 * direction, the reason, and what to do about the pair - a link that says only "these are related"
 * leaves the reader exactly where they started.
 */
export function findCrossIssueLinks(findings) {
  const list = Array.isArray(findings) ? findings : [];
  // No `list.length < 2` fast path. It looked like a guard and guaranteed nothing: the
  // different-findings check below already makes a single-item list produce no links, so the early
  // return could be deleted without changing any behaviour - a mutation proved exactly that.
  // Standing rule 9: delete dead logic rather than prop it up with a test that cannot fail.
  const subjects = list.map((f, index) => ({ index, title: f?.title ?? null, text: subjectOf(f) }));
  const links = [];
  const seen = new Set();

  for (const rule of LINKAGE_RULES) {
    for (const a of subjects) {
      if (!rule.from.test(a.text)) continue;
      for (const b of subjects) {
        if (a.index === b.index) continue;
        if (!rule.to.test(b.text)) continue;

        // One link per rule per unordered pair: the same connection found from both ends is one
        // connection, not two.
        const key = `${rule.id}:${Math.min(a.index, b.index)}:${Math.max(a.index, b.index)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        links.push({
          id: rule.id,
          fromIndex: a.index,
          toIndex: b.index,
          fromTitle: a.title,
          toTitle: b.title,
          because: rule.because,
          then: rule.then,
        });
      }
    }
  }
  return links;
}
