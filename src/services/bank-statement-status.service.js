// Deterministic status and exception primitives for the bank-statement converter.
// Status is calculated from validation evidence; callers cannot assign Passed by hand.

import { createHash } from "node:crypto";

export const BANK_STATEMENT_STATUS = Object.freeze({
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  PASSED_WITH_WARNINGS: "PASSED_WITH_WARNINGS",
  PASSED: "PASSED",
});

export const BANK_STATEMENT_PROFILE_STATE = Object.freeze({
  DRAFT: "DRAFT",
  REVIEW_ONLY: "REVIEW_ONLY",
  APPROVED: "APPROVED",
  SUSPENDED: "SUSPENDED",
});

export const BANK_STATEMENT_STATUS_CODES = Object.freeze({
  LAYOUT: "W-LAYOUT",
  NO_CHECK: "W-NOCHECK",
  USER_EDIT: "W-USER-EDIT",
});

function severityFor(code) {
  if (String(code).startsWith("E-")) return "ERROR";
  if (String(code).startsWith("W-")) return "WARNING";
  return "INFO";
}

function stablePart(value) {
  return String(value ?? "").trim();
}

/** Creates a repeatable exception identity without embedding statement text in the identifier. */
export function createBankStatementException({ fileHash, page, position, code }) {
  const source = [stablePart(fileHash), stablePart(page), stablePart(position), stablePart(code)].join("|");
  return {
    id: createHash("sha256").update(source).digest("hex").slice(0, 24),
    severity: severityFor(code),
    code: stablePart(code),
    page: page ?? null,
    position: position ?? null,
  };
}

function hasPassedCheck(checks, id) {
  return checks.some((check) => check.id === id && check.result === "PASS");
}

function hasPassedStatementControl(checks) {
  return checks.some((check) => (
    ["V-C1", "V-C2", "V-C3", "V-C4", "V-C5", "V-C6"].includes(check.id) && check.result === "PASS"
  ));
}

/**
 * Calculates the only permitted outcome from validation and review evidence.
 * A resolved reviewer value is not a pass on its own: callers must re-run checks with the current
 * values, then supply that fresh result here. This is what keeps a reviewer click from clearing an
 * arithmetic defect merely by fiat.
 */
export function calculateBankStatementStatus({
  intakeRejected = false,
  profileState = BANK_STATEMENT_PROFILE_STATE.DRAFT,
  checks = [],
  exceptions = [],
  reviewerEdits = false,
} = {}) {
  if (intakeRejected) {
    return { status: BANK_STATEMENT_STATUS.REJECTED, warnings: [], errorCount: 0, warningCount: 0, infoCount: 0 };
  }

  const activeExceptions = exceptions.filter((exception) => !exception.resolved);
  const failedChecks = checks.filter((check) => check.result === "FAIL");
  const hasError = failedChecks.length > 0 || activeExceptions.some((exception) => exception.severity === "ERROR");
  const warnings = new Map();
  for (const exception of activeExceptions.filter((exception) => exception.severity === "WARNING")) {
    warnings.set(exception.code, exception);
  }
  if (profileState !== BANK_STATEMENT_PROFILE_STATE.APPROVED) {
    warnings.set(BANK_STATEMENT_STATUS_CODES.LAYOUT, { code: BANK_STATEMENT_STATUS_CODES.LAYOUT, severity: "WARNING" });
  }
  if (!hasPassedCheck(checks, "V-B1") || !hasPassedStatementControl(checks)) {
    warnings.set(BANK_STATEMENT_STATUS_CODES.NO_CHECK, { code: BANK_STATEMENT_STATUS_CODES.NO_CHECK, severity: "WARNING" });
  }
  if (reviewerEdits) {
    warnings.set(BANK_STATEMENT_STATUS_CODES.USER_EDIT, { code: BANK_STATEMENT_STATUS_CODES.USER_EDIT, severity: "WARNING" });
  }

  const errorCount = failedChecks.length + activeExceptions.filter((exception) => exception.severity === "ERROR").length;
  const warningCount = warnings.size;
  const infoCount = activeExceptions.filter((exception) => exception.severity === "INFO").length;
  if (hasError) {
    return { status: BANK_STATEMENT_STATUS.FAILED, warnings: [...warnings.values()], errorCount, warningCount, infoCount };
  }
  if (warningCount) {
    return { status: BANK_STATEMENT_STATUS.PASSED_WITH_WARNINGS, warnings: [...warnings.values()], errorCount, warningCount, infoCount };
  }
  return { status: BANK_STATEMENT_STATUS.PASSED, warnings: [], errorCount, warningCount: 0, infoCount };
}

export function exportStatusToken(status) {
  const tokens = {
    [BANK_STATEMENT_STATUS.REJECTED]: "REJECTED",
    [BANK_STATEMENT_STATUS.FAILED]: "FAILED_DRAFT",
    [BANK_STATEMENT_STATUS.PASSED_WITH_WARNINGS]: "PassedWithWarnings",
    [BANK_STATEMENT_STATUS.PASSED]: "Passed",
  };
  if (!tokens[status]) throw new Error(`Unsupported bank-statement status: ${status}`);
  return tokens[status];
}
