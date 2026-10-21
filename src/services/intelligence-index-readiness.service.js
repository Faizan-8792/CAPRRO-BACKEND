// src/services/intelligence-index-readiness.service.js
//
// W11 (2026-10-21): the indexes the intelligence layer depends on, provisioned at every boot by
// index-provisioning.service.js (autoIndex is off in production) and checked before the `intelligence` flag can be
// switched on, like the audit packs' indexes before `auditPacks`:
//   - AiDraft's unique question key, which makes "the same question again is answered from the store" atomic, and
//     its TTL index, which is what removes an unadopted draft after 30 days (PLAN.md section 33.6);
//   - AiSuggestionOutcome's unique daily counter key, which the $inc upserts count against;
//   - ImportMappingProfile's unique layout key per firm, client and kind.

import AiDraft from "../models/AiDraft.js";
import AiSuggestionOutcome from "../models/AiSuggestionOutcome.js";
import ImportMappingProfile from "../models/ImportMappingProfile.js";

export const REQUIRED_INTELLIGENCE_INDEXES = Object.freeze([
  {
    model: AiDraft,
    label: "AiDraft question uniqueness",
    name: "unique_ai_draft_question",
    key: { firmId: 1, task: 1, promptVersion: 1, inputHash: 1 },
    unique: true,
  },
  {
    model: AiDraft,
    label: "AiDraft 30-day expiry",
    name: "ai_draft_ttl",
    key: { expiresAt: 1 },
    ttl: true,
  },
  {
    model: AiSuggestionOutcome,
    label: "AiSuggestionOutcome daily counter uniqueness",
    name: "unique_ai_suggestion_outcome_day",
    key: { firmId: 1, day: 1, surface: 1, source: 1, key: 1 },
    unique: true,
  },
  {
    model: ImportMappingProfile,
    label: "ImportMappingProfile layout uniqueness",
    name: "unique_import_mapping_profile",
    key: { firmId: 1, clientId: 1, kind: 1, headerSignature: 1 },
    unique: true,
  },
]);

const sameKey = (actual, expected) => {
  const a = Object.entries(actual || {});
  const e = Object.entries(expected || {});
  return a.length === e.length && e.every(([field, direction], index) => a[index]?.[0] === field && Number(a[index]?.[1]) === Number(direction));
};

export async function getIntelligenceIndexReadiness({ requirements = REQUIRED_INTELLIGENCE_INDEXES } = {}) {
  const diagnostics = [];
  for (const requirement of requirements) {
    let indexes = [];
    try {
      indexes = await requirement.model.collection.listIndexes().toArray();
    } catch (error) {
      if (!(error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26)) throw error;
    }
    const found = indexes.find((index) => sameKey(index.key, requirement.key));
    const valid = found && (requirement.unique ? found.unique === true : true) && (requirement.ttl ? Number.isFinite(found.expireAfterSeconds) : true);
    if (!valid) {
      diagnostics.push({
        collection: requirement.model.collection.collectionName,
        label: requirement.label,
        reason: found ? "wrong-options" : "missing",
        message: `${requirement.label}: ${found ? "the index exists without the required options" : "the index is missing"} on ${requirement.model.collection.collectionName}.`,
      });
    }
  }
  return { ready: diagnostics.length === 0, checked: requirements.length, diagnostics };
}

export async function assertIntelligenceIndexesReady() {
  const readiness = await getIntelligenceIndexReadiness();
  if (!readiness.ready) {
    const error = new Error(`The intelligence storage is not ready: ${readiness.diagnostics.map((d) => d.message).join(" ")}`);
    error.statusCode = 503;
    error.code = "INTELLIGENCE_INDEXES_NOT_READY";
    throw error;
  }
  return readiness;
}
