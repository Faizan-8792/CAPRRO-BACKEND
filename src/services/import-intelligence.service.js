// src/services/import-intelligence.service.js
//
// W11 IN14 + IN15 (2026-10-21): imports that remember each client's column mapping, and a model suggestion for
// headings the synonyms cannot place.
//
// Why: every reconciliation and TDS check starts with an import, each client's register is laid out differently
// (Tally, Busy, Zoho, Marg, a title block above the headings), and nothing remembered a mapping - so the same
// client's file was mapped again by hand every month. A confirmed import now saves its mapping against the
// file's layout; the next file in the same layout gets it back. Nothing is imported or committed here: the
// preview and the commit re-validate every mapping exactly as they do a person's.

import crypto from "node:crypto";
import mongoose from "mongoose";
import AppConfig from "../models/AppConfig.js";
import Client from "../models/Client.js";
import ImportMappingProfile from "../models/ImportMappingProfile.js";
import { runAiTask } from "./ai/ai-task.service.js";
import { describeImportColumns } from "./import-preview.service.js";

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

const normaliseHeading = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** sha-256 of the normalised, ordered headings: the identity of a file layout. */
export function headerSignature(headers) {
  return crypto.createHash("sha256").update((headers || []).map(normaliseHeading).join("\u0001")).digest("hex");
}

async function intelligenceOn() {
  return AppConfig.isFeatureEnabled("intelligence", { fresh: true });
}

async function requireClient(firmId, clientId) {
  if (!mongoose.isValidObjectId(clientId)) return null;
  return Client.findOne({ _id: clientId, firmId }).select("_id").lean();
}

/**
 * The remembered mapping for this client's layout, or null. Only fields whose heading is still in the file are
 * returned, so a profile can never point at a column the file does not have.
 */
export async function rememberedMapping({ firmId, clientId, kind, headers }) {
  if (!clientId || !(await intelligenceOn())) return null;
  if (!(await requireClient(firmId, clientId))) return null;
  const profile = await ImportMappingProfile.findOneAndUpdate(
    { firmId, clientId, kind: String(kind || "").toUpperCase(), headerSignature: headerSignature(headers) },
    { $inc: { timesApplied: 1 } },
    { new: true },
  ).lean();
  if (!profile) return null;
  const present = new Set(headers);
  const mapping = Object.fromEntries(Object.entries(profile.mapping || {}).filter(([, heading]) => present.has(heading)));
  return {
    mapping,
    confirmedAt: profile.confirmedAt ? new Date(profile.confirmedAt).toISOString() : null,
    timesApplied: profile.timesApplied,
  };
}

/**
 * Saves the mapping of a confirmed import against the file's layout. Best effort: a failure to remember never
 * fails the import that was just committed. Only with the `intelligence` flag on and a client of this firm.
 */
export async function rememberConfirmedMapping({ firmId, userId, clientId, kind, text, delimiter, mapping }) {
  try {
    if (!clientId || !mapping || typeof mapping !== "object" || !(await intelligenceOn())) return false;
    if (!(await requireClient(firmId, clientId))) return false;
    const { headers, kind: normalizedKind } = describeImportColumns({ kind, text, delimiter });
    const present = new Set(headers);
    const kept = Object.fromEntries(Object.entries(mapping).filter(([field, heading]) => typeof field === "string" && present.has(heading)));
    if (!Object.keys(kept).length) return false;
    await ImportMappingProfile.updateOne(
      { firmId, clientId, kind: normalizedKind, headerSignature: headerSignature(headers) },
      {
        $set: { mapping: kept, headerCount: headers.length, confirmedBy: userId || null, confirmedAt: new Date() },
        $setOnInsert: { timesApplied: 0 },
      },
      { upsert: true },
    );
    return true;
  } catch {
    return false;
  }
}

const humanise = (field) => String(field).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Minor$/i, "").toLowerCase().trim();

/**
 * POST /api/imports/mapping-suggestions - the model's suggestion for required fields the heading synonyms left
 * unmapped. The model sees heading texts and the per-column type shares from describeImportColumns; never a
 * cell value. The answer is field -> heading, from this kind's own fields only.
 */
export async function suggestMappingsWithModel({ firmId, userId, input = {} }) {
  const allowed = new Set(["kind", "text", "delimiter", "consent"]);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "A suggestion request must be an object");
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw httpError(400, `A suggestion request does not accept: ${extra.join(", ")}`);
  let described;
  try {
    described = describeImportColumns({ kind: input.kind, text: input.text, delimiter: input.delimiter || null });
  } catch (error) {
    throw httpError(400, "The file could not be read for its headings.", "IMPORT_HEADINGS_UNREADABLE");
  }
  const fieldsToMap = described.missingRequired;
  if (!fieldsToMap.length) {
    return { available: true, suggestions: {}, draftId: null, note: "Every required field is already mapped from its heading." };
  }
  const mapped = new Set(Object.values(described.suggestedMapping));
  const headings = described.headers
    .map((text, index) => ({ ref: `h${index + 1}`, text, profile: described.profiles[index], mapped: mapped.has(text) }))
    .filter((heading) => heading.text && !heading.mapped)
    .map(({ mapped: _mapped, ...rest }) => rest);
  if (!headings.length) {
    return { available: true, suggestions: {}, draftId: null, note: "No unmapped heading is left to suggest from." };
  }
  const facts = {
    kind: described.kind,
    fieldsToMap: fieldsToMap.map((name) => ({ name, description: humanise(name), required: true })),
    headings,
  };
  const result = await runAiTask({
    taskName: "import_mapping_suggest",
    firmId,
    userId,
    consent: input.consent,
    units: [{ id: "file", facts, subject: { kind: "ImportLayout", id: `${described.kind}:${headerSignature(described.headers)}` } }],
  });
  const draft = result.results[0]?.draft || null;
  if (!draft) return { available: false, suggestions: {}, draftId: null, note: result.note };
  const headingByRef = new Map(headings.map((heading) => [heading.ref, heading.text]));
  const suggestions = {};
  for (const entry of draft.output.mappings || []) {
    if (entry.headingRef !== "NONE" && headingByRef.has(entry.headingRef)) suggestions[entry.field] = headingByRef.get(entry.headingRef);
  }
  return {
    available: true,
    suggestions,
    draftId: draft.id,
    abstained: draft.abstained,
    label: "DRAFT FOR REVIEW",
    note: Object.keys(suggestions).length
      ? "Suggested by AI from the headings and column types only. Check each before you preview the file."
      : "No heading clearly holds the missing fields. Map them yourself.",
  };
}
