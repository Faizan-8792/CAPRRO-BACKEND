// Mutations for the GST cause engine (W11 IN8, IN9, IN10).
//
//   node tools/mutation-harness.mjs tools/mutations/gst-cause.mjs
//
// One mutation takes each rule out of the engine (R1-R7): a suite that still passes without a rule does not
// prove that rule. Three more move the edges that carry professional meaning: R5's 4-45 day window, R1's
// "a character or two" distance, and R4's tolerance on the taxable value.

export const target = "src/services/gst-cause.service.js";
export const suite = "tests/gst-cause-engine.mjs";

const RULES = "const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR6, ruleR4, ruleR3, ruleR5]);";

export const mutations = [
  { name: "1. R1 (GSTIN typo) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR2, ruleR6, ruleR4, ruleR3, ruleR5]);" },
  { name: "2. R2 (another period's run) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR1, ruleR6, ruleR4, ruleR3, ruleR5]);" },
  { name: "3. R3 (invoice number format) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR6, ruleR4, ruleR5]);" },
  { name: "4. R4 (IGST against CGST plus SGST) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR6, ruleR3, ruleR5]);" },
  { name: "5. R5 (goods-receipt date) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR6, ruleR4, ruleR3]);" },
  { name: "6. R6 (credit or debit note) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR4, ruleR3, ruleR5]);" },
  { name: "7. R7 (duplicate in books) removed", find: RULES, replace: "const RULES = Object.freeze([ruleR1, ruleR2, ruleR6, ruleR4, ruleR3, ruleR5]);" },
  {
    name: "8. R5's window has no upper edge",
    find: "if (!Number.isInteger(days) || days < R5_MIN_DAYS || days > R5_MAX_DAYS) return null;",
    replace: "if (!Number.isInteger(days) || days < R5_MIN_DAYS) return null;",
  },
  {
    name: "9. R1 links GSTINs any distance apart",
    find: "if (!(distance <= 2 || (checksumPoints && distance <= 3))) continue;",
    replace: "if (!(distance <= 15 || checksumPoints)) continue;",
  },
  {
    name: "10. R4 ignores the taxable value",
    find: "  if (!near(b.taxable, p.taxable)) return null;\n  const bCs = b.cgst + b.sgst;",
    replace: "  const bCs = b.cgst + b.sgst;",
  },
];
