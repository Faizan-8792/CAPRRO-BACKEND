// Versioned, declarative layout profiles. There are intentionally no bank profiles in source yet:
// an unproved profile would make a financial claim the team cannot support. This validator is the
// gate any Finance-approved profile must pass before it is eligible for detection.

export const BANK_STATEMENT_ACCOUNT_TYPES = Object.freeze(["SAVINGS", "CURRENT", "OD", "CC"]);
export const BANK_STATEMENT_AMOUNT_SHAPES = Object.freeze(["SEPARATE_DEBIT_CREDIT", "AMOUNT_WITH_DR_CR", "SIGNED_AMOUNT", "AMOUNT_WITH_TYPE"]);
export const BANK_STATEMENT_PROFILE_STATES = Object.freeze(["DRAFT", "REVIEW_ONLY", "APPROVED", "SUSPENDED"]);

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
}

/** Returns human-readable configuration errors; callers must refuse an invalid profile. */
export function validateBankStatementLayoutProfile(profile) {
  const errors = [];
  if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(String(profile?.id ?? ""))) errors.push("Profile id must be an uppercase stable identifier.");
  if (!/^\d+(?:\.\d+){0,2}$/.test(String(profile?.version ?? ""))) errors.push("Profile version must be a numeric dotted version.");
  if (!String(profile?.bank ?? "").trim()) errors.push("Profile bank is required.");
  if (!BANK_STATEMENT_PROFILE_STATES.includes(profile?.state)) errors.push("Profile state is invalid.");
  if (!Array.isArray(profile?.accountTypes) || !profile.accountTypes.length || profile.accountTypes.some((type) => !BANK_STATEMENT_ACCOUNT_TYPES.includes(type))) errors.push("Profile must declare supported account types.");
  if (!BANK_STATEMENT_AMOUNT_SHAPES.includes(profile?.amountShape)) errors.push("Profile amount shape is invalid.");
  if (!uniqueStrings(profile?.fingerprint?.requiredText).length) errors.push("Profile fingerprint needs at least one required text marker.");
  if (!uniqueStrings(profile?.fingerprint?.headers).length) errors.push("Profile fingerprint needs at least one required column header.");
  if (!Array.isArray(profile?.columns) || !profile.columns.length) errors.push("Profile must declare column positions.");
  for (const column of profile?.columns || []) {
    if (!String(column?.field ?? "").trim() || !Number.isFinite(column?.minX) || !Number.isFinite(column?.maxX) || column.minX >= column.maxX) {
      errors.push("Every profile column needs a field and increasing numeric minX/maxX bounds.");
      break;
    }
  }
  if (!uniqueStrings(profile?.dateFormats).length) errors.push("Profile must declare allowed date formats.");
  if (!["SPACE", "NONE"].includes(profile?.narrationJoin)) errors.push("Profile narrationJoin must be SPACE or NONE.");
  if (!String(profile?.balanceConvention ?? "").trim()) errors.push("Profile balance convention is required.");
  if (!["ASCENDING", "DESCENDING", "DAY_END", "NONE"].includes(profile?.balancePattern)) errors.push("Profile balance pattern is invalid.");
  return errors;
}

function pageText(pages) {
  return (pages || []).flatMap((page) => page.items || []).map((item) => item.text).join(" ").toLocaleLowerCase("en-IN");
}

/**
 * Detects only profiles whose complete declared fingerprint matches. A partial match is not a
 * fallback parser: it remains unrecognised and can become review-only only after the owner’s D-02
 * decision and profile evidence are available.
 */
export function detectBankStatementLayoutProfile({ profiles = [], pages = [] } = {}) {
  const text = pageText(pages);
  const eligible = profiles
    .map((profile) => ({ profile, errors: validateBankStatementLayoutProfile(profile) }))
    .filter((entry) => entry.errors.length === 0)
    .filter((entry) => entry.profile.state !== "SUSPENDED")
    .filter((entry) => {
      const fingerprint = entry.profile.fingerprint;
      const required = [...uniqueStrings(fingerprint.requiredText), ...uniqueStrings(fingerprint.headers)];
      return required.every((marker) => text.includes(marker.toLocaleLowerCase("en-IN")));
    })
    .sort((left, right) => `${left.profile.id}@${left.profile.version}`.localeCompare(`${right.profile.id}@${right.profile.version}`));
  if (eligible.length !== 1) {
    return { profile: null, reason: eligible.length ? "AMBIGUOUS" : "UNRECOGNISED", candidates: eligible.map((entry) => entry.profile.id) };
  }
  return { profile: eligible[0].profile, reason: "MATCHED", candidates: [eligible[0].profile.id] };
}
