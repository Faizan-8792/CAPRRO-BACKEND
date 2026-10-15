// tests/books-import-contract.mjs
//
// W10 AP5 (2026-10-15): the trial-balance import.
//
// WHY THIS EXISTS. Clause 44 needs the year's expenditure, and the only place it lives is the
// client's books. A trial balance is what every small client can export and what a CA asks for on
// day one of a tax audit, so it is the first books import. Pinned here:
//
//   PURE
//   - Tally Prime's Excel layout - a title block, "Particulars | Closing Balance" over
//     "(blank) | Debit | Credit", Dr and Cr columns, a Grand Total row - previews with 0 invalid rows
//     and every amount exact in paise, and the trial balance ties (debits equal credits);
//   - the two-row heading is read as one heading ONLY when the second row is all headings: a GST
//     register's first data row is never swallowed into its heading;
//   - the mapping takes one complete closing-balance layout or is refused; a Debit column alone is
//     refused, because it would read every credit balance as nil;
//   - a row named like a Tally group, in a file with no group column, is warned about;
//   - a kind nothing claims is refused, never normalised as GST; the GST family still has 5 kinds.
//   MONGO (scratch-marked, through the real app)
//   - preview -> signed token -> commit writes every row once; the same commit replays; the rows read
//     back exact; with auditPacks off, preview and commit answer 404 with featureFlag auditPacks.
//
// Run: node tests/books-import-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-books-import node tests/books-import-contract.mjs

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const { previewImport, suggestImportMapping } = await import("../src/services/import-preview.service.js");
const { shapeTable, isSubHeadingRow } = await import("../src/services/import-shape.service.js");
const { GST_IMPORT_KINDS } = await import("../src/models/ImportRow.js");
const { BOOKS_IMPORT_KINDS } = await import("../src/models/BooksImportRow.js");

// Tally Prime: Display More Reports > Trial Balance > F5 (ledger-wise) > export to Excel, saved as CSV.
const TALLY_TB = [
  "ABC Traders Pvt Ltd,,",
  "\"12, MG Road, Pune\",,",
  "Trial Balance,,",
  "1-Apr-2025 to 31-Mar-2026,,",
  "Particulars,Closing Balance,",
  ",Debit,Credit",
  "Capital Account,,\"25,00,000.00\"",
  "Sundry Creditors Control,,\"8,40,000.00\"",
  "Purchase of Goods,\"50,00,000.00\",",
  "Freight Inward,\"2,00,000.00\",",
  "Rent,\"6,00,000.00\",",
  "Salaries,\"12,00,000.00\",",
  "Depreciation,\"3,00,000.00\",",
  "Sales,,\"90,00,000.00\"",
  "Cash,\"40,000.00\",",
  "HDFC Bank,\"50,00,000.00\",",
  "Grand Total,\"1,23,40,000.00\",\"1,23,40,000.00\"",
].join("\n");

const suggested = suggestImportMapping({ kind: "TRIAL_BALANCE", text: TALLY_TB });
check("suggest: the two-row heading reads as Particulars, Closing Balance Debit, Closing Balance Credit",
  JSON.stringify(suggested.headers) === JSON.stringify(["Particulars", "Closing Balance Debit", "Closing Balance Credit"]),
  JSON.stringify(suggested.headers));
check("suggest: maps ledger and both closing sides, and is complete",
  suggested.suggestedMapping.ledgerName === "Particulars" &&
  suggested.suggestedMapping.closingDebit === "Closing Balance Debit" &&
  suggested.suggestedMapping.closingCredit === "Closing Balance Credit" &&
  suggested.complete === true,
  JSON.stringify(suggested.suggestedMapping));

const mapping = { ledgerName: "Particulars", closingDebit: "Closing Balance Debit", closingCredit: "Closing Balance Credit" };
const preview = previewImport({ kind: "TRIAL_BALANCE", text: TALLY_TB, mapping });
const byName = Object.fromEntries(preview.rows.map((row) => [row.values.ledgerName, row.values]));
check("preview: 10 ledgers, 0 invalid", preview.summary.totalRows === 10 && preview.summary.invalidRows === 0,
  JSON.stringify(preview.summary));
check("preview: the Grand Total row is skipped and reported, never imported",
  preview.shape.skipped.some((s) => s.reason === "TOTALS") && !byName["Grand Total"]);
check("preview: the title block and the two-row heading are reported",
  preview.shape.notes.some((n) => n.code === "PREAMBLE_ROWS_SKIPPED" && n.count === 4) &&
  preview.shape.notes.some((n) => n.code === "TWO_ROW_HEADING_MERGED"));
check("preview: debit balances read positive, credit balances negative, exact in paise",
  byName["Purchase of Goods"]?.closingMinor === 500000000 &&
  byName["Capital Account"]?.closingMinor === -250000000 &&
  byName.Sales?.closingMinor === -900000000 &&
  byName.Cash?.closingMinor === 4000000,
  JSON.stringify({ p: byName["Purchase of Goods"]?.closingMinor, c: byName["Capital Account"]?.closingMinor }));
check("preview: the trial balance ties - debits 1,23,40,000.00 equal credits",
  preview.summary.financialTotals?.closingDebitMinor === 1234000000 &&
  preview.summary.financialTotals?.closingCreditMinor === 1234000000 &&
  preview.summary.financialTotals?.differenceMinor === 0,
  JSON.stringify(preview.summary.financialTotals));

// A plain sheet kept by hand: Particulars | Group | Debit | Credit.
const PLAIN = ["Particulars,Group,Debit,Credit", "Rent,Indirect Expenses,\"6,00,000\",", "Sales,Sales Accounts,,6,00,000"].join("\n");
const plainSuggested = suggestImportMapping({ kind: "TRIAL_BALANCE", text: PLAIN });
check("plain sheet: Debit and Credit map to the closing sides and Group to the group",
  plainSuggested.suggestedMapping.closingDebit === "Debit" &&
  plainSuggested.suggestedMapping.closingCredit === "Credit" &&
  plainSuggested.suggestedMapping.groupName === "Group" && plainSuggested.complete === true,
  JSON.stringify(plainSuggested.suggestedMapping));
const plain = previewImport({ kind: "TRIAL_BALANCE", text: PLAIN, mapping: plainSuggested.suggestedMapping });
check("plain sheet: imports with its groups, no heading merged",
  plain.summary.invalidRows === 0 && plain.rows[0].values.groupName === "Indirect Expenses" &&
  !plain.shape.notes.some((n) => n.code === "TWO_ROW_HEADING_MERGED"));

// The layout rule.
let halfLayout = null;
try {
  previewImport({ kind: "TRIAL_BALANCE", text: TALLY_TB, mapping: { ledgerName: "Particulars", closingDebit: "Closing Balance Debit" } });
} catch (error) {
  halfLayout = error;
}
check("a Debit column without its Credit column is refused with the layouts named",
  halfLayout?.code === "IMPORT_MAPPING_MISSING_FIELDS" && /closingDebit and closingCredit/.test(halfLayout?.message || ""),
  halfLayout?.message);

// The group-total warning.
const GROUPED = ["Particulars,Debit,Credit", "Indirect Expenses,\"20,00,000\",", "Rent,\"6,00,000\","].join("\n");
const grouped = previewImport({ kind: "TRIAL_BALANCE", text: GROUPED, mapping: { ledgerName: "Particulars", closingDebit: "Debit", closingCredit: "Credit" } });
check("a row named like a Tally group, with no group column, is warned about",
  grouped.warnings.some((w) => w.code === "LOOKS_LIKE_GROUP_TOTAL" && w.row === 2), JSON.stringify(grouped.warnings));

// The two-row rule must not swallow a GST register's first invoice.
const gstGrid = [
  ["Supplier GSTIN", "Invoice Number", "Invoice Date", "Taxable Value", "IGST"],
  ["27AAAAA1111A1Z1", "INV-1", "01/04/2025", "1000", "180"],
];
check("a GST register's first data row is never read as part of its heading",
  !isSubHeadingRow(gstGrid[0], gstGrid[1]) && shapeTable(gstGrid).dataRows.length === 1);

// Kinds.
let unknownKind = null;
try {
  previewImport({ kind: "TRIAL_BALANCE_X", text: TALLY_TB, mapping });
} catch (error) {
  unknownKind = error;
}
check("a kind nothing claims is refused", /Unsupported preview kind/.test(unknownKind?.message || ""), unknownKind?.message);
check("the GST family still has exactly 5 kinds, and TRIAL_BALANCE is not one of them",
  GST_IMPORT_KINDS.length === 5 && !GST_IMPORT_KINDS.includes("TRIAL_BALANCE") && BOOKS_IMPORT_KINDS.includes("TRIAL_BALANCE"));

// ─── Through the real app ───────────────────────────────────────────────────

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
let mongoRan = false;
if (scratch) {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const ownerId = oid();
  const firmId = oid();
  const clientId = oid();
  await raw("users").insertOne({ _id: ownerId, email: "owner-books@scratch.test", name: "Owner Books", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, name: "Scratch Books Firm", displayName: "Scratch Books Firm", handle: "scratch-books", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `SCRATCHBOOKS${Date.now().toString(36).toUpperCase()}`, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: clientId, firmId, name: "ABC Traders Pvt Ltd", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: ownerId, email: "owner-books@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const previewBody = { kind: "TRIAL_BALANCE", text: TALLY_TB, mapping, clientId: String(clientId), financialYear: "2025-26" };
    const previewed = await call("POST", "/api/imports/preview", previewBody);
    const commitToken = previewed.json?.preview?.commitToken;
    const sourceHash = previewed.json?.preview?.sourceHash;
    check("live: preview answers 200 with a commit token", previewed.status === 200 && /^\d+\.[a-f0-9]{64}$/.test(commitToken || ""), `status ${previewed.status}`);
    const commitBody = { kind: "TRIAL_BALANCE", text: TALLY_TB, mapping, clientId: String(clientId), financialYear: "2025-26", previewToken: commitToken, sourceName: "TB FY 2025-26.xlsx" };
    const committed = await call("POST", `/api/imports/${sourceHash}/books-commit`, commitBody);
    check("live: commit answers 201 with a completed batch of 10 rows",
      committed.status === 201 && committed.json?.batch?.status === "COMPLETED" && committed.json?.batch?.validRows === 10,
      `status ${committed.status} ${JSON.stringify(committed.json)?.slice(0, 160)}`);
    const replay = await call("POST", `/api/imports/${sourceHash}/books-commit`, commitBody);
    check("live: the same commit replays (200, same batch), never a second copy",
      replay.status === 200 && replay.json?.replayed === true && replay.json?.batch?.id === committed.json?.batch?.id, `status ${replay.status}`);
    const rows = await raw("booksimportrows").find({ batchId: new mongoose.Types.ObjectId(committed.json?.batch?.id) }).toArray();
    check("live: every ledger was written once, under the batch's active generation",
      rows.length === 10 && rows.every((r) => r.importGeneration === committed.json?.batch?.activeImportGeneration));
    const purchase = rows.find((r) => r.ledgerName === "Purchase of Goods");
    check("live: amounts read back exact in paise", purchase?.closingMinor === 500000000 && purchase?.financialYear === "2025-26");
    const tampered = await call("POST", `/api/imports/${sourceHash}/books-commit`, { ...commitBody, financialYear: "2024-25" });
    check("live: a commit whose year changed after preview is refused 409", tampered.status === 409, `status ${tampered.status}`);
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("POST", "/api/imports/preview", previewBody);
    check("live: with auditPacks off the preview answers 404 naming the flag",
      off.status === 404 && off.json?.featureFlag === "auditPacks", `status ${off.status} ${JSON.stringify(off.json)}`);
    mongoRan = true;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\nbooks-import-contract: ${checks.length - failed.length}/${checks.length} passed${mongoRan ? " (scratch Mongo included)" : " (pure subset; no scratch MONGODB_URI)"}`);
process.exitCode = failed.length ? 1 : 0;
