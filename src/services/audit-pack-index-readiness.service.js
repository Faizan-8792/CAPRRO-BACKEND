// src/services/audit-pack-index-readiness.service.js
//
// W10 AP5 + AP8 (2026-10-15): the unique indexes the trial-balance import and the audit packs
// depend on, in the shape index-provisioning.service.js provisions at every boot (autoIndex is off
// in production, so an index not declared here does not exist there).
//
// Each one is load-bearing, not an optimisation:
//   - the books row generation key makes a repeated commit idempotent and a reader see one whole file;
//   - the run's source-revision key makes "create the same pack twice" return the first one;
//   - the row and evidence keys make a re-run of the worker unable to write a row twice;
//   - the party key keeps one answer per supplier, so a person's status is never split in two.
//
// assertAuditPackStorageReady() is called before every write that needs them and answers 503 when
// one is missing, rather than letting a write race a missing unique index.

import AuditPackEvidenceLink from "../models/AuditPackEvidenceLink.js";
import AuditPackRow from "../models/AuditPackRow.js";
import AuditPackRun from "../models/AuditPackRun.js";
import BooksImportRow from "../models/BooksImportRow.js";
import PartyMaster from "../models/PartyMaster.js";

const REQUIRED_AUDIT_PACK_INDEXES = Object.freeze([
  {
    model: BooksImportRow,
    label: "trial balance row generation",
    key: { firmId: 1, batchId: 1, importGeneration: 1, sourceRow: 1 },
    unique: true,
  },
  {
    model: AuditPackRun,
    label: "audit pack run source revision",
    key: { firmId: 1, kind: 1, sourceFingerprint: 1, revision: 1 },
    unique: true,
  },
  {
    model: AuditPackRow,
    label: "audit pack row generation",
    key: { firmId: 1, runId: 1, generationAttempt: 1, rowKey: 1 },
    unique: true,
  },
  {
    model: AuditPackEvidenceLink,
    label: "audit pack evidence ordinal",
    key: { firmId: 1, runId: 1, generationAttempt: 1, rowKey: 1, ordinal: 1 },
    unique: true,
  },
  {
    model: PartyMaster,
    label: "party master client GSTIN",
    key: { firmId: 1, clientId: 1, gstin: 1 },
    unique: true,
  },
]);

function orderedEntries(key) {
  return Object.entries(key || {}).map(([field, direction]) => [field, Number(direction)]);
}

function sameOrderedKey(actual, expected) {
  const a = orderedEntries(actual);
  const e = orderedEntries(expected);
  return a.length === e.length && e.every(([field, direction], index) => a[index]?.[0] === field && a[index]?.[1] === direction);
}

function isNamespaceNotFound(error) {
  return error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26;
}

async function getAuditPackIndexReadiness({ requirements = REQUIRED_AUDIT_PACK_INDEXES } = {}) {
  const diagnostics = [];
  for (const requirement of requirements) {
    let indexes;
    try {
      indexes = await requirement.model.collection.listIndexes().toArray();
    } catch (error) {
      if (!isNamespaceNotFound(error)) throw error;
      indexes = [];
    }
    const matching = indexes.filter((index) => sameOrderedKey(index.key, requirement.key));
    const valid = matching.find((index) => (!requirement.unique || index.unique === true) && index.sparse !== true);
    if (!valid) {
      diagnostics.push({
        collection: requirement.model.collection.collectionName,
        label: requirement.label,
        reason: matching.length ? "not-unique" : "missing",
      });
    }
  }
  return { ready: diagnostics.length === 0, checked: requirements.length, diagnostics };
}

async function assertAuditPackStorageReady(options) {
  const readiness = await getAuditPackIndexReadiness(options);
  if (!readiness.ready) {
    const error = new Error("Audit pack storage is being prepared. Try again in a minute.");
    error.statusCode = 503;
    error.code = "AUDIT_PACK_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export { REQUIRED_AUDIT_PACK_INDEXES, assertAuditPackStorageReady, getAuditPackIndexReadiness };
