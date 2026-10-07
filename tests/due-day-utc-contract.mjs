// tests/due-day-utc-contract.mjs - a due date typed in the admin panel is its UTC day (ledger C15).
//
// A deadline is a statutory day, kept as that day in UTC on both clients and the server
// (CLAUDE.md section 8). The firm admin board built `new Date(day + 'T00:00:00')` - local
// midnight - and sent its ISO form, which a browser in India sends as 18:30 UTC on the previous
// day; parseStatutoryDayIso keeps a full instant as sent, so the stored deadline was a day early
// on every client that reads it as a UTC day. The panel also rendered due dates in the viewer's
// own zone, one of them inside the chase message a CA copies to a client.
//
// This suite reads every script under public/ (folders included) and refuses:
//   - a date built from a day string plus a midnight time with no zone (local midnight);
//   - a due date rendered with toLocaleDateString/toLocaleString without timeZone UTC;
// and it RUNS admin.js's formatDueDay in two zones either side of UTC.
//
// USAGE
//   node tests/due-day-utc-contract.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${!ok && detail ? ` - ${detail}` : ""}`);
}

function scripts(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...scripts(path));
    else if (/\.(m?js|html)$/.test(name) && !/\.min\./.test(name)) out.push(path);
  }
  return out;
}

const files = scripts(PUBLIC).map((path) => ({ name: relative(PUBLIC, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));
check("the sweep reads the admin scripts", files.some((f) => f.name === "admin/admin-tasks.js") && files.some((f) => f.name === "admin/compliance-assistant/assistant.js"));

// 1. No local-midnight construction: a midnight time with no Z or offset after it.
const localMidnight = [];
for (const { name, text } of files) {
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    if (/T00:00(?::00(?:\.0+)?)?['"`]/.test(line)) localMidnight.push(`${name}:${index + 1}`);
  });
}
check("no date is built as local midnight", localMidnight.length === 0, localMidnight.join(", "));

// 2. Every rendered due date names timeZone UTC: a line that reads a due field and formats it.
const localDue = [];
for (const { name, text } of files) {
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    if (/due/i.test(line) && /toLocale(?:Date)?String\(/.test(line) && !/timeZone:\s*['"]UTC['"]/.test(line)) {
      localDue.push(`${name}:${index + 1}`);
    }
  });
}
check("no due date is rendered in the viewer's own zone", localDue.length === 0, localDue.join(", "));

// 3. The three admin surfaces go through the one formatter.
const byName = Object.fromEntries(files.map((f) => [f.name, f.text]));
check("admin-tasks.js renders the board's due dates with formatDueDay", /formatDueDay\(t\.dueDateISO\)/.test(byName["admin/admin-tasks.js"]));
check("assistant.js renders its due dates with formatDueDay", /formatDueDay\(t\.dueDateISO\)/.test(byName["admin/compliance-assistant/assistant.js"]));
check("admin.js renders reminders and the chase message with formatDueDay", (byName["admin/admin.js"].match(/formatDueDay\((?:r|item)\.dueDateISO\)/g) || []).length === 2);
check("the board sends the picker's day, not an instant", /const dueDateISO = dueDate;/.test(byName["admin/admin-tasks.js"]));

// 4. formatDueDay itself, run where local midnight and UTC midnight are different days.
const admin = byName["admin/admin.js"];
const start = admin.indexOf("function formatDueDay(");
const end = start >= 0 ? admin.indexOf("\n}", start) : -1;
const source = start >= 0 && end > start ? admin.slice(start, end + 2) : "";
check("admin.js defines formatDueDay", Boolean(source));
const probe = `${source}
const cases = [["2026-10-31T00:00:00.000Z", "31/10/2026"], ["2026-03-31T23:59:59.000Z", "31/3/2026"], ["2026-04-01", "1/4/2026"], ["", ""], ["not a date", ""]];
const got = cases.map(([iso]) => formatDueDay(iso));
console.log(JSON.stringify({ got, want: cases.map(([, want]) => want) }));`;
for (const zone of ["America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
  let result = null;
  try {
    result = JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop());
  } catch (_) {
    result = null;
  }
  // en-IN pads neither day nor month in Node's ICU ("1/4/2026"); the browser's does the same.
  // Compare the day, month and year as numbers so a padding difference cannot hide a wrong day.
  const norm = (text) => String(text || "").split("/").map(Number).join("/");
  const ok = Boolean(result) && result.got.length === result.want.length && result.got.every((g, i) => norm(g) === norm(result.want[i]));
  check(`formatDueDay gives the UTC day in ${zone}`, ok, result ? `got ${JSON.stringify(result.got)}` : String(run.stderr).slice(0, 300));
}

console.log(`\ndue day contract: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
