// src/services/audit-pack-engine/rule11g.engine.js
//
// W10 AP30 (2026-10-17). The evidence sheet for Rule 11(g) of the Companies (Audit and Auditors) Rules, 2014 - the
// audit trail (edit log) of the accounting software - built from the difference between two exports of the same
// year's books. It says, in words, what that difference shows and what it cannot, and leaves the conclusion to a
// person.
//
// THE WORDING CONTRACT. This sheet never says, anywhere, that the audit trail was verified, checked, confirmed or
// found intact, and it never says the feature operated. Two exports of a ledger cannot show that: they show which
// vouchers differ between the two dates. The rows describe a comparison; the only sentences about the audit trail
// feature itself are the person's, chosen as "My conclusion: ..." on the last row. tests/rule11g-contract.mjs scans
// every word this engine can emit for the banned words and fails the gates if one appears.
//
// PURE: no I/O. The comparison itself is books-snapshot.service.js diffSnapshots.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";

export const RULE11G_RULE_VERSION = "rule11g-v1";

const makeRow = rowFactory(RULE11G_RULE_VERSION, "Rule 11(g)");

export const CHOICES = Object.freeze({
  NOTED: choice("NOTED", "Noted: I have read this part of the comparison"),
  FOLLOW_UP: choice("FOLLOW_UP", "To follow up with the entity", { needsNote: true }),
  OPERATED_NO_INSTANCE: choice("OPERATED_NO_INSTANCE", "My conclusion: the software has the feature, it operated throughout the year for all transactions, and I came across no instance of it being tampered with", { needsNote: true }),
  EXCEPTION: choice("EXCEPTION", "My conclusion: the feature was not enabled, did not operate throughout the year, or I came across an instance of it being tampered with", { needsNote: true }),
  NOT_AVAILABLE: choice("NOT_AVAILABLE", "My conclusion: the software does not have such a feature", { needsNote: true }),
  CANNOT_CONCLUDE: choice("CANNOT_CONCLUDE", "My conclusion: I cannot yet conclude", { needsNote: true }),
});

/** What the comparison cannot show. Each sentence is a limit, not a finding; none says anything about the feature itself. */
export const LIMITS = Object.freeze([
  "It compares two exports of the books for the same year. It lists the vouchers that differ between the two dates and nothing about any other date.",
  "It does not show who made a change, when it was made, or whether the software recorded it.",
  "A change made and undone between the two exports is not visible, and neither is anything done before the earlier export.",
  "It cannot show whether the software has the feature, whether the feature was switched on for the whole year, or whether the record the feature keeps is complete.",
  "A voucher that differs is a voucher that differs. Whether the difference is a normal later entry or something else is for your enquiry of the entity.",
]);

const DAY = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "not known");
const text = (label, value) => ({ label, value, kind: "text" });
const count = (label, value) => ({ label, value: String(value), kind: "text" });
const snapshotSource = (id) => ({ kind: "BOOKS_SNAPSHOT", batchId: String(id), rowId: String(id), sourceRow: 0 });

/**
 * @param {object} input
 * @param {string} input.snapshotId          the later export (the one the pack was made on)
 * @param {string} input.earlierSnapshotId   the earlier export of the same year
 * @param {object} input.diff                books-snapshot.service.js diffSnapshots(...)
 */
export function buildRule11gRows({ snapshotId, earlierSnapshotId, diff }) {
  const rows = [];
  const sources = [snapshotSource(earlierSnapshotId), snapshotSource(snapshotId)];
  const c = diff.counts;

  rows.push(makeRow({
    section: "COMPARISON",
    identity: "comparison",
    label: "What differs between the two exports",
    values: {
      earlierTakenOn: DAY(diff.base.createdAt),
      laterTakenOn: DAY(diff.other.createdAt),
      earlierVouchers: diff.base.counts.vouchers,
      laterVouchers: diff.other.counts.vouchers,
      counts: c,
      alteredFields: diff.alteredFields,
      changedAfterBaseAlterId: diff.changedAfterBaseAlterId,
      truncated: Boolean(diff.truncated),
      amountMinor: null,
      lines: [
        text("Earlier export taken (UTC date)", DAY(diff.base.createdAt)),
        text("Later export taken (UTC date)", DAY(diff.other.createdAt)),
        count("Vouchers in the earlier export", diff.base.counts.vouchers),
        count("Vouchers in the later export", diff.other.counts.vouchers),
        count("Vouchers in the later export and not the earlier", c.inserted),
        count("Vouchers in the earlier export and not the later", c.deleted),
        count("Vouchers in both that differ", c.altered),
        count("Vouchers in both that are the same", c.unchanged),
        count("Of those that differ or were added, entered with a number higher than any in the earlier export", diff.changedAfterBaseAlterId),
      ],
      choices: [CHOICES.NOTED],
    },
    ruleHits: [hit("COMPARISON", `Vouchers are matched between the two exports by their record key and compared line by line. ${c.inserted} added, ${c.deleted} removed and ${c.altered} changed between ${DAY(diff.base.createdAt)} and ${DAY(diff.other.createdAt)}.${diff.truncated ? " The lists below show the first 200 of each." : ""}`)],
    state: "COMPUTED",
    sources,
  }));

  const group = (identity, label, total, samples, extra = {}) => {
    if (!total) return;
    rows.push(makeRow({
      section: "COMPARISON",
      identity,
      label: `${label}: ${total}`,
      values: {
        total,
        shown: samples.length,
        samples,
        ...extra,
        amountMinor: null,
        lines: [
          count("Vouchers", total),
          count("Listed here", samples.length),
          ...samples.slice(0, 10).map((s) => text(`${s.date || "no date"} ${s.type || ""} ${s.number || ""}`.trim(), s.changed ? `changed: ${s.changed.join(", ")}` : "")),
        ],
        choices: [CHOICES.NOTED, CHOICES.FOLLOW_UP],
      },
      ruleHits: [hit("LISTED", "Each voucher listed is one that differs between the two exports. This row does not say why.")],
      state: "COMPUTED",
      sources,
    }));
  };
  group("added", "Vouchers in the later export and not the earlier", c.inserted, diff.samples.inserted);
  group("removed", "Vouchers in the earlier export and not the later", c.deleted, diff.samples.deleted);
  group("changed", "Vouchers in both exports that differ", c.altered, diff.samples.altered, { alteredFields: diff.alteredFields });

  rows.push(makeRow({
    section: "COMPARISON",
    identity: "limits",
    label: "What this comparison cannot show",
    values: { amountMinor: null, lines: LIMITS.map((l, i) => text(`Limit ${i + 1}`, l)), choices: [] },
    ruleHits: LIMITS.map((l) => hit("LIMIT", l)),
    state: "COMPUTED",
    derived: true,
  }));

  rows.push(makeRow({
    section: "CONCLUSION",
    identity: "conclusion",
    label: "Your conclusion on Rule 11(g)",
    values: {
      amountMinor: null,
      lines: [text("Whose conclusion", "Yours alone. Nothing in this pack answers it.")],
      choices: [CHOICES.OPERATED_NO_INSTANCE, CHOICES.EXCEPTION, CHOICES.NOT_AVAILABLE, CHOICES.CANNOT_CONCLUDE],
    },
    ruleHits: [hit("YOURS", "Rule 11(g) asks whether the company used accounting software with a feature of recording an audit trail of each change, whether it operated throughout the year for all transactions, and whether you came across any instance of it being tampered with. That rests on your enquiries, the software's own reports and your tests; the comparison above is one input to it.")],
    state: "COMPUTED",
    sources,
  }));
  return { rows };
}
