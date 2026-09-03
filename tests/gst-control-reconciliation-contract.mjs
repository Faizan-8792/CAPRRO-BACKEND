// tests/gst-control-reconciliation-contract.mjs
//
// The three reconciliations a CA runs on one GST period, and the column recognition that gets a
// real file into them.
//
// CA PRO already matched books against GSTR-2B invoice by invoice, and already compared that
// result against the ITC claimed in GSTR-3B. It had no way to check the OTHER two things the same
// period needs: that the turnover declared in GSTR-1 agrees with the turnover declared in GSTR-3B,
// and that the ITC claimed agrees with what the electronic credit ledger actually received. Those
// two are what this file covers, together with the header resolver that was written years ago and
// called by nothing but a self-test.
//
// Every check here is on BEHAVIOUR with figures, not on the presence of a constant. Where a sign
// convention or an exclusion rule could be silently inverted and still "pass", the test states the
// arithmetic explicitly and would fail if it changed.
//
// Pure logic - no database, no network, no server.
//
// Run: node tests/gst-control-reconciliation-contract.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { GST_IMPORT_KINDS } from "../src/models/ImportRow.js";
import { fingerprintForRun } from "../src/services/gst-reconciliation.service.js";
import {
  GST_IMPORT_SPECS,
  calculateCreditLedgerBalance,
  calculateGstr1Outward,
  calculateGstr3bClaimed,
  calculateGstr3bControlTotals,
  calculateGstr3bOutward,
  normalizeEcreditCategory,
  normalizeGstr1Category,
  normalizeGstr3bCategory,
} from "../src/services/gst-normalization.service.js";
import {
  buildMappingFromHeaders,
  resolveHeaderField,
} from "../src/services/robust-normalize.service.js";
import { suggestImportMapping } from "../src/services/import-preview.service.js";

// The create controller strips any field not on its allowlist, so the allowlist is read from the
// controller itself rather than trusted.
const CREATE_FIELDS_SOURCE = readFileSync(
  new URL("../src/controllers/gst-reconciliation.controller.js", import.meta.url),
  "utf8",
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const row = (category, taxable, igst = 0, cgst = 0, sgst = 0, cess = 0) => ({
  summaryCategory: category,
  taxableValueMinor: taxable,
  igstMinor: igst,
  cgstMinor: cgst,
  sgstMinor: sgst,
  cessMinor: cess,
});

// ─── header recognition ───────────────────────────────────────────

check(
  "an exact synonym resolves",
  resolveHeaderField("Supplier GSTIN", "GST_PURCHASE") === "supplierGstin",
  resolveHeaderField("Supplier GSTIN", "GST_PURCHASE"),
);

check(
  "a header CONTAINING a synonym resolves",
  resolveHeaderField("GSTIN of Supplier (as per books)", "GST_PURCHASE") === "supplierGstin",
  resolveHeaderField("GSTIN of Supplier (as per books)", "GST_PURCHASE"),
);

check(
  "a one-character typo still resolves through the edit-distance fallback",
  resolveHeaderField("Taxble Value", "GST_PURCHASE") === "taxableValue",
  resolveHeaderField("Taxble Value", "GST_PURCHASE") || "(null)",
);

check(
  "a column that means nothing to us resolves to nothing, rather than to the nearest field",
  resolveHeaderField("Narration", "GST_PURCHASE") === null,
  String(resolveHeaderField("Narration", "GST_PURCHASE")),
);

{
  // THE BEST-SCORING HEADER WINS, NOT THE LEFTMOST. A register carrying both "Date" and
  // "Invoice Date" must map the document date to the specific one; taking whichever came first
  // would silently change which return period an invoice falls in.
  const mapping = buildMappingFromHeaders(["Date", "Invoice Date"], "GST_PURCHASE");
  check(
    "when two columns compete for one field the more specific one wins",
    mapping.documentDate === "Invoice Date",
    `documentDate -> ${mapping.documentDate}`,
  );

  const reversed = buildMappingFromHeaders(["Invoice Date", "Date"], "GST_PURCHASE");
  check(
    "and the winner does not depend on column order",
    reversed.documentDate === "Invoice Date",
    `documentDate -> ${reversed.documentDate}`,
  );
}

{
  // The summary returns are shaped category-then-amounts, so they need their own dictionary.
  // These are the actual column names on a GSTR-3B.
  const mapping = buildMappingFromHeaders(
    ["Nature of Supply", "Total Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess"],
    "GSTR3B_SUMMARY",
  );
  const missing = ["category", "taxableValue", "igst", "cgst", "sgst", "cess"].filter(
    (field) => !mapping[field],
  );
  check(
    "a real GSTR-3B header row maps completely",
    missing.length === 0,
    missing.length ? `unmapped: ${missing.join(", ")}` : JSON.stringify(mapping),
  );
}

{
  // A Tally-style export: a company name and a period caption above the real headings, and column
  // names nobody standardised. This is the file the whole resolver exists for.
  const messy = [
    "ACME TRADERS PRIVATE LIMITED",
    "Purchase Register for the month of May 2026",
    "",
    "S.No,GSTIN of Supplier,Invoice No.,Invoice Date,Taxable Val,IGST Amt,CGST Amount,SGST/UTGST,Cess,Document Type,Recipient GSTIN",
    "1,27AAAAA0000A1Z5,INV-1,03/05/2026,10000,1800,0,0,0,Invoice,27ZZZZZ0000Z1Z5",
  ].join("\n");

  const suggestion = suggestImportMapping({ kind: "GST_PURCHASE", text: messy });

  check(
    "a title block above the headings does not defeat delimiter detection",
    suggestion.delimiter === ",",
    `delimiter ${JSON.stringify(suggestion.delimiter)}`,
  );
  check(
    "every required column of a messy real-world register is recognised without help",
    suggestion.complete === true && suggestion.missingRequired.length === 0,
    suggestion.missingRequired.length
      ? `missing: ${suggestion.missingRequired.join(", ")}`
      : `${Object.keys(suggestion.suggestedMapping).length} fields mapped`,
  );
  check(
    "the skipped preamble is REPORTED, not silently dropped",
    suggestion.notes.some((note) => note.code === "PREAMBLE_ROWS_SKIPPED"),
    JSON.stringify(suggestion.notes),
  );
  check(
    "a column CA PRO does not recognise is named for the user to map by hand",
    suggestion.unmappedHeaders.includes("S.No"),
    JSON.stringify(suggestion.unmappedHeaders),
  );
}

for (const [label, text, expected] of [
  ["tab", "Caption line\n\nA\tB\tC\n1\t2\t3\n4\t5\t6", "\t"],
  ["semicolon", "Caption line\n\nA;B;C\n1;2;3\n4;5;6", ";"],
  ["comma", "Caption line\n\nA,B,C\n1,2,3\n4,5,6", ","],
]) {
  const suggestion = suggestImportMapping({ kind: "CLIENTS", text });
  check(
    `${label}-delimited file with a caption is detected as ${label}`,
    suggestion.delimiter === expected,
    JSON.stringify(suggestion.delimiter),
  );
}

{
  // A comma inside a quoted supplier name must not vote for the comma delimiter.
  const text = 'Name\tGSTIN\n"Acme Traders, Mumbai"\t27AAAAA0000A1Z5\n"Beta Co, Pune"\t27BBBBB0000B1Z5';
  const suggestion = suggestImportMapping({ kind: "CLIENTS", text });
  check(
    "a comma inside a quoted value does not hijack delimiter detection",
    suggestion.delimiter === "\t",
    JSON.stringify(suggestion.delimiter),
  );
}

// ─── category vocabulary ──────────────────────────────────────────

check(
  "GSTR-3B Table 3.1 labels resolve",
  normalizeGstr3bCategory("Outward taxable supplies") === "OUTWARD_TAXABLE"
    && normalizeGstr3bCategory("3.1(b)") === "OUTWARD_ZERO_RATED",
  `${normalizeGstr3bCategory("Outward taxable supplies")} / ${normalizeGstr3bCategory("3.1(b)")}`,
);
check(
  "GSTR-3B Table 4 labels still resolve",
  normalizeGstr3bCategory("Net ITC Available") === "ITC_CLAIMED",
  String(normalizeGstr3bCategory("Net ITC Available")),
);
check(
  "GSTR-1 section labels resolve",
  normalizeGstr1Category("B2B Invoices") === "B2B"
    && normalizeGstr1Category("Credit Note Registered") === "CDNR",
  `${normalizeGstr1Category("B2B Invoices")} / ${normalizeGstr1Category("Credit Note Registered")}`,
);
check(
  "credit ledger labels resolve",
  normalizeEcreditCategory("Closing Balance") === "CLOSING_BALANCE"
    && normalizeEcreditCategory("ITC Utilised") === "DEBIT",
  `${normalizeEcreditCategory("Closing Balance")} / ${normalizeEcreditCategory("ITC Utilised")}`,
);
check(
  "an unrecognised category is refused rather than guessed",
  normalizeGstr3bCategory("Some Other Thing") === null
    && normalizeGstr1Category("Nonsense") === null,
  "",
);

// ─── GSTR-3B outward (Table 3.1) ──────────────────────────────────

{
  const rows = [
    row("Outward taxable supplies", 500_000_00, 45_000_00, 22_500_00, 22_500_00, 0),
    row("Zero rated", 100_000_00, 0, 0, 0, 0),
    // Excluded: no tax, and not part of the taxable comparison.
    row("Nil rated / exempt", 25_000_00, 0, 0, 0, 0),
    // Excluded: inward, not outward. Including it would inflate declared turnover by the value
    // of the firm's own purchases.
    row("Inward reverse charge", 40_000_00, 7_200_00, 0, 0, 0),
  ];
  const outward = calculateGstr3bOutward(rows);

  check(
    "only taxable and zero-rated supplies count as declared turnover",
    outward.taxableValueMinor === 600_000_00,
    `taxable ${outward.taxableValueMinor} (expected ${600_000_00})`,
  );
  check(
    "inward reverse charge tax is NOT added to outward tax",
    outward.igstMinor === 45_000_00,
    `igst ${outward.igstMinor} (expected ${45_000_00})`,
  );
  check(
    "the total tax is the sum of the four heads",
    outward.totalTaxMinor === 90_000_00,
    `total ${outward.totalTaxMinor}`,
  );
}

check(
  "a GSTR-3B with no Table 3.1 rows reports null, not zeroes",
  calculateGstr3bOutward([row("Net ITC Available", 0, 12_000_00, 0, 0, 0)]) === null,
  "",
);

// ─── GSTR-1 outward ───────────────────────────────────────────────

{
  const rows = [
    row("B2B", 400_000_00, 36_000_00, 0, 0, 0),
    row("B2C", 150_000_00, 0, 13_500_00, 13_500_00, 0),
    // A credit note REDUCES turnover. It arrives positive, under a CDNR category.
    row("Credit Note Registered", 50_000_00, 4_500_00, 0, 0, 0),
    // Nil rated carries no tax and is excluded, matching the GSTR-3B side.
    row("Nil Rated", 30_000_00, 0, 0, 0, 0),
  ];
  const outward = calculateGstr1Outward(rows);

  check(
    "credit notes are SUBTRACTED from declared turnover",
    outward.taxableValueMinor === 500_000_00,
    `taxable ${outward.taxableValueMinor} (400,000 + 150,000 - 50,000 = 500,000)`,
  );
  check(
    "credit note tax is subtracted too",
    outward.igstMinor === 31_500_00,
    `igst ${outward.igstMinor} (36,000 - 4,500 = 31,500)`,
  );
  check(
    "nil-rated supply is excluded from the taxable comparison",
    outward.taxableValueMinor === 500_000_00,
    "30,000 of nil-rated supply is not counted",
  );
}

check(
  "a GSTR-1 with only nil-rated rows reports null rather than a zero turnover",
  calculateGstr1Outward([row("Nil Rated", 30_000_00, 0, 0, 0, 0)]) === null,
  "",
);

// ─── credit ledger ────────────────────────────────────────────────

{
  const stated = calculateCreditLedgerBalance([
    row("Opening Balance", 0, 10_000_00, 0, 0, 0),
    row("Credit", 0, 45_000_00, 0, 0, 0),
    row("Debit", 0, 30_000_00, 0, 0, 0),
    row("Closing Balance", 0, 25_000_00, 0, 0, 0),
  ]);
  check(
    "a stated closing balance is used, and agrees with the movement here",
    stated.basis === "STATED_IN_FILE"
      && stated.closing.igstMinor === 25_000_00
      && stated.statedDiffers === false,
    `basis ${stated.basis}, igst ${stated.closing.igstMinor}, differs ${stated.statedDiffers}`,
  );
}

{
  // The portal's own figure wins over our arithmetic - but the disagreement is REPORTED.
  const conflicting = calculateCreditLedgerBalance([
    row("Opening Balance", 0, 10_000_00, 0, 0, 0),
    row("Credit", 0, 45_000_00, 0, 0, 0),
    row("Debit", 0, 30_000_00, 0, 0, 0),
    row("Closing Balance", 0, 99_000_00, 0, 0, 0),
  ]);
  check(
    "a stated closing balance that contradicts the movement is flagged, not silently corrected",
    conflicting.closing.igstMinor === 99_000_00
      && conflicting.statedDiffers === true
      && conflicting.computed.igstMinor === 25_000_00,
    `stated ${conflicting.closing.igstMinor}, computed ${conflicting.computed?.igstMinor}, flagged ${conflicting.statedDiffers}`,
  );
}

{
  const computed = calculateCreditLedgerBalance([
    row("Opening Balance", 0, 10_000_00, 0, 0, 0),
    row("Credit", 0, 45_000_00, 0, 0, 0),
    row("Debit", 0, 30_000_00, 0, 0, 0),
  ]);
  check(
    "with no stated closing balance the movement is used and said to be computed",
    computed.basis === "COMPUTED_FROM_MOVEMENT" && computed.closing.igstMinor === 25_000_00,
    `basis ${computed.basis}, igst ${computed.closing.igstMinor}`,
  );
}

check(
  "an empty ledger reports null rather than a zero balance",
  calculateCreditLedgerBalance([]) === null,
  "",
);

// ─── the both-halves reader ───────────────────────────────────────

{
  const both = calculateGstr3bControlTotals([
    row("Outward taxable supplies", 500_000_00, 45_000_00, 0, 0, 0),
    row("Net ITC Available", 0, 12_000_00, 0, 0, 0),
  ]);
  check(
    "one GSTR-3B upload yields BOTH the ITC figure and the outward figure",
    both.claimed.igstMinor === 12_000_00 && both.outward.taxableValueMinor === 500_000_00,
    `claimed ${both.claimed.igstMinor}, outward ${both.outward.taxableValueMinor}`,
  );
}

{
  // An outward-only return is a legitimate file: Table 3.1 imported for turnover, Table 4 not.
  // Before this it was rejected with a message about ITC its uploader could do nothing about.
  const outwardOnly = calculateGstr3bControlTotals([
    row("Outward taxable supplies", 500_000_00, 45_000_00, 0, 0, 0),
  ]);
  check(
    "an outward-only GSTR-3B imports instead of being refused for having no ITC rows",
    outwardOnly.claimed === null && outwardOnly.outward.taxableValueMinor === 500_000_00,
    `claimed ${outwardOnly.claimed}, outward ${outwardOnly.outward.taxableValueMinor}`,
  );
}

{
  // ...but tolerating "no ITC rows" must NOT tolerate a broken file. An unsupported category is a
  // defect wherever it appears, and swallowing it would let a return with a bad row import
  // silently and then reconcile against a figure nobody checked.
  let threw = false;
  try {
    calculateGstr3bControlTotals([
      row("Outward taxable supplies", 500_000_00, 45_000_00, 0, 0, 0),
      row("Some Other Thing", 0, 1_000_00, 0, 0, 0),
    ]);
  } catch {
    threw = true;
  }
  check(
    "an unsupported category still stops the import even when Table 3.1 is readable",
    threw,
    threw ? "refused" : "ACCEPTED - a bad row would import silently",
  );
}

{
  let threw = false;
  try {
    calculateGstr3bControlTotals([row("Nil rated / exempt", 25_000_00, 0, 0, 0, 0)]);
  } catch {
    threw = true;
  }
  check(
    "a return with neither ITC rows nor turnover-bearing outward rows is still refused",
    threw,
    threw ? "refused" : "ACCEPTED",
  );
}

check(
  "the existing ITC calculation is unchanged for an ITC-only return",
  calculateGstr3bClaimed([row("Net ITC Available", 0, 12_000_00, 0, 0, 0)]).claimed.igstMinor
    === 12_000_00,
  "",
);

// ─── the turnover comparison itself ───────────────────────────────

{
  // The arithmetic a CA is actually looking for: GSTR-1 says one thing, GSTR-3B says another.
  const gstr1 = calculateGstr1Outward([row("B2B", 500_000_00, 45_000_00, 0, 0, 0)]);
  const gstr3b = calculateGstr3bOutward([
    row("Outward taxable supplies", 480_000_00, 43_200_00, 0, 0, 0),
  ]);

  const taxableDifference = gstr1.taxableValueMinor - gstr3b.taxableValueMinor;
  const igstDifference = gstr1.igstMinor - gstr3b.igstMinor;

  check(
    "turnover under-declared in GSTR-3B shows as a POSITIVE difference",
    taxableDifference === 20_000_00 && igstDifference === 1_800_00,
    `taxable +${taxableDifference}, igst +${igstDifference}`,
  );
}


// ─── run identity: the two new sources must change the fingerprint ─

// The fingerprint is the idempotency key behind a unique {firmId, sourceFingerprint, revision}
// index. Two creates that hash alike are treated as one create being retried, and the second is
// REPLAYED as the first rather than stored. So a run that attaches a GSTR-1 must not hash the same
// as an otherwise identical run that does not: it would be replayed as that run and the source the
// person had just chosen would be silently discarded.
{
  const base = {
    clientId: "65f0000000000000000000c1",
    gstin: "29AABCU9603R1ZM",
    period: "2026-04",
    booksBatchId: "65f0000000000000000000b1",
    portalBatchId: "65f0000000000000000000b2",
    gstr3bBatchId: "65f0000000000000000000b3",
    matchingConfig: { roundingToleranceMinor: 100, dateToleranceDays: 7 },
    priorPeriodAdjustment: {},
    assignedTo: null,
    parentRunId: null,
  };

  const plain = fingerprintForRun(base);
  const withGstr1 = fingerprintForRun({ ...base, gstr1BatchId: "65f0000000000000000000b4" });
  const withLedger = fingerprintForRun({ ...base, creditLedgerBatchId: "65f0000000000000000000b5" });
  const withBoth = fingerprintForRun({
    ...base,
    gstr1BatchId: "65f0000000000000000000b4",
    creditLedgerBatchId: "65f0000000000000000000b5",
  });
  const otherGstr1 = fingerprintForRun({ ...base, gstr1BatchId: "65f0000000000000000000b9" });

  check(
    "attaching a GSTR-1 changes the run fingerprint",
    plain !== withGstr1,
    plain === withGstr1 ? "COLLIDES - the GSTR-1 would be silently dropped" : "distinct",
  );
  check(
    "attaching a credit ledger changes the run fingerprint",
    plain !== withLedger,
    plain === withLedger ? "COLLIDES - the ledger would be silently dropped" : "distinct",
  );
  check(
    "two different GSTR-1 batches produce different fingerprints",
    withGstr1 !== otherGstr1,
    withGstr1 === otherGstr1 ? "COLLIDES" : "distinct",
  );
  check(
    "all four source combinations are mutually distinct",
    new Set([plain, withGstr1, withLedger, withBoth]).size === 4,
    `${new Set([plain, withGstr1, withLedger, withBoth]).size} of 4 distinct`,
  );

  // And the other half of the contract: a run with neither new source must hash to EXACTLY what it
  // hashed to before these sources existed. If it does not, every create retried across the deploy
  // that shipped them produces a duplicate run instead of replaying the original. The expected
  // value is rebuilt here from the pre-change field list rather than pasted as a magic string, so
  // this states the old algorithm instead of merely recording its output.
  const legacy = createHash("sha256")
    .update(
      JSON.stringify({
        fingerprintVersion: "gst-run-v2",
        clientId: String(base.clientId),
        gstin: base.gstin,
        period: base.period,
        booksBatchId: String(base.booksBatchId),
        portalBatchId: String(base.portalBatchId),
        gstr3bBatchId: String(base.gstr3bBatchId),
        matchingConfig: base.matchingConfig,
        priorPeriodAdjustment: base.priorPeriodAdjustment,
        assignedTo: null,
        parentRunId: null,
      }),
    )
    .digest("hex");

  check(
    "a run with neither new source still hashes exactly as it did before they existed",
    plain === legacy,
    plain === legacy ? "unchanged" : `CHANGED: ${plain.slice(0, 12)} vs ${legacy.slice(0, 12)}`,
  );

  check(
    "explicit nulls hash the same as omitting the new sources entirely",
    fingerprintForRun({ ...base, gstr1BatchId: null, creditLedgerBatchId: null }) === plain,
    "null-safe",
  );
}

// ─── every import kind is reachable from every client ─────────────

// A kind the server accepts but no client offers is a feature nobody can use, and every gap of
// that shape here has been a silent one: the kind was added to the model and the service, and the
// screen that would let a firm choose it was never touched. This reads the clients' own source and
// requires each GST kind to be present in all of them.
{
  const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

  const extensionJs = readSource("../../audit-nlp-extension/workspace.js");
  const extensionHtml = readSource("../../audit-nlp-extension/workspace.html");
  const desktopWrites = readSource(
    "../../apps/desktop-native/src/CaPro.Desktop.Core/Models/ImportWrites.cs",
  );
  const desktopPage = readSource(
    "../../apps/desktop-native/src/CaPro.Desktop.App/Views/ImportLookupPage.xaml.cs",
  );

  // The desktop keys some of its field definitions by a named constant rather than by the kind
  // string - [Gstr2bKind] instead of ["GSTR2B"] - so the constants are resolved first. Checking
  // only for the literal form would report a kind as undefined purely because it was spelled
  // through a const, which is a real pattern in that file and not a defect.
  const desktopAliases = new Map(
    [...desktopWrites.matchAll(/const string (\w+) = "([A-Z0-9_]+)";/g)].map(
      (match) => [match[2], match[1]],
    ),
  );
  const desktopDefinesFields = (kind) =>
    desktopWrites.includes(`["${kind}"] =`)
    || (desktopAliases.has(kind) && desktopWrites.includes(`[${desktopAliases.get(kind)}] =`));

  // Each table is sliced out before it is searched. Several tables in that file are keyed by the
  // same kind names, so an unscoped search finds ECREDIT_LEDGER in the sample-row table and
  // reports the prefix registry as populated when the kind has been deleted from it.
  const extensionBlock = (declaration, next) =>
    extensionJs.slice(extensionJs.indexOf(declaration), extensionJs.indexOf(next));
  const prefixBlock = extensionBlock("const GST_IMPORT_PREFIX", "const GST_DEFAULT_MAPPING");
  const requiredFieldsBlock = extensionBlock(
    "const SMART_IMPORT_REQUIRED_FIELDS",
    "const SMART_IMPORT_EXTRA_ALLOWED_FIELDS",
  );

  check(
    "the server knows five GST import kinds",
    GST_IMPORT_KINDS.length === 5,
    GST_IMPORT_KINDS.join(", "),
  );

  for (const kind of GST_IMPORT_KINDS) {
    // The extension: registered as a kind, given required fields, and given a card whose Preview
    // and Apply buttons are wired to that kind.
    check(
      `${kind}: the extension registers a field prefix`,
      new RegExp(`\\n  ${kind}: "`).test(prefixBlock),
      "GST_IMPORT_PREFIX",
    );
    check(
      `${kind}: the extension declares required fields`,
      requiredFieldsBlock.includes(`  ${kind}: [`),
      "SMART_IMPORT_REQUIRED_FIELDS",
    );
    check(
      `${kind}: the extension has a card with live Preview and Apply buttons`,
      extensionHtml.includes(`data-gst-import-form="${kind}"`)
        && extensionHtml.includes(`data-gst-preview="${kind}"`)
        && extensionHtml.includes(`data-gst-commit="${kind}"`),
      "workspace.html",
    );

    // The desktop: offered in the kind list and given a field definition, or its picker shows a
    // kind whose columns cannot be mapped.
    check(
      `${kind}: the desktop offers the kind`,
      desktopWrites.includes(`"${kind}"`),
      "ImportWriteVocabulary.GstKinds",
    );
    check(
      `${kind}: the desktop defines its fields`,
      desktopDefinesFields(kind),
      "ImportWriteVocabulary.Fields",
    );
    check(
      `${kind}: the desktop names the kind in plain words`,
      desktopPage.includes(`"${kind}" => "`),
      "KindOption",
    );
  }

  // Every element id the two new cards refer to must actually exist in the page, or the card
  // renders and its status line never updates.
  for (const prefix of ["gst1", "gstLedger"]) {
    for (const suffix of ["Name", "Text", "Mapping", "Status"]) {
      check(
        `the ${prefix}${suffix} element exists`,
        extensionHtml.includes(`id="${prefix}${suffix}"`),
        "workspace.html",
      );
    }
  }

  // The run-create payload must actually carry the two new batch ids, and the controller must
  // accept them. Either one missing makes every card above decorative.
  check(
    "the extension sends both new sources when it creates a run",
    extensionJs.includes("gstr1BatchId: gstImports.GSTR1_SUMMARY.batch?.id")
      && extensionJs.includes("creditLedgerBatchId: gstImports.ECREDIT_LEDGER.batch?.id"),
    "createGstRun",
  );
  check(
    "the create controller accepts both new sources",
    CREATE_FIELDS_SOURCE.includes('"gstr1BatchId"')
      && CREATE_FIELDS_SOURCE.includes('"creditLedgerBatchId"'),
    "CREATE_FIELDS",
  );
}

// ─── the clients require exactly what the server requires ─────────

// A client asking for fewer columns than the server needs sends a file the server refuses AFTER
// the person has done the work; a client asking for more refuses a file the server would have
// accepted. Both are the same bug, and comparing the lists catches both.
{
  const extensionJs = readFileSync(
    new URL("../../audit-nlp-extension/workspace.js", import.meta.url),
    "utf8",
  );

  // Read the extension's own table rather than restating it: a test that restates the value it
  // checks proves nothing about the file that ships.
  const requiredBlock = extensionJs.slice(
    extensionJs.indexOf("const SMART_IMPORT_REQUIRED_FIELDS"),
    extensionJs.indexOf("const SMART_IMPORT_EXTRA_ALLOWED_FIELDS"),
  );

  for (const kind of ["GSTR3B_SUMMARY", "GSTR1_SUMMARY", "ECREDIT_LEDGER"]) {
    const start = requiredBlock.indexOf(`  ${kind}: [`);
    const declared = (
      requiredBlock.slice(start, requiredBlock.indexOf("]", start)).match(/"[a-zA-Z]+"/g) || []
    ).map((quoted) => quoted.slice(1, -1));
    const expected = GST_IMPORT_SPECS[kind].required;

    check(
      `${kind}: the extension requires exactly what the server requires`,
      declared.length === expected.length && expected.every((field) => declared.includes(field)),
      `client [${declared.join(", ")}] vs server [${expected.join(", ")}]`,
    );
  }
}


// ─── the extension's matcher defers to the server's dictionary ─────

// The extension ranks headings against a field's own LABEL; the server ranks them against a
// synonym dictionary. Consolidating the two means the server's answer wins where it has one, the
// local ranker still fills the rest, and neither can leave two fields fighting over one heading.
//
// This runs the SHIPPED function out of workspace.js rather than a copy of it. The extension is a
// classic content script with no exports, so the slice that defines the matcher is evaluated in a
// sandbox. The functions it names but does not call at definition time (gstApi, byId,
// smartRenderMatcher) are never reached here.
{
  const source = readFileSync(
    new URL("../../audit-nlp-extension/workspace.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function smartNormalize(");
  const end = source.indexOf("function smartRefreshUsedColumns(");
  const sandbox = { console };
  runInNewContext(
    `${source.slice(start, end)};this.smartBuildColumnPlan = smartBuildColumnPlan;`,
    sandbox,
  );
  const plan = sandbox.smartBuildColumnPlan;

  check(
    "the matcher slice evaluates and exposes its column planner",
    typeof plan === "function",
    typeof plan,
  );

  const fields = {
    category: "Category",
    taxableValue: "Taxable Value",
    igst: "IGST",
    sgst: "SGST",
  };

  // Real GSTR-3B wording. "State/UT Tax" is what the portal calls SGST, and no amount of ranking
  // "SGST" against "State/UT Tax" finds it - that is precisely what the server dictionary is for.
  const headers = ["Nature of Supply", "Total Taxable Value", "Integrated Tax", "State/UT Tax"];

  const local = plan(fields, headers);
  check(
    "on its own the local ranker cannot match the portal's wording for SGST",
    !local.assignments.sgst,
    local.assignments.sgst || "unmatched, as expected",
  );

  const withServer = plan(fields, headers, {
    category: "Nature of Supply",
    taxableValue: "Total Taxable Value",
    igst: "Integrated Tax",
    sgst: "State/UT Tax",
  });
  check(
    "the server's dictionary matches all four columns the local ranker could not",
    withServer.assignments.category === "Nature of Supply"
      && withServer.assignments.taxableValue === "Total Taxable Value"
      && withServer.assignments.igst === "Integrated Tax"
      && withServer.assignments.sgst === "State/UT Tax",
    JSON.stringify(withServer.assignments),
  );

  // A heading the server names for one field must be taken away from any other field the local
  // ranker had given it to. The matcher disables a column already in use, so a duplicate would
  // strand a field on a value it could not change.
  const ambiguous = ["Taxable Value", "Value"];
  const contested = plan(
    { taxableValue: "Taxable Value", igst: "Value" },
    ambiguous,
    { igst: "Taxable Value" },
  );
  const assigned = Object.values(contested.assignments);
  check(
    "no two fields are left assigned to the same heading",
    new Set(assigned).size === assigned.length,
    JSON.stringify(contested.assignments),
  );
  check(
    "the server's claim on a contested heading is the one that stands",
    contested.assignments.igst === "Taxable Value"
      && contested.assignments.taxableValue !== "Taxable Value",
    JSON.stringify(contested.assignments),
  );

  // A stale or wrong suggestion naming a heading this file does not have is ignored rather than
  // written into the mapping, where it would fail validation as "a heading not present".
  const phantom = plan(fields, headers, { igst: "A Column That Is Not Here" });
  check(
    "a suggested heading the file does not contain is ignored",
    phantom.assignments.igst !== "A Column That Is Not Here",
    phantom.assignments.igst || "unassigned",
  );
}


// ─── the clients string-match the ledger basis, so pin it ─────────

// Both the desktop and the extension label a closing balance "(computed from movements)" by
// comparing ledgerBasis against a literal. Renaming that literal on the server would not fail any
// build: both clients would simply stop labelling, and a firm would read a balance CA PRO worked
// out itself as one the portal stated. The string is therefore pinned to the value the calculation
// actually produces, from a real ledger of each shape.
{
  const ledgerRow = (category, igst) => ({
    summaryCategory: category,
    igstMinor: igst,
    cgstMinor: 0,
    sgstMinor: 0,
    cessMinor: 0,
  });

  const computed = calculateCreditLedgerBalance([
    ledgerRow("OPENING_BALANCE", 100_000),
    ledgerRow("CREDIT", 50_000),
    ledgerRow("DEBIT", 20_000),
  ]);
  check(
    "a ledger with only movements reports COMPUTED_FROM_MOVEMENT, the literal both clients match",
    computed.basis === "COMPUTED_FROM_MOVEMENT" && computed.closing.igstMinor === 130_000,
    `${computed.basis}, igst ${computed.closing.igstMinor}`,
  );

  const statedOnly = calculateCreditLedgerBalance([ledgerRow("CLOSING_BALANCE", 130_000)]);
  check(
    "a ledger that states its closing balance reports STATED_IN_FILE",
    statedOnly.basis === "STATED_IN_FILE" && statedOnly.statedDiffers === false,
    `${statedOnly.basis}, statedDiffers ${statedOnly.statedDiffers}`,
  );

  // The stated figure wins, and the disagreement is reported rather than resolved.
  const contradicting = calculateCreditLedgerBalance([
    ledgerRow("OPENING_BALANCE", 100_000),
    ledgerRow("CREDIT", 50_000),
    ledgerRow("DEBIT", 20_000),
    ledgerRow("CLOSING_BALANCE", 999_999),
  ]);
  check(
    "a stated balance its own movements do not produce is flagged, and the stated figure is used",
    contradicting.basis === "STATED_IN_FILE"
      && contradicting.statedDiffers === true
      && contradicting.closing.igstMinor === 999_999
      && contradicting.computed.igstMinor === 130_000,
    `stated ${contradicting.closing.igstMinor} vs computed ${contradicting.computed.igstMinor}`,
  );

  // Both clients are read for the literal, so a rename on either side is caught here too.
  const desktopPage = readFileSync(
    new URL(
      "../../apps/desktop-native/src/CaPro.Desktop.App/Views/GstRunControlPage.xaml.cs",
      import.meta.url,
    ),
    "utf8",
  );
  const extensionJs = readFileSync(
    new URL("../../audit-nlp-extension/workspace.js", import.meta.url),
    "utf8",
  );
  check(
    "both clients match the same literal the server emits",
    desktopPage.includes('"COMPUTED_FROM_MOVEMENT"')
      && extensionJs.includes('"COMPUTED_FROM_MOVEMENT"'),
    "desktop and extension",
  );
}

// ─── report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nGST control reconciliation contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
