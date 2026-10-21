// src/services/case-intelligence.service.js
//
// W11 IN19-IN21 (2026-10-21): the rule reading of a case's notice, checked against what the model proposed, the
// published reply window and Act rule, and the requested documents turned into a task.
//
// Nothing here confirms a field. The rule proposals are offered; a person confirms each one through the existing
// confirmation route (source SOURCE_TEXT, with the excerpt), exactly as a value typed from the notice.

import mongoose from "mongoose";
import AppConfig from "../models/AppConfig.js";
import CaseMatter from "../models/CaseMatter.js";
import Client from "../models/Client.js";
import Task from "../models/Task.js";
import { readNoticeByRules, RULE_FIELDS } from "./notice-rules/index.js";
import {
  actForPeriod,
  publishableNoticeCatalogue,
  replyWindowCheck,
} from "./notice-catalogue.service.js";
import { parseIsoDay } from "./deadline-catalogue.service.js";

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

async function requireCase(firmId, caseId) {
  if (!mongoose.isValidObjectId(caseId)) throw httpError(400, "Case is not a valid id");
  const caseMatter = await CaseMatter.findOne({ _id: caseId, firmId }).lean();
  if (!caseMatter) throw httpError(404, "Case not found");
  return caseMatter;
}

// Values compared as the case stores them: dates as days, amounts as paise, text without case or spacing.
function comparable(field, value) {
  if (value === null || value === undefined) return "";
  if (/Date$/.test(field)) {
    const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
    return parseIsoDay(iso) ? iso : String(value).trim().toLowerCase();
  }
  if (/Minor$/.test(field)) {
    const digits = String(value).replace(/[^\d]/g, "");
    return digits ? String(Number(digits)) : "";
  }
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/** The rule reading for one case, for the case screen. Pure reads; nothing is stored. */
export async function getCaseRuleReading({ firmId, caseId }) {
  const caseMatter = await requireCase(firmId, caseId);
  const text = String(caseMatter.source?.extractedText || "");
  const reading = readNoticeByRules(text);
  const config = await AppConfig.findById("singleton").select("noticeCatalogue").lean();
  const catalogue = publishableNoticeCatalogue(config?.noticeCatalogue);

  // Where the model proposed (or a person confirmed) the same field, compare.
  const modelProposals = (caseMatter.extractionProposals || []).filter((proposal) => proposal.provider !== "RULES");
  const confirmed = caseMatter.confirmedFacts || {};
  const disagreements = [];
  for (const proposal of reading.proposals) {
    const ruleValue = comparable(proposal.field, proposal.value);
    const model = modelProposals.find((candidate) => candidate.field === proposal.field);
    if (model && comparable(proposal.field, model.value) && comparable(proposal.field, model.value) !== ruleValue) {
      disagreements.push({ field: proposal.field, ruleValue: proposal.value, otherValue: model.value, other: "MODEL", message: "Two readings differ - check against the notice." });
    }
    const mine = confirmed[proposal.field];
    if (mine !== undefined && mine !== null && mine !== "" && comparable(proposal.field, mine) && comparable(proposal.field, mine) !== ruleValue) {
      disagreements.push({ field: proposal.field, ruleValue: proposal.value, otherValue: mine instanceof Date ? mine.toISOString().slice(0, 10) : mine, other: "CONFIRMED", message: "The notice reads differently from the confirmed value - check it." });
    }
  }

  const ruleValue = (field) => reading.proposals.find((proposal) => proposal.field === field)?.value || null;
  const dayOf = (field) => {
    const value = confirmed[field];
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "string" && parseIsoDay(value.slice(0, 10))) return value.slice(0, 10);
    return ruleValue(field);
  };
  const replyWindow = reading.form
    ? replyWindowCheck({
        catalogue,
        formId: reading.form.id,
        statedDueDate: dayOf("responseDueDate"),
        issueDate: dayOf("issueDate"),
        receivedDate: dayOf("receivedDate"),
      })
    : null;
  const act = reading.form?.family === "IT"
    ? actForPeriod(catalogue, {
        financialYear: confirmed.financialYear || ruleValue("financialYear"),
        assessmentYear: confirmed.assessmentYear || ruleValue("assessmentYear"),
        period: confirmed.period || ruleValue("period"),
      })
    : null;

  const found = new Set(reading.proposals.map((proposal) => proposal.field));
  return {
    caseId: String(caseMatter._id),
    version: reading.version,
    hasText: Boolean(text.trim()),
    form: reading.form,
    proposals: reading.proposals.map((proposal) => ({ ...proposal, source: "RULE", label: `Read by rule ${proposal.ruleId}` })),
    notFoundByRules: RULE_FIELDS.filter((field) => !found.has(field)),
    disagreements,
    replyWindow,
    act,
    catalogueVersion: catalogue?.version || 0,
    note: !text.trim()
      ? "Add the notice text first; the rules read only what the notice states."
      : reading.proposals.length
        ? "Read by rules from the notice text, with no model. Confirm each value against the notice."
        : "The rules found nothing they recognise in this notice. Fill the fields in yourself, or ask the model.",
  };
}

/**
 * Rule proposals in the case's stored proposal shape, for the model extraction to store beside its own (provider
 * RULES). Rule proposals carry no model confidence: 1 marks "read verbatim by a rule", and both clients show the
 * rule id instead of a percentage for provider RULES.
 */
export function ruleProposalsForCase(text) {
  const reading = readNoticeByRules(text);
  return reading.proposals.map((proposal) => ({
    field: proposal.field,
    value: String(proposal.value),
    sourceText: proposal.sourceText,
    confidence: 1,
    provider: "RULES",
    model: `${reading.version}:${proposal.ruleId}`,
    proposedAt: new Date(),
  }));
}

/**
 * POST /api/cases/:id/document-requests - one task that lists the documents the notice asks for, once the
 * requestedDocuments field is confirmed. One per case (generationKey), due on the confirmed reply-by date.
 */
export async function createCaseDocumentTask({ firmId, actorUserId, caseId, input = {} }) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
    throw httpError(400, "This request takes no fields.");
  }
  const caseMatter = await requireCase(firmId, caseId);
  const documents = Array.isArray(caseMatter.confirmedFacts?.requestedDocuments) ? caseMatter.confirmedFacts.requestedDocuments.filter(Boolean) : [];
  if (!documents.length) {
    throw httpError(409, "Confirm the documents the notice asks for first.", "CASE_DOCUMENTS_NOT_CONFIRMED");
  }
  const due = caseMatter.confirmedFacts?.responseDueDate;
  const dueDateISO = due instanceof Date ? due.toISOString().slice(0, 10) : typeof due === "string" ? due.slice(0, 10) : "";
  if (!parseIsoDay(dueDateISO)) {
    throw httpError(409, "Confirm the reply-by date first; the task is due then.", "CASE_DUE_DATE_NOT_CONFIRMED");
  }
  const client = await Client.findOne({ _id: caseMatter.clientId, firmId }).select("name").lean();
  if (!client) throw httpError(404, "The case's client could not be found.");
  const generationKey = `case:${caseMatter._id}:documents`;
  const remarks = ["Documents the notice asks for:", ...documents.map((item) => `- ${item}`)].join("\n").slice(0, 2000);
  const existing = await Task.findOne({ firmId, generationKey }).lean();
  if (existing) return { created: false, task: { id: String(existing._id), title: existing.title, dueDateISO: existing.dueDateISO } };
  try {
    const task = await Task.create({
      firmId,
      createdBy: actorUserId,
      clientName: client.name,
      serviceType: String(caseMatter.caseType || "").startsWith("GST_") ? "GST" : String(caseMatter.caseType || "").startsWith("ROC_") ? "ROC" : "ITR",
      title: `Collect documents: ${caseMatter.title || "notice"}`.slice(0, 200),
      remarks,
      dueDateISO,
      assignedTo: caseMatter.ownerUserId || actorUserId,
      status: "NOT_STARTED",
      source: "CASE",
      clientId: caseMatter.clientId,
      caseId: caseMatter._id,
      isActive: true,
      generationKey,
      meta: { caseRevision: caseMatter.revision, documentCount: documents.length },
    });
    return { created: true, task: { id: String(task._id), title: task.title, dueDateISO: task.dueDateISO } };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await Task.findOne({ firmId, generationKey }).lean();
    return { created: false, task: { id: String(raced._id), title: raced.title, dueDateISO: raced.dueDateISO } };
  }
}
