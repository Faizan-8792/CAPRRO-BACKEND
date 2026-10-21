// Mutations for the notice rule reader (W11 IN19, IN20, IN28).
//
//   node tools/mutation-harness.mjs tools/mutations/notice-rules.mjs
//
// One mutation blinds each form recogniser (seven GST forms, six income-tax notices): a suite that still passes
// with a recogniser that never fires does not prove it. The rest break the field rules a reply depends on and the
// verbatim-source guard, where every plausible error is a figure or a date nobody can trace to the notice.

export const target = "src/services/notice-rules/index.js";
export const suite = "tests/notice-rules-contract.mjs";

const NEVER = "detect: /(?!)/ }";

function blind(id, detect) {
  return { name: `${id} never recognised`, find: `${detect} }`, replace: NEVER, id };
}

export const mutations = [
  blind("1. GST_DRC01C", `detect: gstForm("(?:DRC|डीआरसी)", "01", "(?:C|सी)")`),
  blind("2. GST_DRC01A", `detect: gstForm("(?:DRC|डीआरसी)", "01", "(?:A|ए)")`),
  blind("3. GST_DRC07", `detect: gstForm("(?:DRC|डीआरसी)", "07")`),
  blind("4. GST_DRC01", `detect: gstForm("(?:DRC|डीआरसी)", "01")`),
  blind("5. GST_ASMT10", `detect: gstForm("(?:ASMT|एएसएमटी)", "10")`),
  blind("6. GST_REG03", `detect: gstForm("(?:REG|आरईजी)", "03")`),
  blind("7. GST_REG17", `detect: gstForm("(?:REG|आरईजी)", "17")`),
  blind("8. IT_143_1", `detect: itNotice(INTIMATION_WORD, "143\\\\s*\\\\(\\\\s*1\\\\s*\\\\)", { before: 20 })`),
  blind("9. IT_139_9", `detect: itNotice("(?:notice|communication|सूचना|नोटिस)", "139\\\\s*\\\\(\\\\s*9\\\\s*\\\\)")`),
  blind("10. IT_142_1", `detect: itNotice(NOTICE_WORD, "142\\\\s*\\\\(\\\\s*1\\\\s*\\\\)", { before: 20 })`),
  blind("11. IT_148A", `detect: itNotice(NOTICE_WORD, "148\\\\s*A", { before: 20 })`),
  blind("12. IT_133_6", `detect: itNotice(NOTICE_WORD, "133\\\\s*\\\\(\\\\s*6\\\\s*\\\\)", { before: 20 })`),
  blind("13. IT_245", `detect: itNotice("(?:intimation|notice|सूचना|आसूचना)", "245(?![\\\\p{N}])", { before: 20 })`),
  {
    name: "14. the DIN is never read",
    find: `return match ? { value: match[1], sourceText: excerpt(text, match), ruleId: "DIN" } : null;`,
    replace: "return null;",
  },
  {
    name: "15. a demand followed by Cr or thousand is read as rupees",
    find: "if (!match || UNSCALED_MAGNITUDE.test(text.slice(match.index + match[0].length))) return null;",
    replace: "if (!match) return null;",
  },
  {
    name: "16. the reply-by date is never read",
    find: `return value ? { value, sourceText: excerpt(text, match), ruleId: "REPLY_BY" } : null;`,
    replace: "return null;",
  },
  {
    name: "17. the issue date is never read",
    find: `return value ? { value, sourceText: excerpt(text, match), ruleId: "ISSUE_DATE" } : null;`,
    replace: "return null;",
  },
  {
    name: "18. the assessment year is never read",
    find: `return value ? { value, sourceText: excerpt(text, match), ruleId: "AY" } : null;`,
    replace: "return null;",
  },
  {
    name: "19. the financial year is never read",
    find: `return value ? { value, sourceText: excerpt(text, match), ruleId: "FY" } : null;`,
    replace: "return null;",
  },
];
