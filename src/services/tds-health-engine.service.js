import { createHash } from "node:crypto";
import { PAN_PATTERN, addSafeMinorUnits } from "./tds-normalization.service.js";

const HEALTH_RULE_VERSION = "tds-health-v1-no-rate-engine";
const HEALTH_SOURCE_REFERENCE =
  "Arithmetic comparison of normalized user-imported minor-unit amounts. No statutory rate, threshold, interest, fee, liability, or due-date rule is applied.";

const CHECK_META = Object.freeze({
  RETURN_NOT_FILED: ["STATEMENT", "ERROR", "Quarterly statement is not recorded as filed", "Confirm filing status and create a filing or correction task."],
  RETURN_DUE_SOON: ["STATEMENT", "WARNING", "Statement deadline is approaching", "Confirm the reviewed deadline rule and assign filing work."],
  DEPOSIT_MISSING: ["DEPOSIT", "ERROR", "No mapped ITNS 281 deposit found", "Review ITNS 281 evidence and map or create deposit follow-up."],
  SHORT_DEPOSIT_ESTIMATE: ["DEPOSIT", "ERROR", "Potential short deposit", "Review mapped deductions and ITNS 281 challans; professional confirmation is required."],
  EXCESS_DEPOSIT_REVIEW: ["DEPOSIT", "WARNING", "Potential excess deposit", "Review challan mapping, section allocation, and carry-forward treatment."],
  CHALLAN_UNMAPPED: ["DEPOSIT", "WARNING", "ITNS 281 challan is not mapped", "Map the challan to a reviewed section or quarter."],
  DEDUCTION_NOT_REPORTED: ["STATEMENT", "ERROR", "Imported deduction is not fully reported", "Review statement rows and prepare correction work if required."],
  REPORTED_NOT_IN_REGISTER: ["STATEMENT", "WARNING", "Reported amount exceeds imported register", "Locate missing register rows or confirm statement correction requirements."],
  PAN_MISSING: ["PAN", "ERROR", "Deductee PAN is missing", "Obtain and review PAN evidence before filing or correction."],
  PAN_FORMAT_INVALID: ["PAN", "ERROR", "Local PAN format check failed", "Correct the PAN or record reviewed evidence. This is not portal verification."],
  PAN_PORTAL_VERIFICATION_PENDING: ["PAN", "WARNING", "Official PAN verification evidence is not recorded", "A user must record an official portal result, source, actor, and time manually."],
  CREDIT_MISSING_IN_IMPORTED_26AS: ["CREDIT", "WARNING", "Credit is missing in imported 26AS/TRACES evidence", "Review optional imported evidence and follow up on unmatched credit."],
  CORRECTION_REQUIRED: ["STATEMENT", "ERROR", "Correction statement follow-up is required", "Create a correction checklist and preserve the original run."],
  CERTIFICATE_PENDING: ["CERTIFICATE", "WARNING", "Form 16/16A issue is pending or not tracked", "Create certificate generation and issue follow-up."],
  NEEDS_PROFESSIONAL_REVIEW: ["DEDUCTION", "WARNING", "Professional review is required", "Review source rows; no rate, threshold, or liability is inferred."],
});

function nonBlank(value) {
  return String(value || "").trim();
}

function rowId(row) {
  return String(row?._id || row?.id || "");
}

function sourceRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    const id = rowId(row);
    if (!id || unique.has(id)) continue;
    unique.set(id, {
      rowId: row._id || row.id,
      batchId: row.batchId,
      kind: row.kind,
      sourceRow: row.sourceRow,
      label: row.sourceLabel,
    });
  }
  return [...unique.values()];
}

function checkKey(status, identity) {
  const digest = createHash("sha256").update(`${status}|${identity}`).digest("hex").slice(0, 32);
  return `${status}:${digest}`;
}

function calculation(sourceLabel = "User-imported TDS records") {
  return {
    estimate: true,
    ruleVersion: HEALTH_RULE_VERSION,
    sourceLabel,
    sourceReference: HEALTH_SOURCE_REFERENCE,
    professionalConfirmed: false,
  };
}

function makeCheck({
  status,
  identity,
  rows,
  deducteePan = "",
  sectionCode = "",
  expectedMinor = 0,
  actualMinor = 0,
  differenceMinor = expectedMinor - actualMinor,
  explanation,
  sourceLabel,
  dimension = null,
}) {
  const meta = CHECK_META[status];
  if (!meta) throw new Error(`Unsupported TDS health status: ${status}`);
  const refs = sourceRows(rows);
  if (!refs.length) throw new Error(`TDS health check ${status} has no source-row evidence`);
  return {
    itemKey: checkKey(status, identity),
    status,
    dimension: dimension || meta[0],
    severity: meta[1],
    state: "OPEN",
    title: meta[2],
    explanation: explanation || meta[2],
    recommendedAction: meta[3],
    deducteePan,
    sectionCode,
    expectedMinor,
    actualMinor,
    differenceMinor,
    sourceRows: refs,
    calculation: calculation(sourceLabel),
  };
}

function groupBy(rows, keyForRow) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyForRow(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

function sum(rows, valueForRow) {
  return addSafeMinorUnits(rows.map((row) => valueForRow(row)));
}

function deductedTotal(row) {
  return addSafeMinorUnits([
    row.deductedMinor || 0,
    row.surchargeMinor || 0,
    row.cessMinor || 0,
  ]);
}

function createPanChecks(deductions, checks) {
  const validPanRows = [];
  for (const row of deductions) {
    const pan = nonBlank(row.deducteePan).toUpperCase();
    if (!pan) {
      checks.push(makeCheck({
        status: "PAN_MISSING",
        identity: rowId(row),
        rows: [row],
        explanation: `Deduction source row ${row.sourceRow} has no deductee PAN.`,
        sourceLabel: row.sourceLabel,
      }));
    } else if (!PAN_PATTERN.test(pan)) {
      checks.push(makeCheck({
        status: "PAN_FORMAT_INVALID",
        identity: rowId(row),
        rows: [row],
        deducteePan: pan,
        explanation: `PAN ${pan} failed only the local structural format check; no portal verification was performed.`,
        sourceLabel: row.sourceLabel,
      }));
    } else {
      validPanRows.push(row);
    }
  }

  const byPan = groupBy(validPanRows, (row) => row.deducteePan);
  for (const [pan, rows] of byPan) {
    checks.push(makeCheck({
      status: "PAN_PORTAL_VERIFICATION_PENDING",
      identity: pan,
      rows,
      deducteePan: pan,
      explanation: `PAN ${pan} passed a local format check only. No official portal result is recorded.`,
      sourceLabel: "Local PAN format check; not official verification",
    }));
    const names = new Set(rows.map((row) => nonBlank(row.deducteeName).toUpperCase()).filter(Boolean));
    if (names.size > 1) {
      checks.push(makeCheck({
        status: "NEEDS_PROFESSIONAL_REVIEW",
        dimension: "PAN",
        identity: `pan-name:${pan}`,
        rows,
        deducteePan: pan,
        explanation: `PAN ${pan} appears against multiple deductee names in imported rows.`,
        sourceLabel: "User-imported deduction register",
      }));
    }
  }

  const duplicateGroups = groupBy(deductions, (row) => [
    nonBlank(row.deducteePan).toUpperCase(),
    row.transactionDate,
    row.sectionCode,
    row.amountPaidMinor,
    deductedTotal(row),
  ].join("|"));
  for (const [identity, rows] of duplicateGroups) {
    if (rows.length < 2) continue;
    checks.push(makeCheck({
      status: "NEEDS_PROFESSIONAL_REVIEW",
      identity: `duplicate:${identity}`,
      rows,
      deducteePan: rows[0].deducteePan,
      sectionCode: rows[0].sectionCode,
      explanation: `${rows.length} imported deduction rows share PAN, date, section, paid amount, and deducted amount.`,
      sourceLabel: "User-imported deduction register",
    }));
  }
}

function createDepositChecks(deductions, challans, checks) {
  const deductionsBySection = groupBy(
    deductions.filter((row) => nonBlank(row.sectionCode)),
    (row) => row.sectionCode
  );
  const challansBySection = groupBy(
    challans.filter((row) => nonBlank(row.sectionCode)),
    (row) => row.sectionCode
  );

  const missingSectionRows = deductions.filter((row) => !nonBlank(row.sectionCode));
  if (missingSectionRows.length) {
    checks.push(makeCheck({
      status: "NEEDS_PROFESSIONAL_REVIEW",
      identity: "missing-section",
      rows: missingSectionRows,
      explanation: `${missingSectionRows.length} deduction row(s) have no reviewed section. No rate or threshold was inferred.`,
      sourceLabel: "User-imported deduction register",
    }));
  }

  for (const row of challans) {
    const section = nonBlank(row.sectionCode);
    if (!section || !deductionsBySection.has(section)) {
      checks.push(makeCheck({
        status: "CHALLAN_UNMAPPED",
        identity: rowId(row),
        rows: [row],
        sectionCode: section,
        actualMinor: row.depositedMinor || 0,
        differenceMinor: -(row.depositedMinor || 0),
        explanation: `ITNS 281 challan row ${row.sourceRow} is not mapped to a section present in the deduction register.`,
        sourceLabel: "User-imported ITNS 281 challan evidence",
      }));
    }
  }

  for (const [section, deductionRows] of deductionsBySection) {
    const challanRows = challansBySection.get(section) || [];
    const expectedMinor = sum(deductionRows, deductedTotal);
    const actualMinor = sum(challanRows, (row) => row.depositedMinor || 0);
    const evidence = [...deductionRows, ...challanRows];
    if (expectedMinor > 0 && actualMinor === 0) {
      checks.push(makeCheck({
        status: "DEPOSIT_MISSING",
        identity: section,
        rows: evidence,
        sectionCode: section,
        expectedMinor,
        actualMinor,
        explanation: `No section-mapped ITNS 281 deposit was found for ${section}; gap ${expectedMinor} minor units is an Estimate.`,
        sourceLabel: "Deduction register compared with ITNS 281 challan evidence",
      }));
    } else if (expectedMinor > actualMinor) {
      checks.push(makeCheck({
        status: "SHORT_DEPOSIT_ESTIMATE",
        identity: section,
        rows: evidence,
        sectionCode: section,
        expectedMinor,
        actualMinor,
        explanation: `Mapped deductions exceed ITNS 281 deposits for ${section} by ${expectedMinor - actualMinor} minor units. Estimate; professional confirmation required.`,
        sourceLabel: "Deduction register compared with ITNS 281 challan evidence",
      }));
    } else if (actualMinor > expectedMinor) {
      checks.push(makeCheck({
        status: "EXCESS_DEPOSIT_REVIEW",
        identity: section,
        rows: evidence,
        sectionCode: section,
        expectedMinor,
        actualMinor,
        explanation: `ITNS 281 deposits exceed mapped deductions for ${section} by ${actualMinor - expectedMinor} minor units.`,
        sourceLabel: "Deduction register compared with ITNS 281 challan evidence",
      }));
    }
  }
}

function createStatementChecks(deductions, challans, statements, checks) {
  const baseEvidence = statements.length ? statements : [...deductions, ...challans];
  const filed = statements.some((row) => ["FILED", "CORRECTED"].includes(row.filingStatus));
  if (!filed) {
    checks.push(makeCheck({
      status: "RETURN_NOT_FILED",
      identity: "quarter-statement",
      rows: baseEvidence,
      explanation: statements.length
        ? "Imported statement data does not record this quarter as FILED or CORRECTED."
        : "No statement row is available for the imported quarter.",
      sourceLabel: "User-imported quarterly TDS statement data",
    }));
  }

  const correctionRows = statements.filter(
    (row) => row.filingStatus === "CORRECTION_PENDING" || row.correctionStatus === "PENDING"
  );
  if (correctionRows.length) {
    checks.push(makeCheck({
      status: "CORRECTION_REQUIRED",
      identity: "correction-pending",
      rows: correctionRows,
      explanation: `${correctionRows.length} statement row(s) record pending correction work.`,
      sourceLabel: "User-imported correction statement information",
    }));
  }

  const deductedMinor = sum(deductions, deductedTotal);
  const reportedMinor = sum(statements, (row) => row.reportedMinor || 0);
  const comparisonRows = [...deductions, ...statements];
  if (deductedMinor > reportedMinor) {
    checks.push(makeCheck({
      status: "DEDUCTION_NOT_REPORTED",
      identity: "quarter-total",
      rows: comparisonRows,
      expectedMinor: deductedMinor,
      actualMinor: reportedMinor,
      explanation: `Imported deductions exceed imported statement amounts by ${deductedMinor - reportedMinor} minor units.`,
      sourceLabel: "Deduction register compared with user-imported statement data",
    }));
  } else if (reportedMinor > deductedMinor) {
    checks.push(makeCheck({
      status: "REPORTED_NOT_IN_REGISTER",
      identity: "quarter-total",
      rows: comparisonRows,
      expectedMinor: deductedMinor,
      actualMinor: reportedMinor,
      explanation: `Imported statement amounts exceed the deduction register by ${reportedMinor - deductedMinor} minor units.`,
      sourceLabel: "User-imported statement data compared with deduction register",
    }));
  }

  const certificateRows = statements.filter((row) => row.certificateStatus !== "ISSUED");
  if (certificateRows.length) {
    checks.push(makeCheck({
      status: "CERTIFICATE_PENDING",
      identity: "quarter-certificates",
      rows: certificateRows,
      explanation: `${certificateRows.length} statement row(s) do not record Form 16/16A as issued.`,
      sourceLabel: "User-imported certificate tracking state",
    }));
  }
}

function createCreditChecks(statements, credits, checks) {
  if (!credits.length) return;
  const reportedRows = statements.filter((row) => (row.reportedMinor || 0) > 0);
  const canCompareByPan = reportedRows.length > 0 && reportedRows.every((row) => PAN_PATTERN.test(nonBlank(row.deducteePan)));
  if (!canCompareByPan) {
    const reportedMinor = sum(statements, (row) => row.reportedMinor || 0);
    const creditedMinor = sum(credits, (row) => row.creditedMinor || 0);
    if (reportedMinor > creditedMinor) {
      checks.push(makeCheck({
        status: "CREDIT_MISSING_IN_IMPORTED_26AS",
        identity: "quarter-total",
        rows: [...statements, ...credits],
        expectedMinor: reportedMinor,
        actualMinor: creditedMinor,
        explanation: `Imported statement amount exceeds optional imported 26AS/TRACES credit by ${reportedMinor - creditedMinor} minor units.`,
        sourceLabel: "Optional user-imported 26AS/TRACES evidence",
      }));
    }
    return;
  }

  const statementsByPan = groupBy(reportedRows, (row) => row.deducteePan);
  const creditsByPan = groupBy(credits.filter((row) => PAN_PATTERN.test(nonBlank(row.deducteePan))), (row) => row.deducteePan);
  for (const [pan, rows] of statementsByPan) {
    const creditRows = creditsByPan.get(pan) || [];
    const reportedMinor = sum(rows, (row) => row.reportedMinor || 0);
    const creditedMinor = sum(creditRows, (row) => row.creditedMinor || 0);
    if (reportedMinor > creditedMinor) {
      checks.push(makeCheck({
        status: "CREDIT_MISSING_IN_IMPORTED_26AS",
        identity: pan,
        rows: [...rows, ...creditRows],
        deducteePan: pan,
        expectedMinor: reportedMinor,
        actualMinor: creditedMinor,
        explanation: `Statement credit for PAN ${pan} exceeds optional imported 26AS/TRACES evidence by ${reportedMinor - creditedMinor} minor units.`,
        sourceLabel: "Optional user-imported 26AS/TRACES evidence",
      }));
    }
  }
}

function buildTdsHealthChecks({ deductions = [], challans = [], statements = [], credits = [] }) {
  if (!deductions.length) throw new Error("TDS health generation requires deduction source rows");
  if (!challans.length) throw new Error("TDS health generation requires ITNS 281 challan source rows");
  if (!statements.length) throw new Error("TDS health generation requires statement source rows");
  const checks = [];
  createPanChecks(deductions, checks);
  createDepositChecks(deductions, challans, checks);
  createStatementChecks(deductions, challans, statements, checks);
  createCreditChecks(statements, credits, checks);

  const itemKeys = new Set();
  checks.forEach((check) => {
    if (itemKeys.has(check.itemKey)) throw new Error(`Duplicate TDS health check key: ${check.itemKey}`);
    itemKeys.add(check.itemKey);
  });

  const deductedMinor = sum(deductions, deductedTotal);
  const depositedMinor = sum(challans, (row) => row.depositedMinor || 0);
  const reportedMinor = sum(statements, (row) => row.reportedMinor || 0);
  const importedCreditMinor = sum(credits, (row) => row.creditedMinor || 0);
  return {
    checks,
    summary: {
      deductedMinor,
      depositedMinor,
      reportedMinor,
      importedCreditMinor,
      estimatedGapMinor: Math.max(0, deductedMinor - depositedMinor),
      totalChecks: checks.length,
      openChecks: checks.length,
      actionPlannedChecks: 0,
      resolvedChecks: 0,
    },
    calculationPolicy: {
      version: HEALTH_RULE_VERSION,
      sourceLabel: "Normalized user-imported TDS records",
      sourceReference: HEALTH_SOURCE_REFERENCE,
      estimate: true,
      professionalConfirmed: false,
      ratesApplied: false,
    },
  };
}

export {
  CHECK_META,
  HEALTH_RULE_VERSION,
  HEALTH_SOURCE_REFERENCE,
  buildTdsHealthChecks,
  deductedTotal,
  sourceRows,
};
