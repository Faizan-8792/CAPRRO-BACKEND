// src/services/ai/tasks/import-mapping-suggest.js
//
// W11 IN15: which of a file's column headings holds each required field the heading synonyms could not place.
// The model sees the heading TEXTS and, per column, what share of the cells look like a date, a number, a GSTIN
// or are empty - never a cell value. The answer names a heading by its ref for each field, or NONE, and is
// then checked by the same mapping validation a person's mapping goes through.

import { fail, isPlainObject } from "../ai-validate.js";

export default {
  name: "import_mapping_suggest",
  operation: "import_mapping_suggest",
  surface: "import_mapping",
  promptVersion: "import-mapping-v1",
  batchSize: 1,
  maxUnits: 1,
  temperature: 0,
  timeoutMs: 25000,
  maxTokensFor: () => 700,
  system: [
    "Task: match the column headings of a spreadsheet exported from Indian accounting software (Tally, Busy, Zoho, Marg and others) to the fields an import needs.",
    "Each heading has a ref, its text, and the share of its cells that look like a date, a number, a GSTIN, or are empty (0 to 100).",
    "Each field has a name and a description. Map a field only when the heading clearly holds it; otherwise answer NONE for that field.",
    "Never map one heading to two fields.",
  ].join("\n"),
  instructions:
    'Answer as {"items":[{"id":"<the item id>","mappings":[{"field":"<field name>","headingRef":"<heading ref or NONE>"}]}]}, with one entry per field listed in fieldsToMap.',
  validate(item, facts) {
    if (!Array.isArray(item.mappings)) fail("mappings is not a list");
    const fields = new Set((facts.fieldsToMap || []).map((field) => field.name));
    const refs = new Set((facts.headings || []).map((heading) => heading.ref));
    const usedRefs = new Set();
    const seenFields = new Set();
    const mappings = [];
    for (const entry of item.mappings) {
      if (!isPlainObject(entry)) fail("a mapping is not an object");
      const { field, headingRef } = entry;
      if (typeof field !== "string" || !fields.has(field)) fail("a mapping names a field that was not asked for");
      if (seenFields.has(field)) fail("a field is mapped twice");
      seenFields.add(field);
      if (headingRef === "NONE") {
        mappings.push({ field, headingRef: "NONE" });
        continue;
      }
      if (typeof headingRef !== "string" || !refs.has(headingRef)) fail("a mapping names a heading that was not sent");
      if (usedRefs.has(headingRef)) fail("one heading is mapped to two fields");
      usedRefs.add(headingRef);
      mappings.push({ field, headingRef });
    }
    return { output: { mappings }, abstained: mappings.every((entry) => entry.headingRef === "NONE") };
  },
};
