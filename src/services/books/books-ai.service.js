// src/services/books/books-ai.service.js
//
// W10 AP19 (2026-10-17): the one place AI touches the books snapshot - a SUGGESTION of which standard group
// an unrecognised Tally group belongs to. Never applied: it is returned beside the group with the words
// AI_DRAFT, and becomes a mapping only when a person accepts it through the same route a person's own
// answer takes (source AI_ACCEPTED). Metered as "audit_pack_draft" within the existing per-user and global
// DeepSeek caps. Every pack works with this switched off.
//
// What is sent: group NAMES and the names of the groups above them. No ledger names, no amounts, no GSTIN.

import { callDeepSeek } from "../deepseek-provider.service.js";
import { STANDARD_GROUPS, STANDARD_GROUP_CODES } from "./group-mapping.js";
import { groupMappingReport } from "../books-snapshot.service.js";

const MAX_GROUPS = 20;

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export function buildSuggestionPrompt(groups) {
  const codes = STANDARD_GROUP_CODES.map((code) => `${code} (${STANDARD_GROUPS[code].label})`).join("; ");
  const lines = groups.map((g, i) => `${i + 1}. "${g.name}"${g.chain.length > 1 ? ` (inside: ${g.chain.slice(1).join(" > ")})` : ""}`);
  return [
    "A company's accounting software has these groups that are not one of its predefined ones.",
    "For each, name the single standard group it most likely belongs to, using only these codes:",
    codes,
    "",
    ...lines,
    "",
    'Return strict JSON: {"suggestions":[{"index":1,"standardGroup":"CODE","why":"one short sentence"}]}.',
    "If a name does not say, leave it out. Do not invent codes.",
  ].join("\n");
}

/** Parses the model's answer, keeping only suggestions that name a real code and a real group. */
export function readSuggestions(content, groups) {
  let parsed;
  try {
    parsed = JSON.parse(String(content).replace(/^```(?:json)?|```$/gm, "").trim());
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const group = groups[Number(item?.index) - 1];
    const code = String(item?.standardGroup || "").toUpperCase();
    if (!group || !STANDARD_GROUP_CODES.includes(code) || seen.has(group.name)) continue;
    seen.add(group.name);
    out.push({ groupName: group.name, standardGroup: code, why: String(item?.why || "").slice(0, 240), status: "AI_DRAFT" });
  }
  return out;
}

export async function suggestGroupMappings({ firmId, actorUserId, snapshotId, input }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "A suggestion request must be an object");
  const extra = Object.keys(input).filter((key) => key !== "groups");
  if (extra.length) throw httpError(400, `A suggestion request does not accept: ${extra.join(", ")}`);
  const report = await groupMappingReport({ firmId, snapshotId });
  const wanted = new Set(Array.isArray(input.groups) ? input.groups.map((g) => String(g)) : report.groups.filter((g) => !g.standardGroup).map((g) => g.name));
  const groups = report.groups.filter((g) => wanted.has(g.name) && !g.standardGroup).slice(0, MAX_GROUPS);
  if (!groups.length) return { suggestions: [], available: true, note: "Every group is already mapped." };
  let result;
  try {
    result = await callDeepSeek({
      system: "You map accounting group names to a fixed list of standard groups. Return strict JSON only. Never explain beyond one short sentence per group.",
      prompt: buildSuggestionPrompt(groups),
      jsonResponse: true,
      maxTokens: 900,
      timeoutMs: 25000,
      temperature: 0,
      userId: actorUserId,
      operation: "audit_pack_draft",
    });
  } catch {
    result = { ok: false, reason: "The suggestion could not be requested." };
  }
  if (!result.ok) return { suggestions: [], available: false, note: "Suggestions are not available right now. Choose the standard group yourself." };
  return { suggestions: readSuggestions(result.content, groups), available: true, note: "Suggested by AI from the group names only. Check each before accepting." };
}
