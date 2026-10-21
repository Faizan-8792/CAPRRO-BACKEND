// src/services/priority-engine.service.js
//
// W11 IN22 (2026-10-21): today's priorities - one ranked list of what needs the firm, each line with its reason.
// No model: this is arithmetic on dates, amounts and severities the server already holds.
//
// Why: the work was spread across six screens (tasks, reminders, notices, reconciliations, TDS checks, client
// requests), and the only ranking lived inside the extension (compliance-assistant/priority-engine.js), so the
// Windows app and the extension could disagree. The server owns the rule now; the extension keeps its own
// engine only as the offline fallback.
//
// Dates are UTC days (CLAUDE.md section 8): "days left" is an integer difference of UTC day numbers, never a
// local-time conversion. Money is paise.

import mongoose from "mongoose";
import CaseMatter from "../models/CaseMatter.js";
import Client from "../models/Client.js";
import Engagement from "../models/Engagement.js";
import ReconciliationItem from "../models/ReconciliationItem.js";
import ReconciliationRun from "../models/ReconciliationRun.js";
import Reminder from "../models/Reminder.js";
import Task from "../models/Task.js";
import TdsHealthCheck from "../models/TdsHealthCheck.js";
import TdsHealthRun from "../models/TdsHealthRun.js";
import { parseIsoDay, utcDayNumber } from "./deadline-catalogue.service.js";
import { formatRupees } from "./gst-cause.service.js";

export const PRIORITY_RULE_VERSION = "priorities-v1";
export const PRIORITY_LIMIT = 50;
const SOURCE_LIMIT = 200;
const CHASE_STALE_DAYS = 7;

/** Urgency points from whole UTC days left (negative = overdue). Null = no due date. */
export function urgencyPoints(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return 10;
  if (daysLeft < 0) return 100 + Math.min(-daysLeft, 30);
  if (daysLeft === 0) return 90;
  if (daysLeft <= 3) return 80;
  if (daysLeft <= 7) return 60;
  if (daysLeft <= 30) return 30;
  return 15;
}

/** Stake points from paise at risk. */
export function stakePoints(minor) {
  const value = Number(minor) || 0;
  if (value >= 10_00_000_00) return 20; // Rs 10 lakh
  if (value >= 1_00_000_00) return 12; // Rs 1 lakh
  if (value >= 10_000_00) return 6; // Rs 10,000
  return 0;
}

export function severityPoints(severity) {
  return severity === "ERROR" ? 10 : severity === "WARNING" ? 4 : 0;
}

function daysLeftFor(isoDay, todayNumber) {
  const day = parseIsoDay(String(isoDay || "").slice(0, 10));
  return day ? day.dayNumber - todayNumber : null;
}

function whenText(daysLeft) {
  if (daysLeft === null) return "";
  if (daysLeft < 0) return `${-daysLeft} ${-daysLeft === 1 ? "day" : "days"} overdue`;
  if (daysLeft === 0) return "due today";
  return `due in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
}

/**
 * Pure: ranks prepared entries. Each entry: { kind, id, title, clientName, dueDateISO, stakeMinor, severity,
 * reasonParts: [..], link }. Adds daysLeft, score and a one-line reason; highest score first, then earliest
 * due, then kind and id so the order is stable.
 */
export function rankPriorities(entries, { today = new Date(), limit = PRIORITY_LIMIT } = {}) {
  const todayNumber = utcDayNumber(today);
  const scored = entries.map((entry) => {
    const daysLeft = daysLeftFor(entry.dueDateISO, todayNumber);
    const score = urgencyPoints(daysLeft) + stakePoints(entry.stakeMinor) + severityPoints(entry.severity);
    const reason = [whenText(daysLeft), ...(entry.reasonParts || [])].filter(Boolean).join("; ");
    return { ...entry, daysLeft, score, reason };
  });
  scored.sort((a, b) =>
    b.score - a.score
    || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity)
    || a.kind.localeCompare(b.kind)
    || String(a.id).localeCompare(String(b.id)));
  return { items: scored.slice(0, limit).map(({ reasonParts, ...rest }) => rest), total: scored.length, truncated: scored.length > limit };
}

/** Loads every source for one firm and ranks it. Bounded reads; nothing is written. */
export async function getTodayPriorities({ firmId, userId, today = new Date() }) {
  const firm = new mongoose.Types.ObjectId(String(firmId));
  const todayNumber = utcDayNumber(today);
  const isoToday = new Date(todayNumber * 86_400_000).toISOString().slice(0, 10);
  const horizon = new Date((todayNumber + 30) * 86_400_000).toISOString().slice(0, 10);

  const [tasks, reminders, cases, reconRuns, tdsRuns, engagements] = await Promise.all([
    Task.find({ firmId: firm, isActive: { $ne: false }, status: { $nin: ["FILED", "CLOSED"] }, dueDateISO: { $lte: horizon } })
      .select("title clientName dueDateISO status assignedTo source")
      .sort({ dueDateISO: 1 })
      .limit(SOURCE_LIMIT)
      .lean(),
    Reminder.find({ firmId: firm, isActive: { $ne: false }, dueDateISO: { $lte: horizon, $gte: new Date((todayNumber - 30) * 86_400_000).toISOString().slice(0, 10) } })
      .select("clientLabel typeId dueDateISO userId")
      .sort({ dueDateISO: 1 })
      .limit(SOURCE_LIMIT)
      .lean(),
    CaseMatter.find({ firmId: firm, status: { $nin: ["CLOSED", "ARCHIVED", "SUBMITTED"] }, "confirmedFacts.responseDueDate": { $ne: null } })
      .select("title clientId confirmedFacts.responseDueDate confirmedFacts.noticeType confirmedFacts.demandMinor status priority")
      .sort({ "confirmedFacts.responseDueDate": 1 })
      .limit(SOURCE_LIMIT)
      .lean(),
    ReconciliationRun.find({ firmId: firm, status: "REVIEW" })
      .select("clientId period gstin activeGenerationAttempt")
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean(),
    TdsHealthRun.find({ firmId: firm, status: "REVIEW" })
      .select("clientId financialYear quarter statementType activeGenerationAttempt")
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean(),
    Engagement.find({ firmId: firm, status: { $nin: ["COMPLETE", "ARCHIVED"] }, "clientRequests.status": { $in: ["REQUESTED", "PARTIAL"] } })
      .select("title clientId clientRequests")
      .limit(100)
      .lean(),
  ]);

  // Open reconciliation items still in play per run: ITC at stake (books tax of items missing in 2B) and the
  // supplier chases nobody has moved for a week.
  const runIds = reconRuns.map((run) => run._id);
  const chaseCutoff = new Date((todayNumber - CHASE_STALE_DAYS) * 86_400_000);
  const [atStake, staleChases] = runIds.length
    ? await Promise.all([
        ReconciliationItem.aggregate([
          { $match: { firmId: firm, runId: { $in: runIds }, isActive: { $ne: false }, resolutionState: "OPEN", status: "MISSING_IN_2B" } },
          { $group: { _id: { runId: "$runId", attempt: "$generationAttempt" }, items: { $sum: 1 }, taxMinor: { $sum: "$booksAmounts.totalTaxMinor" } } },
        ]),
        ReconciliationItem.aggregate([
          { $match: { firmId: firm, runId: { $in: runIds }, isActive: { $ne: false }, "chase.required": true, "chase.state": { $in: ["MARKED", "OPENED", "COPIED"] }, "chase.lastActionAt": { $lt: chaseCutoff } } },
          { $group: { _id: { runId: "$runId", attempt: "$generationAttempt" }, items: { $sum: 1 }, oldest: { $min: "$chase.lastActionAt" } } },
        ]),
      ])
    : [[], []];
  const tdsRunIds = tdsRuns.map((run) => run._id);
  const tdsErrors = tdsRunIds.length
    ? await TdsHealthCheck.aggregate([
        { $match: { firmId: firm, runId: { $in: tdsRunIds }, state: "OPEN", severity: "ERROR" } },
        { $group: { _id: { runId: "$runId", attempt: "$generationAttempt" }, checks: { $sum: 1 }, differenceMinor: { $sum: { $abs: "$differenceMinor" } } } },
      ])
    : [];

  const clientIds = new Set([
    ...cases.map((c) => String(c.clientId)),
    ...reconRuns.map((r) => String(r.clientId)),
    ...tdsRuns.map((r) => String(r.clientId)),
    ...engagements.map((e) => String(e.clientId)),
  ].filter(Boolean));
  const clients = clientIds.size ? await Client.find({ _id: { $in: [...clientIds] }, firmId: firm }).select("name").lean() : [];
  const clientName = new Map(clients.map((client) => [String(client._id), client.name]));

  const entries = [];
  for (const task of tasks) {
    entries.push({
      kind: "TASK", id: String(task._id), title: task.title, clientName: task.clientName || "",
      dueDateISO: task.dueDateISO, stakeMinor: 0, severity: "", mine: String(task.assignedTo || "") === String(userId),
      reasonParts: [task.status === "WAITING_DOCS" ? "waiting for documents" : ""], link: { surface: "task", id: String(task._id) },
    });
  }
  for (const reminder of reminders) {
    entries.push({
      kind: "REMINDER", id: String(reminder._id), title: reminder.typeId || "Reminder", clientName: reminder.clientLabel || "",
      dueDateISO: reminder.dueDateISO, stakeMinor: 0, severity: "", mine: String(reminder.userId || "") === String(userId),
      reasonParts: [], link: { surface: "reminder", id: String(reminder._id) },
    });
  }
  for (const caseMatter of cases) {
    const due = caseMatter.confirmedFacts?.responseDueDate;
    const demand = Number(caseMatter.confirmedFacts?.demandMinor || 0);
    entries.push({
      kind: "NOTICE", id: String(caseMatter._id), title: `Reply to ${caseMatter.confirmedFacts?.noticeType || "the notice"}: ${caseMatter.title}`,
      clientName: clientName.get(String(caseMatter.clientId)) || "", dueDateISO: due ? new Date(due).toISOString().slice(0, 10) : null,
      stakeMinor: demand, severity: caseMatter.priority === "HIGH" || caseMatter.priority === "URGENT" ? "ERROR" : "",
      reasonParts: [demand ? `demand ${formatRupees(demand)}` : ""], link: { surface: "case", id: String(caseMatter._id) },
    });
  }
  const runById = new Map(reconRuns.map((run) => [String(run._id), run]));
  for (const row of atStake) {
    const run = runById.get(String(row._id.runId));
    if (!run || String(row._id.attempt) !== String(run.activeGenerationAttempt)) continue;
    entries.push({
      kind: "GST_ITC", id: String(run._id), title: `GST reconciliation ${run.period}: ${row.items} ${row.items === 1 ? "invoice" : "invoices"} missing in GSTR-2B`,
      clientName: clientName.get(String(run.clientId)) || "", dueDateISO: null, stakeMinor: row.taxMinor, severity: "WARNING",
      reasonParts: [`ITC at stake ${formatRupees(row.taxMinor)}`], link: { surface: "gstRun", id: String(run._id) },
    });
  }
  for (const row of staleChases) {
    const run = runById.get(String(row._id.runId));
    if (!run || String(row._id.attempt) !== String(run.activeGenerationAttempt)) continue;
    const quietDays = Math.max(CHASE_STALE_DAYS, todayNumber - utcDayNumber(new Date(row.oldest)));
    entries.push({
      kind: "SUPPLIER_CHASE", id: `${run._id}:chase`, title: `Supplier follow-up for ${run.period}: ${row.items} ${row.items === 1 ? "item" : "items"} with no answer`,
      clientName: clientName.get(String(run.clientId)) || "", dueDateISO: null, stakeMinor: 0, severity: "WARNING",
      reasonParts: [`no movement for ${quietDays} days`], link: { surface: "gstRun", id: String(run._id) },
    });
  }
  const tdsById = new Map(tdsRuns.map((run) => [String(run._id), run]));
  for (const row of tdsErrors) {
    const run = tdsById.get(String(row._id.runId));
    if (!run || String(row._id.attempt) !== String(run.activeGenerationAttempt)) continue;
    entries.push({
      kind: "TDS", id: String(run._id), title: `TDS ${run.financialYear} ${run.quarter} ${run.statementType}: ${row.checks} ${row.checks === 1 ? "error" : "errors"} open`,
      clientName: clientName.get(String(run.clientId)) || "", dueDateISO: null, stakeMinor: row.differenceMinor, severity: "ERROR",
      reasonParts: [row.differenceMinor ? `differences ${formatRupees(row.differenceMinor)}` : ""], link: { surface: "tdsRun", id: String(run._id) },
    });
  }
  for (const engagement of engagements) {
    const pending = (engagement.clientRequests || []).filter((request) => ["REQUESTED", "PARTIAL"].includes(request.status));
    if (!pending.length) continue;
    const dues = pending.map((request) => (request.dueAt ? new Date(request.dueAt).toISOString().slice(0, 10) : null)).filter(Boolean).sort();
    const oldestAsked = pending.map((request) => request.requestedAt).filter(Boolean).map((at) => utcDayNumber(new Date(at))).sort((a, b) => a - b)[0];
    entries.push({
      kind: "CLIENT_REQUEST", id: String(engagement._id), title: `${pending.length} ${pending.length === 1 ? "item" : "items"} awaited from the client: ${engagement.title}`,
      clientName: clientName.get(String(engagement.clientId)) || "", dueDateISO: dues[0] || null, stakeMinor: 0, severity: "",
      reasonParts: [Number.isFinite(oldestAsked) ? `asked ${todayNumber - oldestAsked} days ago` : ""], link: { surface: "engagement", id: String(engagement._id) },
    });
  }

  const ranked = rankPriorities(entries, { today });
  // A source read up to its cap may hold more than was read, so `total` is then a floor: clients show "N+".
  const totalIsLowerBound = tasks.length >= SOURCE_LIMIT
    || reminders.length >= SOURCE_LIMIT
    || cases.length >= SOURCE_LIMIT
    || reconRuns.length >= 50
    || tdsRuns.length >= 50
    || engagements.length >= 100;
  return { ruleVersion: PRIORITY_RULE_VERSION, today: isoToday, ...ranked, totalIsLowerBound };
}
