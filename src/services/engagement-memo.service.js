// src/services/engagement-memo.service.js
//
// W10 AP37 (2026-10-17). Drafted materiality, sampling and significant-matters memos.
//
// A memo is ASSEMBLED, not generated: a fixed template filled from the engagement team's own inputs and
// from what the packs recorded, with every figure computed in integer paise by BigInt from those inputs.
// No model is asked to write any of it, so a memo can state nothing its inputs do not (the plan allowed an
// AI draft; this is the safer reading and it works while the provider key is unset - recorded as a
// deviation on the ledger). The inputs are kept and listed on the memo itself, the team can edit the text,
// and the memo is a DRAFT FOR REVIEW until the engagement's assigned reviewer signs it. Signing records
// that a named person reviewed that exact text (its hash is kept); it checks nothing in it.
//
// WORDING CONTRACT: a memo this service assembles never says "we conclude", "verified", "complies" or a
// kin of them. findForbiddenWording() is the one definition, and the builders refuse to return text it
// matches, so a future edit to a template cannot ship such a sentence.

import crypto from "node:crypto";
import AuditPackRow from "../models/AuditPackRow.js";
import AuditPackRun from "../models/AuditPackRun.js";
import Client from "../models/Client.js";
import EngagementAssurance, { ASSURANCE_LIMITS, MEMO_KINDS } from "../models/EngagementAssurance.js";
import User from "../models/User.js";
import { getPackKind } from "./audit-pack-kinds/index.js";
import { assuranceKit } from "./engagement-assurance.service.js";
import { httpError, mutationKey as readMutationKey, objectId } from "./case-validation.service.js";
import { rupeesText } from "../utils/rupees.js";

export const MEMO_DRAFT_LABEL = "DRAFT FOR REVIEW";
const MAX_TEXT = 20000;
const MIN_TEXT = 20;
const MAX_SELECTED_LISTED = 40;
const MAX_OPEN_LISTED = 30;
const MAX_RUNS = 10;

// ── Wording contract ───────────────────────────────────────────────────────────────────────────

const FORBIDDEN_WORDING = /\bwe\s+conclude\b|\bconcluded\b|\bverified\b|\bcomplies\b|\bcomplied\b|\bcompliant\b|\bin\s+our\s+opinion\b|\bcertif(?:y|ies|ied)\b/i;

/** The first forbidden phrase in a text, or null. */
export function findForbiddenWording(text) {
  const match = FORBIDDEN_WORDING.exec(String(text ?? ""));
  return match ? match[0] : null;
}

/**
 * The wording contract applies to what THIS service writes. The team's own words (a rationale, a method),
 * the client's and the engagement's names and the labels a pack produced are removed before the check, so a
 * CA who writes "benchmark verified against the trial balance" is quoted faithfully, while a template that
 * says it is refused.
 */
export function guarded(built, theirWords = []) {
  let scanned = `${built.title}\n${built.text}`;
  for (const words of theirWords) {
    if (typeof words === "string" && words.length > 0) scanned = scanned.split(words).join(" ");
  }
  const found = findForbiddenWording(scanned);
  if (found) throw new Error(`A memo template says "${found}", which a drafted memo must never say`);
  return built;
}

// ── Pure: inputs and templates ─────────────────────────────────────────────────────────────────

const percentText = (basisPoints) => {
  const whole = Math.floor(basisPoints / 100);
  const frac = basisPoints % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%` : `${whole}%`;
};

const freeText = (value, max, label, { required = false } = {}) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && text.length < 2) throw httpError(400, `${label} is required.`);
  if (text.length > max) throw httpError(400, `${label} is at most ${max} characters.`);
  return text;
};

const basisPoints = (value, label, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw httpError(400, `${label} is required.`);
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw httpError(400, `${label} must be a whole number of basis points from 1 to 10000 (100 = 1%).`);
  return value;
};

/** Validates the engagement team's materiality inputs. The amount is integer paise. */
export function readMaterialityInputs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw httpError(400, "Materiality needs its inputs.");
  const benchmarkAmountMinor = raw.benchmarkAmountMinor;
  if (!Number.isSafeInteger(benchmarkAmountMinor) || benchmarkAmountMinor < 0) {
    throw httpError(400, "The benchmark amount must be a whole number of paise, zero or more.");
  }
  return {
    benchmarkName: freeText(raw.benchmarkName, 120, "The benchmark", { required: true }),
    benchmarkAmountMinor,
    percentageBasisPoints: basisPoints(raw.percentageBasisPoints, "The percentage", { required: true }),
    performanceBasisPoints: basisPoints(raw.performanceBasisPoints, "The performance materiality percentage"),
    trivialBasisPoints: basisPoints(raw.trivialBasisPoints, "The clearly-trivial percentage"),
    rationale: freeText(raw.rationale, 3000, "The reasons"),
  };
}

const fractionOf = (amountMinor, bp) => Number((BigInt(amountMinor) * BigInt(bp)) / 10000n);

const header = (title, clientName, engagement) =>
  `${title.toUpperCase()} - ${MEMO_DRAFT_LABEL}\nClient: ${clientName || "(not named)"}\nEngagement: ${engagement.title || ""}${engagement.period ? `\nPeriod: ${engagement.period}` : ""}`;

export function buildMaterialityMemo({ inputs, clientName, engagement }) {
  const overall = fractionOf(inputs.benchmarkAmountMinor, inputs.percentageBasisPoints);
  const performance = inputs.performanceBasisPoints === null ? null : fractionOf(overall, inputs.performanceBasisPoints);
  const trivial = inputs.trivialBasisPoints === null ? null : fractionOf(overall, inputs.trivialBasisPoints);
  const inputsListed = [
    { label: "Benchmark", value: inputs.benchmarkName },
    { label: "Benchmark amount", value: rupeesText(inputs.benchmarkAmountMinor) },
    { label: "Percentage applied to the benchmark", value: percentText(inputs.percentageBasisPoints) },
    ...(inputs.performanceBasisPoints === null ? [] : [{ label: "Performance materiality, as a percentage of overall", value: percentText(inputs.performanceBasisPoints) }]),
    ...(inputs.trivialBasisPoints === null ? [] : [{ label: "Clearly trivial threshold, as a percentage of overall", value: percentText(inputs.trivialBasisPoints) }]),
  ];
  const figures = [
    { label: "Overall materiality", value: rupeesText(overall), minor: overall, kind: "money" },
    ...(performance === null ? [] : [{ label: "Performance materiality", value: rupeesText(performance), minor: performance, kind: "money" }]),
    ...(trivial === null ? [] : [{ label: "Clearly trivial threshold", value: rupeesText(trivial), minor: trivial, kind: "money" }]),
  ];
  const text = [
    header("Materiality memo", clientName, engagement),
    "",
    "Inputs recorded (the engagement team's own):",
    ...inputsListed.map((i) => `- ${i.label}: ${i.value}`),
    "",
    "Figures computed from those inputs (amounts rounded down to the paisa):",
    ...figures.map((f) => `- ${f.label}: ${f.value} (${f.label === "Overall materiality" ? "benchmark amount x percentage" : "overall x percentage"})`),
    "",
    "The team's stated reasons for the benchmark and the percentage:",
    inputs.rationale || "None recorded.",
    "",
    "This memo is a draft assembled from the inputs above. It states no conclusion. The engagement reviewer reads it, edits it and signs it.",
  ].join("\n");
  return guarded({ title: "Materiality memo", inputsListed, figures, text }, [inputs.rationale, inputs.benchmarkName, clientName, engagement.title, engagement.period]);
}

/** Items the team chose to look at in a pack: confirmed rows with one of the kind's "report" answers. */
export function buildSamplingMemo({ inputs, clientName, engagement, run, kindLabel, selected }) {
  const total = selected.reduce((sum, row) => sum + (Number.isSafeInteger(row.values?.amountMinor) ? row.values.amountMinor : 0), 0);
  const withAmount = selected.filter((row) => Number.isSafeInteger(row.values?.amountMinor)).length;
  const inputsListed = [
    { label: "Pack", value: `${kindLabel || run.kind}, ${run.financialYear}` },
    { label: "Method, in the team's words", value: inputs.method },
    ...(inputs.populationNote ? [{ label: "Population, in the team's words", value: inputs.populationNote }] : []),
  ];
  const figures = [
    { label: "Items the team selected", value: String(selected.length), kind: "count" },
    { label: "Of these, with an amount", value: String(withAmount), kind: "count" },
    { label: "Total of those amounts", value: rupeesText(total), minor: total, kind: "money" },
  ];
  const listed = selected.slice(0, MAX_SELECTED_LISTED).map((row, i) => {
    const bits = [row.values?.voucherNumber, row.values?.date].filter(Boolean).join(" ");
    const amount = Number.isSafeInteger(row.values?.amountMinor) ? ` - ${rupeesText(row.values.amountMinor)}` : "";
    return `${i + 1}. ${row.label}${bits ? ` (${bits})` : ""}${amount}`;
  });
  const text = [
    header("Sampling memo", clientName, engagement),
    "",
    "Inputs recorded:",
    ...inputsListed.map((i) => `- ${i.label}: ${i.value}`),
    "",
    "Counted from the pack's recorded decisions (rows a person confirmed to be looked at):",
    ...figures.map((f) => `- ${f.label}: ${f.value}`),
    "",
    `Items selected${selected.length > MAX_SELECTED_LISTED ? ` (the first ${MAX_SELECTED_LISTED} of ${selected.length})` : ""}:`,
    ...listed,
    "",
    "The team's stated reasons for the selection:",
    inputs.rationale || "None recorded.",
    "",
    "This memo is a draft assembled from the inputs and decisions above. It states no conclusion. The engagement reviewer reads it, edits it and signs it.",
  ].join("\n");
  return guarded({ title: "Sampling memo", inputsListed, figures, text }, [inputs.rationale, inputs.method, inputs.populationNote, clientName, engagement.title, engagement.period, ...selected.map((row) => row.label), ...selected.map((row) => row.values?.voucherNumber)]);
}

/** Flags still open across the chosen packs, as counts and a short list. */
export function buildSignificantMattersMemo({ inputs, clientName, engagement, packs }) {
  const totals = packs.reduce(
    (t, p) => ({ open: t.open + p.open, gaps: t.gaps + p.gaps, reported: t.reported + p.reported }),
    { open: 0, gaps: 0, reported: 0 },
  );
  const inputsListed = [
    ...packs.map((p) => ({ label: "Pack", value: `${p.kindLabel || p.kind}, ${p.financialYear}` })),
    ...(inputs.matters ? [{ label: "Matters the team chose to carry, in its words", value: inputs.matters }] : []),
  ];
  const figures = [
    { label: "Flags still undecided", value: String(totals.open), kind: "count" },
    { label: "Items the packs could not complete for want of an input", value: String(totals.gaps), kind: "count" },
    { label: "Flags a person confirmed to be reported", value: String(totals.reported), kind: "count" },
  ];
  const lines = [];
  for (const p of packs) {
    lines.push(`${p.kindLabel || p.kind}, ${p.financialYear}: ${p.open} undecided, ${p.gaps} not completed, ${p.reported} confirmed to be reported.`);
    for (const label of p.openLabels) lines.push(`  - ${label}`);
    if (p.open > p.openLabels.length) lines.push(`  - and ${p.open - p.openLabels.length} more`);
  }
  const text = [
    header("Significant matters memo", clientName, engagement),
    "",
    "Counted from the packs' recorded state:",
    ...figures.map((f) => `- ${f.label}: ${f.value}`),
    "",
    "By pack (undecided flags are listed; a flag is a question, not a finding):",
    ...lines,
    "",
    "Matters the team chose to carry, in its words:",
    inputs.matters || "None recorded.",
    "",
    "This memo is a draft assembled from the packs' state and the team's words above. It states no conclusion. The engagement reviewer reads it, edits it and signs it.",
  ].join("\n");
  return guarded({ title: "Significant matters memo", inputsListed, figures, text }, [inputs.matters, clientName, engagement.title, engagement.period, ...packs.flatMap((p) => [p.kindLabel, ...p.openLabels])]);
}

// ── Reading memos ──────────────────────────────────────────────────────────────────────────────

const sha256 = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");

async function describeMemos({ engagement, firmId }) {
  const record = await EngagementAssurance.findOne({ firmId, engagementId: engagement._id }).select("memos").lean();
  const memos = record?.memos || [];
  const ids = new Set();
  for (const m of memos) for (const id of [m.createdByUserId, m.editedByUserId, m.signedByUserId]) if (id) ids.add(String(id));
  const users = new Map((await User.find({ _id: { $in: [...ids] } }).select("name email").lean()).map((u) => [String(u._id), u]));
  const who = (id) => (id ? { userId: String(id), name: users.get(String(id))?.name || users.get(String(id))?.email || "A team member" } : null);
  return memos
    .slice()
    .reverse()
    .map((m) => ({
      id: String(m._id),
      kind: m.kind,
      status: m.status,
      label: m.status === "SIGNED" ? "SIGNED" : MEMO_DRAFT_LABEL,
      title: m.title,
      source: m.source,
      text: m.text,
      inputsListed: m.inputsListed || [],
      figures: m.figures || [],
      createdBy: who(m.createdByUserId),
      createdAt: m.createdAt,
      editedBy: who(m.editedByUserId),
      editedAt: m.editedAt || null,
      signedBy: who(m.signedByUserId),
      signedAt: m.signedAt || null,
      textMatchesSigned: m.status === "SIGNED" ? sha256(m.text) === m.signedTextHash : null,
    }));
}

export async function listMemos({ engagementId, firmId }) {
  const engagement = await assuranceKit.loadEngagement(engagementId, firmId);
  return describeMemos({ engagement, firmId });
}

// ── Writing memos ──────────────────────────────────────────────────────────────────────────────

async function loadClientRun(engagement, firmId, runId) {
  const run = await AuditPackRun.findOne({ _id: objectId(runId, "runId"), firmId }).lean();
  if (!run) throw httpError(404, "That pack run is not in this firm.");
  if (String(run.clientId) !== String(engagement.clientId)) {
    throw httpError(409, "That pack run belongs to another client than this engagement.", "ENGAGEMENT_PACK_CLIENT_MISMATCH");
  }
  return run;
}

async function buildFor({ kind, engagement, firmId, input, clientName }) {
  if (kind === "MATERIALITY") {
    const inputs = readMaterialityInputs(input.inputs);
    return { inputs, built: buildMaterialityMemo({ inputs, clientName, engagement }) };
  }
  if (kind === "SAMPLING") {
    const raw = input.inputs || {};
    const inputs = {
      runId: String(raw.runId || ""),
      method: freeText(raw.method, 300, "The method", { required: true }),
      populationNote: freeText(raw.populationNote, 1000, "The population note"),
      rationale: freeText(raw.rationale, 3000, "The reasons"),
    };
    const run = await loadClientRun(engagement, firmId, inputs.runId);
    const packKind = getPackKind(run.kind);
    const reportChoices = packKind?.reportChoices?.length ? packKind.reportChoices : ["REPORT"];
    const selected = run.activeGenerationAttempt
      ? await AuditPackRow.find({ firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt, state: "CONFIRMED", "decision.choice": { $in: reportChoices } })
          .select("label values.voucherNumber values.date values.amountMinor")
          .sort({ ordinal: 1 })
          .limit(500)
          .lean()
      : [];
    if (selected.length === 0) {
      throw httpError(409, "No row in that pack is confirmed to be looked at, so there is nothing to describe yet.", "MEMO_NOTHING_SELECTED");
    }
    return { inputs, built: buildSamplingMemo({ inputs, clientName, engagement, run, kindLabel: packKind?.label, selected }) };
  }
  // SIGNIFICANT_MATTERS
  const raw = input.inputs || {};
  const runIds = Array.isArray(raw.runIds) ? [...new Set(raw.runIds.map(String))] : [];
  if (runIds.length < 1 || runIds.length > MAX_RUNS) throw httpError(400, `Choose between 1 and ${MAX_RUNS} packs.`);
  const inputs = { runIds, matters: freeText(raw.matters, 3000, "The matters") };
  const packs = [];
  for (const runId of runIds) {
    const run = await loadClientRun(engagement, firmId, runId);
    const packKind = getPackKind(run.kind);
    const base = { firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt };
    const reportChoices = packKind?.reportChoices?.length ? packKind.reportChoices : ["REPORT"];
    const [open, gaps, reported, openRows] = run.activeGenerationAttempt
      ? await Promise.all([
          AuditPackRow.countDocuments({ ...base, decidable: true, state: "COMPUTED" }),
          AuditPackRow.countDocuments({ ...base, state: "PENDING_INPUT" }),
          AuditPackRow.countDocuments({ ...base, state: "CONFIRMED", "decision.choice": { $in: reportChoices } }),
          AuditPackRow.find({ ...base, decidable: true, state: "COMPUTED" }).select("label").sort({ ordinal: 1 }).limit(MAX_OPEN_LISTED).lean(),
        ])
      : [0, 0, 0, []];
    packs.push({ kind: run.kind, kindLabel: packKind?.label, financialYear: run.financialYear, open, gaps, reported, openLabels: openRows.map((r) => r.label) });
  }
  return { inputs, built: buildSignificantMattersMemo({ inputs, clientName, engagement, packs }) };
}

export async function createMemo({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await assuranceKit.loadEngagement(engagementId, firmId);
  assuranceKit.assertWritable(engagement);
  assuranceKit.assertTeamMember(engagement, actorUserId);
  const key = readMutationKey(input.mutationKey);
  const kind = typeof input.kind === "string" ? input.kind : "";
  if (!MEMO_KINDS.includes(kind)) throw httpError(400, `The memo kind must be one of ${MEMO_KINDS.join(", ")}.`);
  await assuranceKit.ensureRecord(engagement, firmId, engagementId);

  const existing = await EngagementAssurance.findOne({ firmId, engagementId: engagement._id, "memos.mutationKey": key }).select("_id").lean();
  if (existing) return describeMemos({ engagement, firmId });

  const client = await Client.findOne({ _id: engagement.clientId, firmId }).select("name").lean();
  const { inputs, built } = await buildFor({ kind, engagement, firmId, input, clientName: client?.name || "" });
  const last = ASSURANCE_LIMITS.memos - 1;
  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, "memos.mutationKey": { $ne: key }, [`memos.${last}`]: { $exists: false } },
    {
      $push: {
        memos: {
          kind,
          status: "DRAFT",
          title: built.title,
          source: "TEMPLATE",
          inputs,
          inputsListed: built.inputsListed,
          figures: built.figures,
          text: built.text,
          createdByUserId: actorUserId,
          createdAt: new Date(),
          mutationKey: key,
        },
      },
      $inc: { revision: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw httpError(409, "This engagement already holds the most memos it can.", "ASSURANCE_LIMIT");
  return describeMemos({ engagement, firmId });
}

export async function editMemo({ engagementId, firmId, actorUserId, memoId, input = {} }) {
  const engagement = await assuranceKit.loadEngagement(engagementId, firmId);
  assuranceKit.assertWritable(engagement);
  assuranceKit.assertTeamMember(engagement, actorUserId);
  readMutationKey(input.mutationKey);
  const id = objectId(memoId, "memoId");
  const text = typeof input.text === "string" ? input.text : "";
  if (text.trim().length < MIN_TEXT || text.length > MAX_TEXT) throw httpError(400, `The memo text must be between ${MIN_TEXT} and ${MAX_TEXT} characters.`);
  const record = await assuranceKit.ensureRecord(engagement, firmId, engagementId);
  const memo = (record.memos || []).find((m) => String(m._id) === String(id));
  if (!memo) throw httpError(404, "That memo is not on this engagement.");
  if (memo.status === "SIGNED") throw httpError(409, "A signed memo can no longer be edited.", "MEMO_SIGNED");

  const result = await EngagementAssurance.updateOne(
    { firmId, engagementId: engagement._id, memos: { $elemMatch: { _id: id, status: "DRAFT" } } },
    { $set: { "memos.$[m].text": text, "memos.$[m].source": "TEMPLATE_EDITED", "memos.$[m].editedAt": new Date(), "memos.$[m].editedByUserId": actorUserId }, $inc: { revision: 1 } },
    { arrayFilters: [{ "m._id": id, "m.status": "DRAFT" }] },
  );
  if (result.modifiedCount === 0) throw httpError(409, "A signed memo can no longer be edited.", "MEMO_SIGNED");
  return describeMemos({ engagement, firmId });
}

export async function signMemo({ engagementId, firmId, actorUserId, memoId, input = {} }) {
  const engagement = await assuranceKit.loadEngagement(engagementId, firmId);
  assuranceKit.assertWritable(engagement);
  assuranceKit.assertReviewer(engagement, actorUserId);
  readMutationKey(input.mutationKey);
  const id = objectId(memoId, "memoId");
  const record = await assuranceKit.ensureRecord(engagement, firmId, engagementId);
  const memo = (record.memos || []).find((m) => String(m._id) === String(id));
  if (!memo) throw httpError(404, "That memo is not on this engagement.");
  if (memo.status === "SIGNED") {
    if (String(memo.signedByUserId) === String(actorUserId)) return describeMemos({ engagement, firmId });
    throw httpError(409, "That memo was already signed.", "MEMO_SIGNED");
  }
  const result = await EngagementAssurance.updateOne(
    // The text read above is part of the match: a memo edited a moment ago is not the text this person read.
    { firmId, engagementId: engagement._id, memos: { $elemMatch: { _id: id, status: "DRAFT", text: memo.text } } },
    { $set: { "memos.$[m].status": "SIGNED", "memos.$[m].signedAt": new Date(), "memos.$[m].signedByUserId": actorUserId, "memos.$[m].signedTextHash": sha256(memo.text) }, $inc: { revision: 1 } },
    { arrayFilters: [{ "m._id": id, "m.status": "DRAFT", "m.text": memo.text }] },
  );
  if (result.modifiedCount === 0) throw httpError(409, "That memo changed while you were signing it; read it again.", "MEMO_SIGNED");
  return describeMemos({ engagement, firmId });
}
