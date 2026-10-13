// tests/csv-export-guard-contract.mjs
//
// Why this exists. There was one csvCell copy per exporting surface and they had
// drifted: tds-health guarded only strings and tolerated leading whitespace,
// gst-reconciliation guarded every value including negative numbers, the panel's
// file-tools.js had no formula guard at all, and gstr2b-json's machine CSV used
// conditional quoting. IMPROVEMENT-PLAN-V2-2026-09-28 Part 5 Phase 0 item 2
// deduplicated them into src/utils/csv.js. This contract pins the merged
// semantics so the next exporter imports the helper instead of growing a fourth
// copy.
//
// Pure logic only — no database, no network.
//
// Run: node tests/csv-export-guard-contract.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { csvCell, csvCellMachine } from "../src/utils/csv.js";

const require = createRequire(import.meta.url);
const { csvCell: panelCsvCell } = require("../public/admin/file-tools.js");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ── csvCell: user-facing exports ─────────────────────────────────────────────

check("csvCell: always quotes every field", () => csvCell("plain") === '"plain"');

check("csvCell: doubles embedded quotes", () => csvCell('say "hi"') === '"say ""hi"""');

check("csvCell: guards leading = + @ on strings", () =>
  csvCell("=cmd") === "'=cmd" &&
  csvCell("+1+cmd|' /C calc'!A0") === "'+1+cmd|' /C calc'!A0" &&
  csvCell("@SUM(1)") === "'@SUM(1)");

check("csvCell: guards leading - on strings (negative-lookalike formulas)", () =>
  csvCell("-1+cmd|' /C calc'!A0") === "'-1+cmd|' /C calc'!A0");

check("csvCell: tolerates leading whitespace before the dangerous prefix", () =>
  csvCell("  =cmd") === "'  =cmd");

check("csvCell: leaves numbers unguarded so -500 stays numeric in Excel", () =>
  csvCell(-500) === '"-500"' && csvCell(0) === '"0"');

check("csvCell: null/undefined serialize as empty quoted field", () =>
  csvCell(null) === '""' && csvCell(undefined) === '""');

check("csvCell: already-guarded value is not double-prefixed", () =>
  csvCell("'=cmd") === "\"'=cmd\"");

// ── csvCellMachine: parser round-trip CSV ────────────────────────────────────

check("csvCellMachine: quotes only when the field needs it", () =>
  csvCellMachine("plain") === "plain" &&
  csvCellMachine("1,18,000.00") === '"1,18,000.00"' &&
  csvCellMachine('say "hi"') === '"say ""hi"""' &&
  csvCellMachine("line\nbreak") === '"line\nbreak"');

check("csvCellMachine: NO formula guard — a leading dash survives byte-exact", () =>
  csvCellMachine("-CN-1") === "-CN-1" && csvCellMachine("=x") === "=x");

// ── Panel file-tools.js (browser export path) ───────────────────────────────

check("panel csvCell: guards dangerous string prefixes, keeps conditional quoting", () =>
  panelCsvCell("=cmd") === "'=cmd" &&
  panelCsvCell("-2+3") === "'-2+3" &&
  panelCsvCell("plain") === "plain" &&
  panelCsvCell("a,b") === '"a,b"');

check("panel csvCell: leaves numbers unguarded", () =>
  panelCsvCell(-500) === "-500" && panelCsvCell(12) === "12");

// ── Drift guard: the services actually import the shared helper ─────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const rel of [
  "src/services/tds-health.service.js",
  "src/services/gst-reconciliation.service.js",
  "src/services/gstr2b-json.service.js",
]) {
  const source = readFileSync(join(root, rel), "utf8");
  check(
    `${rel}: no local csvCell copy remains (imports from utils/csv.js)`,
    !/function csvCell/.test(source) && source.includes("utils/csv.js"),
  );
}

// ── Verdict ──────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`csv-export-guard-contract: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
