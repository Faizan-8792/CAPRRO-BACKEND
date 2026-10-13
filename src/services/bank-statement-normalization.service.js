// Deterministic Phase-1 primitives for the Indian Bank Statement Converter.
//
// This module deliberately has no PDF, database, network, spreadsheet, or layout-profile
// dependency. It is the narrow correctness boundary that turns printed field values into exact
// typed values and proves the balance chain. A parser must preserve the raw value beside these
// outputs and surface every issue; it must never use this module to silently "repair" a value.

const MONTHS = Object.freeze({
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3,
  APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7,
  AUG: 8, AUGUST: 8, SEP: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10,
  NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
});

export const BANK_STATEMENT_CODES = Object.freeze({
  AMOUNT_INVALID: "E-AMT-INVALID",
  AMOUNT_RANGE: "E-AMT-RANGE",
  AMOUNT_SIGN: "E-AMT-SIGN",
  BOTH_MOVEMENTS: "E-BOTH",
  COLUMN_MAPPING: "E-COLMAP",
  DATE_AMBIGUOUS: "E-DATE-AMBIG",
  DATE_INVALID: "E-DATE-INVALID",
  DATE_RANGE: "E-DATE-RANGE",
  NO_MOVEMENT: "E-NOAMT",
  BALANCE_INVALID: "E-BAL-INVALID",
  ARITHMETIC: "E-ARITH",
  DATE_RANGE_WARNING: "W-DATE-RANGE",
  YEAR_ASSUMED: "W-YEAR-ASSUMED",
  ZERO_BLANKED: "I-ZERO-BLANKED",
});

export const BANK_STATEMENT_ROW_ORDER = Object.freeze({
  ASCENDING: "ASCENDING",
  DESCENDING: "DESCENDING",
});

function issue(code, raw, detail) {
  return { code, raw: String(raw ?? ""), detail };
}

function validUtcDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseIso(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return validUtcDay(year, month, day) ? { year, month, day, iso: isoDate(year, month, day) } : null;
}

function addDays(date, days) {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
    iso: result.toISOString().slice(0, 10),
  };
}

function differenceInDays(left, right) {
  const leftTime = Date.UTC(left.year, left.month - 1, left.day);
  const rightTime = Date.UTC(right.year, right.month - 1, right.day);
  return Math.round((leftTime - rightTime) / 86_400_000);
}

function parsePeriod(period) {
  if (!period?.from || !period?.to) return null;
  const from = parseIso(period.from);
  const to = parseIso(period.to);
  if (!from || !to || differenceInDays(from, to) > 0) return null;
  return { from, to };
}

function fallsWithin(date, start, end) {
  return differenceInDays(date, start) >= 0 && differenceInDays(date, end) <= 0;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function parsePrintedDate(raw) {
  const value = String(raw ?? "").trim();
  let match = value.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (match) {
    return {
      day: Number(match[1]),
      month: Number(match[2]),
      yearText: match[3],
    };
  }

  match = value.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  if (!month) return null;
  return { day: Number(match[1]), month, yearText: match[3] };
}

/**
 * Parse a printed transaction date under the converter's strict day-first rule.
 * A two-digit year is resolved only when exactly one of 19YY/20YY/21YY falls within
 * the statement period widened by 31 days. Without a supplied period, 20YY is retained
 * with W-YEAR-ASSUMED rather than pretending the century was proved.
 */
export function normalizeStatementDate(raw, { period } = {}) {
  const parsed = parsePrintedDate(raw);
  if (!parsed) {
    return { value: null, issues: [issue(BANK_STATEMENT_CODES.DATE_INVALID, raw, "Date does not use a supported day-first format.")] };
  }

  const parsedPeriod = parsePeriod(period);
  const issues = [];
  let year;
  if (parsed.yearText.length === 4) {
    year = Number(parsed.yearText);
  } else if (parsedPeriod) {
    const candidates = [1900, 2000, 2100]
      .map((century) => century + Number(parsed.yearText))
      .filter((candidate) => validUtcDay(candidate, parsed.month, parsed.day))
      .filter((candidate) => fallsWithin({ year: candidate, month: parsed.month, day: parsed.day }, addDays(parsedPeriod.from, -31), addDays(parsedPeriod.to, 31)));
    if (candidates.length !== 1) {
      return { value: null, issues: [issue(BANK_STATEMENT_CODES.DATE_AMBIGUOUS, raw, "Two-digit year cannot be resolved uniquely from the statement period.")] };
    }
    year = candidates[0];
  } else {
    year = 2000 + Number(parsed.yearText);
    issues.push(issue(BANK_STATEMENT_CODES.YEAR_ASSUMED, raw, "No statement period was available; the two-digit year was retained as 20YY."));
  }

  if (!validUtcDay(year, parsed.month, parsed.day)) {
    return { value: null, issues: [issue(BANK_STATEMENT_CODES.DATE_INVALID, raw, "Date is not a real calendar date.")] };
  }

  const value = isoDate(year, parsed.month, parsed.day);
  if (parsedPeriod) {
    const date = { year, month: parsed.month, day: parsed.day };
    const distance = fallsWithin(date, parsedPeriod.from, parsedPeriod.to)
      ? 0
      : Math.min(Math.abs(differenceInDays(date, parsedPeriod.from)), Math.abs(differenceInDays(date, parsedPeriod.to)));
    if (distance > 31) {
      issues.push(issue(BANK_STATEMENT_CODES.DATE_RANGE, raw, "Date is more than 31 days outside the printed statement period."));
    } else if (distance > 0) {
      issues.push(issue(BANK_STATEMENT_CODES.DATE_RANGE_WARNING, raw, "Date is up to 31 days outside the printed statement period."));
    }
  }
  return { value, issues };
}

function parseAmountToken(raw) {
  const original = String(raw ?? "");
  let token = original.replace(/[\u0000-\u001F]/g, " ").trim();
  if (!token) return { empty: true };

  const markerMatches = [...token.matchAll(/(?:^|\s)(Dr|Cr)(?=\s|$)/gi)].map((match) => match[1].toUpperCase());
  if (markerMatches.length > 1 || new Set(markerMatches).size > 1) {
    return { error: BANK_STATEMENT_CODES.AMOUNT_INVALID, detail: "Amount has conflicting Dr/Cr markers." };
  }
  const marker = markerMatches[0] || null;
  token = token.replace(/(?:^|\s)(?:Dr|Cr)(?=\s|$)/gi, " ");
  token = token.replace(/₹|INR|Rs\.?/gi, "").replace(/[\s\u00A0]/g, "");

  let negative = false;
  if (/^\(.*\)$/.test(token)) {
    negative = true;
    token = token.slice(1, -1);
  }
  if (token.startsWith("-")) {
    negative = true;
    token = token.slice(1);
  } else if (token.startsWith("+")) {
    token = token.slice(1);
  }
  if (token.endsWith("-")) {
    negative = true;
    token = token.slice(0, -1);
  }
  if (!token || /[()+-]/.test(token)) {
    return { error: BANK_STATEMENT_CODES.AMOUNT_INVALID, detail: "Amount has an unsupported sign or numeric shape." };
  }

  const indian = /^\d{1,2}(,\d{2})*,\d{3}(\.\d{1,2})?$/;
  const international = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
  const plain = /^\d+(\.\d{1,2})?$/;
  if (!indian.test(token) && !international.test(token) && !plain.test(token)) {
    return { error: BANK_STATEMENT_CODES.AMOUNT_INVALID, detail: "Amount does not use an accepted Indian, international, or ungrouped numeric format." };
  }

  const [wholePart, fraction = ""] = token.replace(/,/g, "").split(".");
  const significantDigits = `${wholePart}${fraction}`.replace(/^0+/, "").length;
  if (significantDigits > 15) {
    return { error: BANK_STATEMENT_CODES.AMOUNT_RANGE, detail: "Amount has more than 15 significant digits and cannot be represented exactly in Excel." };
  }
  const paise = BigInt(wholePart) * 100n + BigInt(fraction.padEnd(2, "0"));
  return { paise: negative ? -paise : paise, marker, negative };
}

/**
 * Converts a printed amount to exact paise. For movement columns, printed negative amounts are
 * errors and Dr/Cr markers must agree with the known Debit/Credit column; for a balance, Dr means
 * negative and Cr means positive. It never flips an invalid movement into a valid one.
 */
export function normalizeStatementAmount(raw, { kind = "movement", column } = {}) {
  const parsed = parseAmountToken(raw);
  if (parsed.empty) return { value: null, issues: [] };
  if (parsed.error) return { value: null, issues: [issue(parsed.error, raw, parsed.detail)] };

  if (kind === "movement") {
    if (parsed.negative) {
      return { value: null, issues: [issue(BANK_STATEMENT_CODES.AMOUNT_SIGN, raw, "Debit and Credit movement values must be unsigned magnitudes.")] };
    }
    const expectedMarker = column ? String(column).toUpperCase().replace(/[^A-Z]/g, "") : null;
    if (expectedMarker && parsed.marker && !expectedMarker.startsWith(parsed.marker)) {
      return { value: null, issues: [issue(BANK_STATEMENT_CODES.COLUMN_MAPPING, raw, "Dr/Cr marker disagrees with the mapped movement column.")] };
    }
    return { value: parsed.paise, issues: [] };
  }

  if (kind !== "balance") {
    throw new Error(`Unsupported bank statement amount kind: ${kind}`);
  }
  let value = parsed.paise;
  if (parsed.marker === "DR") value = value < 0n ? value : -value;
  if (parsed.marker === "CR") value = value < 0n ? -value : value;
  return { value, issues: [] };
}

/** Normalizes the mutually-exclusive Debit and Credit columns without replacing blanks by zero. */
export function normalizeStatementMovement({ debit, credit }) {
  const normalizedDebit = normalizeStatementAmount(debit, { kind: "movement", column: "Debit" });
  const normalizedCredit = normalizeStatementAmount(credit, { kind: "movement", column: "Credit" });
  const issues = [...normalizedDebit.issues, ...normalizedCredit.issues];
  const debitValue = normalizedDebit.value;
  const creditValue = normalizedCredit.value;

  if (debitValue !== null && creditValue !== null && debitValue !== 0n && creditValue !== 0n) {
    issues.push(issue(BANK_STATEMENT_CODES.BOTH_MOVEMENTS, `${debit ?? ""} | ${credit ?? ""}`, "Both Debit and Credit contain a non-zero value."));
  }

  let finalDebit = debitValue;
  let finalCredit = creditValue;
  if (debitValue === 0n && creditValue !== null && creditValue !== 0n) {
    finalDebit = null;
    issues.push(issue(BANK_STATEMENT_CODES.ZERO_BLANKED, debit, "0.00 in the non-applicable Debit column was treated as blank."));
  }
  if (creditValue === 0n && debitValue !== null && debitValue !== 0n) {
    finalCredit = null;
    issues.push(issue(BANK_STATEMENT_CODES.ZERO_BLANKED, credit, "0.00 in the non-applicable Credit column was treated as blank."));
  }
  if ((finalDebit === null || finalDebit === 0n) && (finalCredit === null || finalCredit === 0n)) {
    issues.push(issue(BANK_STATEMENT_CODES.NO_MOVEMENT, `${debit ?? ""} | ${credit ?? ""}`, "A transaction row has no non-zero Debit or Credit value."));
  }
  return { debit: finalDebit, credit: finalCredit, issues };
}

export function paiseToDecimalString(value) {
  const signed = BigInt(value);
  const sign = signed < 0n ? "-" : "";
  const magnitude = signed < 0n ? -signed : signed;
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

/**
 * Produces the typed record used between parsing and validation. Raw fields remain alongside every
 * normalized field so an Excel cell, exception, or reviewer decision can be traced to source text.
 */
export function normalizeStatementRow(rawRow, { period } = {}) {
  const date = normalizeStatementDate(rawRow.date, { period });
  const movement = normalizeStatementMovement({ debit: rawRow.debit, credit: rawRow.credit });
  const balance = normalizeStatementAmount(rawRow.balance, { kind: "balance" });
  const issues = [...date.issues, ...movement.issues, ...balance.issues];
  if (balance.value === null) {
    issues.push(issue(BANK_STATEMENT_CODES.BALANCE_INVALID, rawRow.balance, "A balance is required for this row by the active layout profile."));
  }
  return {
    source: { page: rawRow.source?.page ?? null, position: rawRow.source?.position ?? null, sequence: rawRow.source?.sequence ?? null },
    raw: { date: String(rawRow.date ?? ""), narration: String(rawRow.narration ?? ""), debit: String(rawRow.debit ?? ""), credit: String(rawRow.credit ?? ""), balance: String(rawRow.balance ?? "") },
    values: { date: date.value, narration: String(rawRow.narration ?? "").replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim(), debit: movement.debit, credit: movement.credit, balance: balance.value },
    issues,
  };
}

/**
 * Runs the exact V-B1 chain against already-normalized rows. It deliberately uses the printed
 * neighbouring balance for each row, even after a failure, so one bad value does not create a
 * misleading cascade of later failures.
 */
export function validateBalanceChain(rows, { openingBalance, order = BANK_STATEMENT_ROW_ORDER.ASCENDING } = {}) {
  const opening = BigInt(openingBalance);
  if (!Object.values(BANK_STATEMENT_ROW_ORDER).includes(order)) {
    throw new Error(`Unsupported bank statement row order: ${order}`);
  }
  const indexedRows = order === BANK_STATEMENT_ROW_ORDER.ASCENDING
    ? rows.map((row, index) => ({ row, index }))
    : rows.map((row, index) => ({ row, index })).reverse();
  let neighbouringBalance = opening;
  const checks = [];

  for (const { row, index } of indexedRows) {
    const debit = row.values?.debit ?? row.debit ?? null;
    const credit = row.values?.credit ?? row.credit ?? null;
    const balance = row.values?.balance ?? row.balance ?? null;
    if (balance === null || balance === undefined) {
      checks.push({ rowIndex: index, pass: false, code: BANK_STATEMENT_CODES.BALANCE_INVALID, expected: null, actual: null });
      continue;
    }
    const expected = neighbouringBalance - BigInt(debit ?? 0n) + BigInt(credit ?? 0n);
    const actual = BigInt(balance);
    checks.push({ rowIndex: index, pass: expected === actual, code: expected === actual ? null : BANK_STATEMENT_CODES.ARITHMETIC, expected, actual, difference: actual - expected });
    neighbouringBalance = actual;
  }
  return checks;
}
