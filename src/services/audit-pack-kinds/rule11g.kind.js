// src/services/audit-pack-kinds/rule11g.kind.js
//
// W10 AP30 (2026-10-17): the Rule 11(g) evidence sheet as a pack. It is made on the later of two exports of the same
// year's books and compares it with the earlier. The rules and words are rule11g.engine.js; this file is the request
// it accepts and the columns of its filing sheet.

import { CHOICES, RULE11G_RULE_VERSION, buildRule11gRows } from "../audit-pack-engine/rule11g.engine.js";
import { diffSnapshots } from "../books-snapshot.service.js";
import { defineFindingKind } from "./finding-kind.js";

const answerWords = Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label]));

export const rule11gKind = defineFindingKind({
  kind: "RULE11G",
  label: "Rule 11(g): the audit trail evidence sheet",
  ruleVersion: RULE11G_RULE_VERSION,
  earlierSnapshot: {
    field: "earlierSnapshotId",
    label: "An earlier export of the same year's books",
    help: "A sealed snapshot of the same client and financial year that was taken before the one above. The two are compared.",
  },
  sections: [
    { code: "COMPARISON", label: "What differs, and what the comparison cannot show" },
    { code: "CONCLUSION", label: "Your conclusion" },
  ],

  async build({ run, snapshot, params }) {
    const diff = await diffSnapshots({ firmId: run.firmId, baseId: params.earlierSnapshotId, otherId: String(snapshot._id) });
    return buildRule11gRows({ snapshotId: String(snapshot._id), earlierSnapshotId: params.earlierSnapshotId, diff });
  },

  reportChoices: Object.values(CHOICES).map((c) => c.value),
  filingColumns: [
    { header: "Item", width: 70, cell: (r) => r.label },
    { header: "Your answer", width: 90, cell: (r) => answerWords[r.choice] || r.choice },
    { header: "Your note", width: 90, cell: (r) => r.stored?.decision?.note || "" },
  ],
  choiceWords: answerWords,
  filePrefix: "rule-11g-evidence",
  readMe: [
    ["What this is", "A comparison of two exports of the same year's books, and your conclusion on Rule 11(g). The comparison lists the vouchers that differ between the two dates. It is evidence for your enquiries and tests, not a result of them."],
    ["What it cannot show", "Who made a change, when, or whether the software recorded it; anything outside the two dates; and whether the software has the feature, had it switched on throughout the year, or keeps a complete record. The limits are listed on the sheet."],
    ["Your conclusion", "The last row is yours alone. Every answer on it is worded as your conclusion, and every one needs your note."],
  ],
});
