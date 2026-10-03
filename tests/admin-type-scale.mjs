// tests/admin-type-scale.mjs - the admin panel's type scale (ledger task DS2).
//
// admin.css (the firm panel and the super panel share it) sets no text
// below 12px, uses regular (400) and semibold (600) only, a 14px body, a font
// stack led by Segoe UI Variable with no web font fetched from another host,
// and tabular figures for the panel's figures so digits line up. The
// extension's pages are held to the same rules by
// audit-nlp-extension/tests/type-scale.focused.test.mjs.
//
// USAGE
//   node tests/admin-type-scale.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "..", "public", "admin", "admin.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${!ok && detail ? ` - ${detail}` : ""}`);
}

const sizes = [];
for (const [, value, unit] of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|rem)\b/g)) sizes.push(unit === "rem" ? Number(value) * 16 : Number(value));
const small = sizes.filter((px) => px < 12);
check("no text below 12px", small.length === 0, `found ${small.join(", ")}px`);

const weights = [...new Set([...css.matchAll(/font-weight:\s*([a-z0-9]+)/g)].map((m) => m[1]))].filter((w) => !["400", "600", "normal", "inherit"].includes(w));
check("regular and semibold only", weights.length === 0, `found ${weights.join(", ")}`);

const body = css.slice(css.indexOf("\nbody {"));
check("a 14px body", /^[^}]*font-size:\s*14px/.test(body.slice(0, body.indexOf("}") + 1)));
check("the stack is led by Segoe UI Variable", /--font:\s*"Segoe UI Variable", "Segoe UI", system-ui,/.test(css));
check("no web font fetched from another host", !/@import\s+url\(['"]?https?:/.test(css));

for (const selector of [".kpi-value", ".st-group-count"]) {
  const at = css.indexOf(`${selector} {`);
  const block = at >= 0 ? css.slice(at, css.indexOf("}", at)) : "";
  check(`${selector} is set in tabular figures`, /font-variant-numeric:\s*tabular-nums/.test(block));
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
if (failed) process.exit(1);
console.log("ADMIN TYPE SCALE OK");
