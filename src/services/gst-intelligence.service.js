// src/services/gst-intelligence.service.js
//
// W11 IN8-IN12 (2026-10-21): the reconciliation's intelligence routes. Reads a run's items, asks the rule engine
// (gst-cause.service.js) why each open item disagrees, sends only what no rule explains to the model
// (gst_cause_residue), and builds the supplier chase pack (supplier_chase_draft for wording, a fixed template
// otherwise). Nothing here writes to a reconciliation item: a cause or a draft becomes a decision only through
// the existing disposition route, when a person saves it.

import mongoose from "mongoose";
import AiDraft from "../models/AiDraft.js";
import Client from "../models/Client.js";
import Firm from "../models/Firm.js";
import ImportRow from "../models/ImportRow.js";
import PartyMaster from "../models/PartyMaster.js";
import ReconciliationItem from "../models/ReconciliationItem.js";
import ReconciliationRun from "../models/ReconciliationRun.js";
import { runAiTask } from "./ai/ai-task.service.js";
import { fillSlots } from "./ai/ai-validate.js";
import { CHASE_CHANNELS, CHASE_LANGUAGE_LABELS, CHASE_LANGUAGE_NAMES, CHASE_LANGUAGES } from "./ai/tasks/supplier-chase-draft.js";
import { explainItems, formatRupees, residueFacts, RULE_CAUSES } from "./gst-cause.service.js";

const MAX_OPEN_ITEMS = 5000;
const MAX_OTHER_RUNS = 24;

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function assertAllowed(input, allowed, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, `${label} must be an object`);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw httpError(400, `${label} does not accept: ${extra.join(", ")}`);
}

async function requireRun(firmId, runId) {
  if (!mongoose.isValidObjectId(runId)) throw httpError(400, "Reconciliation run is not a valid id");
  const run = await ReconciliationRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw httpError(404, "Reconciliation run not found");
  const attempt = Number(run.activeGenerationAttempt || 0);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw httpError(409, "This reconciliation is still being prepared.", "GST_RUN_NOT_READY");
  }
  return run;
}

const activeScope = (run) => ({ firmId: run.firmId, runId: run._id, generationAttempt: Number(run.activeGenerationAttempt), isActive: { $ne: false } });

async function loadOpenItems(run) {
  const items = await ReconciliationItem.find({ ...activeScope(run), status: { $ne: "MATCHED" }, resolutionState: { $ne: "RESOLVED" } })
    .sort({ supplierGstin: 1, booksSourceRow: 1, portalSourceRow: 1 })
    .limit(MAX_OPEN_ITEMS + 1)
    .lean();
  const truncated = items.length > MAX_OPEN_ITEMS;
  const open = truncated ? items.slice(0, MAX_OPEN_ITEMS) : items;
  // The rules need the single candidate's number and amounts, and a paired amendment's 2B document type.
  const rowIds = new Set();
  for (const item of open) {
    if (item.candidatePortalRowIds?.length === 1) rowIds.add(String(item.candidatePortalRowIds[0]));
    if (item.status === "POSSIBLE_AMENDMENT" && item.portalRowId) rowIds.add(String(item.portalRowId));
  }
  const rows = rowIds.size
    ? await ImportRow.find({ _id: { $in: [...rowIds] }, firmId: run.firmId })
        .select("invoiceNumberOriginal invoiceNumberNormalized documentType taxableValueMinor igstMinor cgstMinor sgstMinor cessMinor totalTaxMinor")
        .lean()
    : [];
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  for (const item of open) {
    const candidate = item.candidatePortalRowIds?.length === 1 ? byId.get(String(item.candidatePortalRowIds[0])) : null;
    item.candidatePortals = candidate
      ? [{ _id: candidate._id, invoiceNumberNormalized: candidate.invoiceNumberNormalized, invoiceNumberOriginal: candidate.invoiceNumberOriginal, amounts: candidate }]
      : [];
    item.portalDocumentType = item.portalRowId ? byId.get(String(item.portalRowId))?.documentType || "" : "";
  }
  return { open, truncated };
}

// The same client's runs for other periods (same recipient GSTIN, the latest run per period, within a year),
// and their items for the suppliers and invoice numbers this run's open items carry. Read only.
async function loadOtherRunItems(run, open) {
  const suppliers = [...new Set(open.map((item) => item.supplierGstin).filter(Boolean))];
  const numbers = [...new Set(open.map((item) => item.invoiceNumberNormalized).filter(Boolean))];
  if (!suppliers.length || !numbers.length) return [];
  const runs = await ReconciliationRun.find({
    firmId: run.firmId,
    clientId: run.clientId,
    gstin: run.gstin,
    period: { $ne: run.period },
    activeGenerationAttempt: { $gte: 1 },
  })
    .sort({ createdAt: -1 })
    .select("_id period activeGenerationAttempt createdAt")
    .limit(MAX_OTHER_RUNS * 4)
    .lean();
  const latest = new Map();
  for (const other of runs) if (!latest.has(other.period)) latest.set(other.period, other);
  const chosen = [...latest.values()].slice(0, MAX_OTHER_RUNS);
  const results = await Promise.all(
    chosen.map(async (other) => {
      const items = await ReconciliationItem.find({
        firmId: run.firmId,
        runId: other._id,
        generationAttempt: Number(other.activeGenerationAttempt),
        isActive: { $ne: false },
        supplierGstin: { $in: suppliers },
        invoiceNumberNormalized: { $in: numbers },
      })
        .select("_id status supplierGstin invoiceNumberNormalized documentType booksAmounts portalAmounts booksRowId portalRowId")
        .lean();
      return items.map((item) => ({ ...item, runId: other._id, period: other.period }));
    }),
  );
  return results.flat();
}

function serializeCause(entry) {
  return {
    itemId: entry.itemId,
    source: entry.source,
    ruleId: entry.ruleId,
    cause: entry.cause,
    summary: entry.summary,
    evidence: entry.evidence,
    suggestedDisposition: entry.suggestedDisposition,
    reasonDraft: entry.reasonDraft,
    candidatePortalRowId: entry.candidatePortalRowId,
    relatedItemIds: entry.relatedItemIds,
    relatedRun: entry.relatedRun,
    alsoFired: entry.alsoFired || [],
    label: `Rule ${entry.ruleId}`,
  };
}

/** GET /runs/:id/causes - every open item's rule-based cause, the items no rule explains, and earlier drafts. */
export async function getRunCauses({ firmId, runId }) {
  const run = await requireRun(firmId, runId);
  const { open, truncated } = await loadOpenItems(run);
  const otherRunItems = await loadOtherRunItems(run, open);
  const explained = explainItems({ items: open, otherRunItems, period: run.period });
  const drafts = explained.unexplained.length
    ? await AiDraft.find({
        firmId,
        task: "gst_cause_residue",
        "subject.kind": "ReconciliationItem",
        "subject.id": { $in: explained.unexplained },
      })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  const latestDraft = new Map();
  for (const draft of drafts) if (!latestDraft.has(draft.subject.id)) latestDraft.set(draft.subject.id, draft);
  return {
    runId: String(run._id),
    period: run.period,
    ruleVersion: explained.ruleVersion,
    causes: explained.causes.map(serializeCause),
    unexplained: explained.unexplained.map((itemId) => {
      const draft = latestDraft.get(itemId);
      return {
        itemId,
        draft: draft
          ? { id: String(draft._id), output: draft.output, abstained: draft.abstained, outcome: draft.outcome, label: "DRAFT FOR REVIEW" }
          : null,
      };
    }),
    counts: explained.counts,
    truncated,
    note: truncated ? `Only the first ${MAX_OPEN_ITEMS} open items were read.` : "",
  };
}

/** POST /runs/:id/causes/residue - the model's likely cause for items no rule explained. */
export async function draftResidueCauses({ firmId, userId, runId, input = {} }) {
  assertAllowed(input, new Set(["itemIds", "consent"]), "A request for likely causes");
  const run = await requireRun(firmId, runId);
  const ids = Array.isArray(input.itemIds) ? [...new Set(input.itemIds.map(String))] : [];
  if (!ids.length) throw httpError(400, "Choose at least one item to draft for.", "AI_NOTHING_SELECTED");
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw httpError(400, "An item id is not valid.");
  const { open } = await loadOpenItems(run);
  const otherRunItems = await loadOtherRunItems(run, open);
  const explained = explainItems({ items: open, otherRunItems, period: run.period });
  const unexplained = new Set(explained.unexplained);
  const byId = new Map(open.map((item) => [String(item._id), item]));
  // The model's context for an item is every active item of the same supplier in this run, matched ones
  // included: "twice a matched invoice of the same day" is only visible next to the matched invoice.
  const wantedSuppliers = [...new Set(ids.map((id) => byId.get(id)?.supplierGstin).filter(Boolean))];
  const supplierItems = wantedSuppliers.length
    ? await ReconciliationItem.find({ ...activeScope(run), supplierGstin: { $in: wantedSuppliers } })
        .sort({ booksSourceRow: 1, portalSourceRow: 1 })
        .limit(1000)
        .lean()
    : [];
  const skipped = [];
  const units = [];
  const refsByUnit = new Map();
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) {
      skipped.push({ itemId: id, reason: "Not an open item of this reconciliation." });
      continue;
    }
    if (!unexplained.has(id)) {
      skipped.push({ itemId: id, reason: "A rule already explains this item." });
      continue;
    }
    const sameSupplier = supplierItems.filter((other) => other.supplierGstin === item.supplierGstin);
    const { facts, refs } = residueFacts(item, sameSupplier);
    units.push({ id, facts, subject: { kind: "ReconciliationItem", id } });
    refsByUnit.set(id, refs);
  }
  if (!units.length) {
    return { available: true, drafts: [], failed: [], skipped, note: "Every chosen item already has a rule-based cause." };
  }
  const result = await runAiTask({ taskName: "gst_cause_residue", firmId, userId, consent: input.consent, units });
  return {
    available: result.available,
    drafts: result.results.map(({ unitId, draft }) => ({
      itemId: unitId,
      draft: {
        ...draft,
        relatedItemId: draft.output?.relatedRef ? refsByUnit.get(unitId)?.[draft.output.relatedRef] || null : null,
      },
    })),
    failed: result.failed.map(({ unitId, reason }) => ({ itemId: unitId, reason })),
    skipped,
    note: result.note,
  };
}

// ─── supplier chase pack (IN12) ──────────────────────────────────────────────

const CHASE_STATUSES = new Set(["MISSING_IN_2B"]);
const AMOUNT_STATUSES = new Set(["TAX_AMOUNT_MISMATCH", "TAXABLE_VALUE_MISMATCH"]);

function dayLabel(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${names[month - 1]} ${year}`;
}

function periodLabel(period) {
  const [year, month] = String(period || "").split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return year && month ? `${names[month - 1]} ${year}` : String(period || "");
}

const ageDays = (iso, now) => (iso ? Math.max(0, Math.floor((now - Date.parse(`${iso}T00:00:00Z`)) / 86400000)) : null);

async function buildChaseGroups(run) {
  const { open } = await loadOpenItems(run);
  const otherRunItems = await loadOtherRunItems(run, open);
  const explained = explainItems({ items: open, otherRunItems, period: run.period });
  const causeById = new Map(explained.causes.map((entry) => [entry.itemId, entry]));
  const chasedMarked = await ReconciliationItem.find({ ...activeScope(run), "chase.required": true }).lean();
  const pool = new Map(open.map((item) => [String(item._id), item]));
  for (const item of chasedMarked) pool.set(String(item._id), item);

  const now = Date.now();
  const groups = new Map();
  const notChased = [];
  for (const item of pool.values()) {
    const id = String(item._id);
    const entry = causeById.get(id);
    const marked = Boolean(item.chase?.required);
    const needsSupplier = marked || CHASE_STATUSES.has(item.status) || AMOUNT_STATUSES.has(item.status);
    if (!needsSupplier || !item.booksRowId) continue;
    // Already in a later 2B, or the fix is in the books: the supplier has nothing to do.
    if (!marked && entry && [RULE_CAUSES.R2_LATER_2B, RULE_CAUSES.R1, RULE_CAUSES.R3, RULE_CAUSES.R7, RULE_CAUSES.R6].includes(entry.cause)) {
      notChased.push({ itemId: id, ruleId: entry.ruleId, cause: entry.cause });
      continue;
    }
    const key = item.supplierGstin || "UNKNOWN";
    if (!groups.has(key)) {
      groups.set(key, { supplierGstin: key, itemIds: [], invoices: [], itcAtStakeMinor: 0, oldestDays: null, covers: { notFiled: false, amountDiffers: false, other: false }, chaseStates: {} });
    }
    const group = groups.get(key);
    const taxMinor = Number(item.booksAmounts?.totalTaxMinor || 0);
    group.itemIds.push(id);
    group.invoices.push({
      itemId: id,
      invoiceNumber: item.invoiceNumberOriginal || item.invoiceNumberNormalized || "",
      documentDate: item.documentDate || null,
      taxableMinor: Number(item.booksAmounts?.taxableValueMinor || 0),
      taxMinor,
      status: item.status,
    });
    group.itcAtStakeMinor += taxMinor;
    const age = ageDays(item.documentDate, now);
    if (age !== null && (group.oldestDays === null || age > group.oldestDays)) group.oldestDays = age;
    if (CHASE_STATUSES.has(item.status)) group.covers.notFiled = true;
    else if (AMOUNT_STATUSES.has(item.status)) group.covers.amountDiffers = true;
    else group.covers.other = true;
    const state = item.chase?.state && item.chase.state !== "NONE" ? item.chase.state : "NOT_STARTED";
    group.chaseStates[state] = (group.chaseStates[state] || 0) + 1;
  }
  const names = groups.size
    ? await PartyMaster.find({ firmId: run.firmId, clientId: run.clientId, gstin: { $in: [...groups.keys()] } }).select("gstin name").lean()
    : [];
  const nameOf = new Map(names.map((party) => [party.gstin, party.name]));
  const suppliers = [...groups.values()]
    .map((group) => ({ ...group, supplierName: nameOf.get(group.supplierGstin) || "" }))
    .sort((a, b) => b.itcAtStakeMinor - a.itcAtStakeMinor || a.supplierGstin.localeCompare(b.supplierGstin));
  return { suppliers, notChased };
}

/** GET /runs/:id/chase-pack - one entry per supplier who has something to file or correct, by ITC at stake. */
export async function getChasePack({ firmId, runId }) {
  const run = await requireRun(firmId, runId);
  const { suppliers, notChased } = await buildChaseGroups(run);
  return {
    runId: String(run._id),
    period: run.period,
    suppliers: suppliers.map((group) => ({
      supplierGstin: group.supplierGstin,
      supplierName: group.supplierName,
      itemIds: group.itemIds,
      invoices: group.invoices,
      itcAtStakeMinor: group.itcAtStakeMinor,
      oldestDays: group.oldestDays,
      covers: group.covers,
      chaseStates: group.chaseStates,
    })),
    totalSuppliers: suppliers.length,
    totalItcAtStakeMinor: suppliers.reduce((sum, group) => sum + group.itcAtStakeMinor, 0),
    notChased,
    deliveryEvidence: "ACTION_RECORDED_ONLY",
    // W11 IN33: the clients build their language picker from this, so a language added here needs no release.
    languages: CHASE_LANGUAGE_CHOICES,
  };
}

function invoiceTable(group, channel) {
  const lines = group.invoices.map((invoice) =>
    `${invoice.invoiceNumber || "(no number)"} | ${dayLabel(invoice.documentDate) || "(no date)"} | taxable ${formatRupees(invoice.taxableMinor)} | tax ${formatRupees(invoice.taxMinor)}`,
  );
  return channel === "email" ? lines.join("\n") : lines.map((line) => `- ${line}`).join("\n");
}

// The fixed templates used when the model is off, refused or unavailable: English, Hindi and Hinglish (W11
// IN33). The owner approves their wording before the flag goes on (.kiro/OWNER-TODO.md, W11 item 3). A language
// with no template here gets the English one, and the message says so.
const CHASE_TEMPLATES = Object.freeze({
  en: Object.freeze({
    subject: "GST returns: invoices not yet showing for {{client}} ({{period}})",
    message:
      "Dear {{supplier}},\n\nThe following {{invoiceCount}} invoice(s) issued to {{client}} do not yet appear in their GSTR-2B for {{period}}:\n\n{{invoiceTable}}\n\nTax involved: {{itcAtStake}}. Please file them in your GSTR-1, or correct the GSTIN or amount if it was reported differently, and let us know once done.\n\nRegards,\n{{sender}}",
  }),
  hi: Object.freeze({
    subject: "जीएसटी रिटर्न: {{client}} ({{period}}) के इनवॉइस अभी नहीं दिख रहे",
    message:
      "प्रिय {{supplier}},\n\n{{client}} को जारी किए गए नीचे दिए {{invoiceCount}} इनवॉइस अभी {{period}} के उनके GSTR-2B में नहीं दिख रहे हैं:\n\n{{invoiceTable}}\n\nइनमें कर राशि: {{itcAtStake}}। कृपया इन्हें अपने GSTR-1 में दर्ज करें, या यदि GSTIN या राशि अलग दर्ज हुई है तो उसे सुधारें, और हो जाने पर हमें बताएं।\n\nधन्यवाद,\n{{sender}}",
  }),
  hinglish: Object.freeze({
    subject: "GST returns: {{client}} ({{period}}) ke invoices abhi nahi dikh rahe",
    message:
      "Namaste {{supplier}} ji,\n\n{{client}} ko issue kiye gaye ye {{invoiceCount}} invoice(s) abhi unke {{period}} ke GSTR-2B mein nahi dikh rahe:\n\n{{invoiceTable}}\n\nTax amount: {{itcAtStake}}. Kripya inhe apne GSTR-1 mein file karein, ya agar GSTIN ya amount alag report hua hai to use sahi karein, aur ho jaane par humein batayein.\n\nDhanyavaad,\n{{sender}}",
  }),
});

/** The languages a chase message can be drafted in, for the clients' picker: code, label, and whether a fixed template exists. */
export const CHASE_LANGUAGE_CHOICES = Object.freeze(
  CHASE_LANGUAGES.map((code) => Object.freeze({ code, label: CHASE_LANGUAGE_LABELS[code], template: Boolean(CHASE_TEMPLATES[code]) })),
);

/** POST /runs/:id/chase-pack/draft - a message per supplier, from one template per kind of problem. */
export async function draftChaseMessages({ firmId, userId, runId, input = {} }) {
  assertAllowed(input, new Set(["language", "channel", "consent", "supplierGstins", "useTemplate"]), "A chase draft request");
  const language = input.language || "en";
  const channel = input.channel || "whatsapp";
  if (!CHASE_LANGUAGES.includes(language)) throw httpError(400, `Language must be one of: ${CHASE_LANGUAGES.join(", ")}.`);
  if (!CHASE_CHANNELS.includes(channel)) throw httpError(400, "Channel must be whatsapp or email.");
  const run = await requireRun(firmId, runId);
  const { suppliers } = await buildChaseGroups(run);
  const wanted = Array.isArray(input.supplierGstins) && input.supplierGstins.length ? new Set(input.supplierGstins.map(String)) : null;
  const chosen = wanted ? suppliers.filter((group) => wanted.has(group.supplierGstin)) : suppliers;
  if (!chosen.length) return { available: true, source: "TEMPLATE", messages: [], note: "No supplier needs a message for this reconciliation." };

  const [client, firm] = await Promise.all([
    Client.findOne({ _id: run.clientId, firmId }).select("name").lean(),
    Firm.findOne({ _id: firmId }).select("displayName").lean(),
  ]);

  // One unit per distinct mix of problems; the model sees the mix, the language and the channel, nothing else.
  const mixKey = (covers) => `${covers.notFiled ? 1 : 0}${covers.amountDiffers ? 1 : 0}${covers.other ? 1 : 0}`;
  const templates = new Map();
  // The template in the language asked for, or the English one when there is none (said on each message).
  const templateLanguage = CHASE_TEMPLATES[language] ? language : "en";
  const template = CHASE_TEMPLATES[templateLanguage];
  const templateNote = templateLanguage === language ? "" : ` There is no fixed template in ${CHASE_LANGUAGE_LABELS[language]} yet, so the English one is used.`;
  let source = "TEMPLATE";
  let note = `A fixed template, not a model draft.${templateNote}`;
  if (input.useTemplate !== true) {
    const mixes = [...new Map(chosen.map((group) => [mixKey(group.covers), group.covers])).entries()];
    const units = mixes.map(([key, covers]) => ({
      id: `mix-${key}`,
      subject: { kind: "ChaseTemplate", id: `${language}:${channel}:${key}` },
      facts: { language: CHASE_LANGUAGE_NAMES[language], channel, covers },
    }));
    const result = await runAiTask({ taskName: "supplier_chase_draft", firmId, userId, consent: input.consent, units });
    for (const { unitId, draft } of result.results) templates.set(unitId.slice(4), draft);
    if (result.results.length) {
      source = "MODEL";
      note = result.results.length === units.length
        ? "Drafted by AI from the kind of problem only; names, invoices and amounts were filled in by CA PRO. Check each before you send it."
        : `Some messages use the fixed template because a model draft was not available for them.${templateNote}`;
    } else {
      note = templateLanguage === "en"
        ? `A model draft is not available right now; this is the fixed English template.${templateNote}`
        : "A model draft is not available right now; this is the fixed template.";
    }
  }

  const messages = chosen.map((group) => {
    const draft = templates.get(mixKey(group.covers)) || null;
    const values = {
      supplier: group.supplierName || group.supplierGstin,
      client: client?.name || "our client",
      period: periodLabel(run.period),
      invoiceCount: String(group.invoices.length),
      invoiceTable: invoiceTable(group, channel),
      itcAtStake: formatRupees(group.itcAtStakeMinor),
      sender: firm?.displayName || "",
    };
    const subjectTemplate = channel === "email" ? draft?.output?.subject || template.subject : "";
    const messageTemplate = draft?.output?.message || template.message;
    return {
      supplierGstin: group.supplierGstin,
      supplierName: group.supplierName,
      itemIds: group.itemIds,
      source: draft ? "MODEL" : "TEMPLATE",
      // The language this message is actually in: the one asked for, or English when it fell back to that template.
      language: draft ? language : templateLanguage,
      draftId: draft?.id || null,
      subject: subjectTemplate ? fillSlots(subjectTemplate, values) : "",
      message: fillSlots(messageTemplate, values),
      label: "DRAFT FOR REVIEW - NOT SENT",
    };
  });
  return { available: true, source, language, channel, messages, note };
}
