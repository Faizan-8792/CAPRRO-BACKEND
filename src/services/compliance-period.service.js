import ComplianceRule from "../models/ComplianceRule.js";

function periodError(message) {
  const error = new Error(message);
  error.code = "INVALID_COMPLIANCE_PERIOD";
  return error;
}

function endOfUtcDay(date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
}

function exactUtcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw periodError("Period contains an invalid date");
  }
  return date;
}

export function parseCompliancePeriod(period, frequency) {
  const normalizedPeriod = String(period || "").trim().toUpperCase();
  const normalizedFrequency = String(frequency || "").trim().toUpperCase();
  let match;

  if (normalizedFrequency === "MONTHLY") {
    match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(normalizedPeriod);
    if (!match) throw periodError("Monthly periods must use YYYY-MM");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const start = exactUtcDate(year, month, 1);
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    return { period: normalizedPeriod, start, end };
  }

  if (normalizedFrequency === "QUARTERLY") {
    match = /^(\d{4})-Q([1-4])$/.exec(normalizedPeriod);
    if (!match) throw periodError("Quarterly periods must use YYYY-Q1 through YYYY-Q4");
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const startMonth = (quarter - 1) * 3;
    const start = exactUtcDate(year, startMonth + 1, 1);
    const endMonth = startMonth + 3;
    const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    const end = endOfUtcDay(exactUtcDate(year, endMonth, endDay));
    return { period: normalizedPeriod, start, end };
  }

  if (normalizedFrequency === "ANNUAL") {
    match = /^(\d{4})$/.exec(normalizedPeriod);
    if (match) {
      const year = Number(match[1]);
      return {
        period: normalizedPeriod,
        start: exactUtcDate(year, 1, 1),
        end: endOfUtcDay(exactUtcDate(year, 12, 31)),
      };
    }

    match = /^(\d{4})-(\d{2}|\d{4})$/.exec(normalizedPeriod);
    if (!match) {
      throw periodError("Annual periods must use YYYY, YYYY-YY, or YYYY-YYYY");
    }
    const startYear = Number(match[1]);
    const expectedEndYear = startYear + 1;
    const suppliedEndYear =
      match[2].length === 2
        ? Number(`${String(expectedEndYear).slice(0, 2)}${match[2]}`)
        : Number(match[2]);
    if (suppliedEndYear !== expectedEndYear) {
      throw periodError("Fiscal-year period end must follow its start year");
    }
    return {
      period: `${startYear}-${String(expectedEndYear).slice(-2)}`,
      start: exactUtcDate(startYear, 4, 1),
      end: endOfUtcDay(exactUtcDate(expectedEndYear, 3, 31)),
    };
  }

  if (normalizedFrequency === "EVENT_DRIVEN") {
    match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(
      normalizedPeriod
    );
    if (!match) throw periodError("Event-driven periods must use YYYY-MM-DD");
    const start = exactUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return { period: normalizedPeriod, start, end: endOfUtcDay(start) };
  }

  throw periodError(`Unsupported compliance frequency: ${normalizedFrequency}`);
}

export function ruleAppliesToPeriod(rule, periodWindow) {
  const effectiveFrom = new Date(rule.effectiveFrom);
  const effectiveTo = rule.effectiveTo ? new Date(rule.effectiveTo) : null;
  return (
    effectiveFrom <= periodWindow.end &&
    (!effectiveTo || effectiveTo >= periodWindow.start)
  );
}

export function selectApplicableComplianceRule({
  firmId,
  code,
  period,
  candidates = [],
}) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const applicable = [];

  for (const rule of candidates) {
    if (String(rule.code || "").toUpperCase() !== normalizedCode) continue;
    try {
      const periodWindow = parseCompliancePeriod(period, rule.frequency);
      if (ruleAppliesToPeriod(rule, periodWindow)) {
        applicable.push({ rule, periodWindow });
      }
    } catch (error) {
      if (error.code !== "INVALID_COMPLIANCE_PERIOD") throw error;
    }
  }

  const firmIdString = String(firmId);
  applicable.sort((left, right) => {
    const leftIsFirmRule = String(left.rule.firmId || "") === firmIdString;
    const rightIsFirmRule = String(right.rule.firmId || "") === firmIdString;
    if (leftIsFirmRule !== rightIsFirmRule) return leftIsFirmRule ? -1 : 1;
    return right.rule.version - left.rule.version;
  });

  return applicable[0] || null;
}

export async function resolveApplicableComplianceRule({ firmId, code, period }) {
  const candidates = await ComplianceRule.find({
    firmId: { $in: [null, firmId] },
    code,
    status: "ACTIVE",
    reviewedBy: { $ne: null },
    reviewedAt: { $ne: null },
    sourceReference: { $nin: [null, ""] },
  }).lean();

  return selectApplicableComplianceRule({
    firmId,
    code,
    period,
    candidates,
  });
}
