// tests/admin-type-scale.mjs - the admin panel's type scale (ledger task DS2).
//
// admin.css (the firm panel and the super panel share it) sets no text
// below 12px, uses regular (400) and semibold (600) only, a 14px body, a font
// stack led by IBM Plex Sans (DS24: the design system's, served from this site) with no web font
// fetched from another host,
// and tabular figures for the panel's figures so digits line up. The
// extension's pages are held to the same rules by
// audit-nlp-extension/tests/type-scale.focused.test.mjs.
//
// USAGE
//   node tests/admin-type-scale.mjs
import { readdirSync, readFileSync } from "node:fs";
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
// DS24 moved the panels onto the design system's face: admin.css names the token, the token sheet
// leads it with IBM Plex Sans and keeps the system faces behind it, and both pages load the font
// sheet, whose files sit beside it on this site.
const tokenSheet = readFileSync(join(HERE, "..", "public", "admin", "capro-tokens.css"), "utf8");
const fontSheet = readFileSync(join(HERE, "..", "public", "admin", "ui", "capro-fonts.css"), "utf8");
const pages = ["admin.html", "super.html"].map((name) => readFileSync(join(HERE, "..", "public", "admin", name), "utf8"));
check("the stack is the design system's, led by IBM Plex Sans",
  /--font:\s*var\(--capro-font-ui\);/.test(css) &&
    /--capro-font-ui:\s*"IBM Plex Sans", "Segoe UI Variable", "Segoe UI", system-ui,/.test(tokenSheet) &&
    pages.every((page) => /href="ui\/capro-fonts\.css(\?v=\d+)?"/.test(page)));
const fontSources = [...fontSheet.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]);
check("no web font fetched from another host",
  !/@import\s+url\(['"]?https?:/.test(css) && fontSources.length > 0 && fontSources.every((src) => /^fonts\//.test(src)),
  `font files: ${fontSources.join(", ")}`);

for (const selector of [".kpi-value", ".st-group-count"]) {
  const at = css.indexOf(`${selector} {`);
  const block = at >= 0 ? css.slice(at, css.indexOf("}", at)) : "";
  check(`${selector} is set in tabular figures`, /font-variant-numeric:\s*tabular-nums/.test(block));
}

// The same rules for the styles written inline in the panels' pages and scripts. This test read
// admin.css alone, and the super panel carried 25 inline sizes below 12px and 28 bold weights in
// super.html and super.js (found and raised, or removed with the old charts, in DS10). Every page and script under public/admin
// is read now, so an inline style cannot slip under the scale either.
const ADMIN_DIR = join(HERE, "..", "public", "admin");
const inlineSources = readdirSync(ADMIN_DIR)
  .filter((name) => /\.(html|js)$/.test(name) && !/\.min\./.test(name))
  .map((name) => ({ name, text: readFileSync(join(ADMIN_DIR, name), "utf8") }));
const inlineSmall = [];
const inlineHeavy = [];
for (const { name, text } of inlineSources) {
  for (const [, value, unit] of text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|rem)\b/g)) {
    const px = unit === "rem" ? Number(value) * 16 : Number(value);
    if (px < 12) inlineSmall.push(`${name} ${value}${unit}`);
  }
  for (const [, weight] of text.matchAll(/font-weight:\s*([a-z0-9]+)/g)) {
    if (!["400", "600", "normal", "inherit"].includes(weight)) inlineHeavy.push(`${name} ${weight}`);
  }
}
check(`no inline text below 12px in ${inlineSources.length} panel pages and scripts`, inlineSmall.length === 0, `found ${inlineSmall.join(", ")}`);
check("inline weights are regular and semibold only", inlineHeavy.length === 0, `found ${inlineHeavy.join(", ")}`);

console.log(`\npassed: ${passed}  failed: ${failed}`);
if (failed) process.exit(1);
console.log("ADMIN TYPE SCALE OK");
