// src/services/tds-intelligence.service.js
//
// W11 IN18 (2026-10-21): a drafted reviewer note and client chase message per TDS health check, for the
// action-plan preview. The model sees what the check computed - status and its plain title, dimension,
// severity, section, period, whether the difference is a shortfall or an excess, and the correction steps for
// that status - and never a PAN, a name or an amount; the chase message's {{slots}} are filled here. Nothing is
// written to the check: a person keeps what they want by sending it as the plan's `messages` to the existing
// preview and commit, which store it like any other plan text.

import mongoose from "mongoose";
import Client from "../models/Client.js";
import Firm from "../models/Firm.js";
import TdsHealthCheck from "../models/TdsHealthCheck.js";
import TdsHealthRun from "../models/TdsHealthRun.js";
import { runAiTask } from "./ai/ai-task.service.js";
import { fillSlots } from "./ai/ai-validate.js";
import { checklistForTdsStatus } from "./tds-action-checklists.js";
import { formatRupees } from "./gst-cause.service.js";

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

const differenceDirection = (minor) => (minor > 0 ? "shortfall" : minor < 0 ? "excess" : "none");

/** POST /api/tds-health/runs/:id/action-drafts */
export async function draftTdsActions({ firmId, userId, runId, input = {} }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "A draft request must be an object");
  const extra = Object.keys(input).filter((key) => key !== "checkIds" && key !== "consent");
  if (extra.length) throw httpError(400, `A draft request does not accept: ${extra.join(", ")}`);
  if (!mongoose.isValidObjectId(runId)) throw httpError(400, "TDS run is not a valid id");
  const ids = Array.isArray(input.checkIds) ? [...new Set(input.checkIds.map(String))] : [];
  if (!ids.length) throw httpError(400, "Choose at least one item to draft for.", "AI_NOTHING_SELECTED");
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw httpError(400, "A check id is not valid.");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw httpError(404, "TDS health run not found");
  if (!["REVIEW", "LOCKED"].includes(run.status) || !run.activeGenerationAttempt) {
    throw httpError(409, "TDS health checks are not published for this run");
  }
  const checks = await TdsHealthCheck.find({
    _id: { $in: ids },
    firmId,
    runId: run._id,
    generationAttempt: run.activeGenerationAttempt,
  }).lean();
  if (checks.length !== ids.length) throw httpError(404, "One or more checks are not in this run.");

  const period = `${run.financialYear} ${run.quarter}`;
  const units = checks.map((check) => ({
    id: String(check._id),
    subject: { kind: "TdsHealthCheck", id: String(check._id) },
    facts: {
      status: check.status,
      statusLabel: check.title,
      dimension: check.dimension,
      severity: check.severity,
      sectionLabel: check.sectionCode || "not recorded",
      period,
      statementType: run.statementType,
      difference: differenceDirection(Number(check.differenceMinor || 0)),
      deducteeKnown: Boolean(check.deducteePan),
      checklist: checklistForTdsStatus(check.status) || [],
    },
  }));
  const result = await runAiTask({ taskName: "tds_action_draft", firmId, userId, consent: input.consent, units });

  const [client, firm] = await Promise.all([
    Client.findOne({ _id: run.clientId, firmId }).select("name").lean(),
    Firm.findOne({ _id: firmId }).select("displayName").lean(),
  ]);
  const byId = new Map(checks.map((check) => [String(check._id), check]));
  const drafts = result.results.map(({ unitId, draft }) => {
    const check = byId.get(unitId);
    const values = {
      client: client?.name || "",
      deductee: check?.deducteePan ? `the deductee with PAN ${check.deducteePan}` : "the deductee",
      period,
      amount: check && Number(check.differenceMinor) ? formatRupees(Math.abs(Number(check.differenceMinor))) : "",
      section: check?.sectionCode || "",
      sender: firm?.displayName || "",
    };
    return {
      checkId: unitId,
      draftId: draft.id,
      abstained: draft.abstained,
      reviewerNote: draft.output.reviewerNote,
      clientChaseMessage: draft.output.chaseMessage ? fillSlots(draft.output.chaseMessage, values) : "",
      label: "DRAFT FOR REVIEW",
      replayed: draft.replayed,
    };
  });
  return {
    available: result.available,
    drafts,
    failed: result.failed.map(({ unitId, reason }) => ({ checkId: unitId, reason })),
    note: result.note,
  };
}
