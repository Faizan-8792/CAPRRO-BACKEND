// src/services/books-snapshot.service.js
//
// W10 AP18-AP21 (2026-10-17): books snapshots, their group mapping, the party master completed from
// them, and the difference between two of them.
//
//   create        a DRAFT snapshot for one client and financial year
//   ingestChunk   validated NDJSON records, hashed, in order, idempotent on a repeat, never half-written
//   seal          counts and the digest of the chunks verified; the snapshot is then immutable
//   groups        every group resolved to a standard group by rule, the rest listed for a person
//   parties       debtors, creditors and lenders seeded from the ledgers, never over a person's answer
//   diff          two sealed snapshots of one client and year compared voucher by voucher
//
// Firm scoping is on every query. Nothing here reads a Tally database; the records arrive from the person's
// own PC, and only the records of their own client's books.

import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import BooksGroup from "../models/BooksGroup.js";
import BooksLedger from "../models/BooksLedger.js";
import BooksParty, { BOOKS_PARTY_UDYAM } from "../models/BooksParty.js";
import BooksSnapshot, { BOOKS_CHUNK_KINDS, BOOKS_SNAPSHOT_SOURCES } from "../models/BooksSnapshot.js";
import BooksVoucher from "../models/BooksVoucher.js";
import Client from "../models/Client.js";
import GroupMapping from "../models/GroupMapping.js";
import PartyMaster from "../models/PartyMaster.js";
import { safeRecordActivity } from "./activity.service.js";
import { financialYearMonths } from "./audit-pack-engine/clause44.engine.js";
import {
  LENDER_GROUPS,
  PARTY_GROUPS,
  STANDARD_GROUPS,
  STANDARD_GROUP_CODES,
  createGroupResolver,
  groupKey,
  standardGroupOfLedger,
} from "./books/group-mapping.js";
import { chunkDigest, parseChunk, sha256 } from "./books/tally-canonical.js";

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function objectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw httpError(400, `${label} is not a valid id`);
  return new mongoose.Types.ObjectId(String(value));
}

function assertAllowed(input, allowed, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, `${label} must be an object`);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw httpError(400, `${label} does not accept: ${extra.join(", ")}`);
}

function financialYearOf(value) {
  const text = String(value || "").trim();
  try {
    financialYearMonths(text);
  } catch {
    throw httpError(400, "Choose a financial year like 2025-26.");
  }
  return text;
}

async function requireClient(firmId, clientId) {
  const client = await Client.findOne({ _id: objectId(clientId, "Client"), firmId, isActive: true }).select("_id name").lean();
  if (!client) throw httpError(404, "That client is not in this firm.");
  return client;
}

export function serializeSnapshot(s) {
  return {
    id: String(s._id),
    clientId: String(s.clientId),
    financialYear: s.financialYear,
    source: s.source,
    label: s.label || "",
    schemaVersion: s.schemaVersion,
    status: s.status,
    counts: { groups: s.counts?.groups || 0, ledgers: s.counts?.ledgers || 0, vouchers: s.counts?.vouchers || 0 },
    chunkCounts: { groups: s.chunkCounts?.groups || 0, ledgers: s.chunkCounts?.ledgers || 0, vouchers: s.chunkCounts?.vouchers || 0 },
    alterId: { min: s.alterId?.min ?? null, max: s.alterId?.max ?? null },
    voucherDates: { min: s.voucherDates?.min ?? null, max: s.voucherDates?.max ?? null },
    warnings: {
      recordsWithWarnings: s.warnings?.recordsWithWarnings || 0,
      amountsUnreadable: s.warnings?.amountsUnreadable || 0,
      datesUnreadable: s.warnings?.datesUnreadable || 0,
    },
    contentHash: s.contentHash || null,
    createdAt: s.createdAt,
    sealedAt: s.sealedAt || null,
  };
}

// ─── snapshots ──────────────────────────────────────────────────────────

const CREATE_FIELDS = new Set(["clientId", "financialYear", "source", "label"]);

export async function createSnapshot({ firmId, actorUserId, requestId = "", input }) {
  assertAllowed(input, CREATE_FIELDS, "A books snapshot");
  const client = await requireClient(firmId, input.clientId);
  const financialYear = financialYearOf(input.financialYear);
  const source = String(input.source || "TALLY_XML").toUpperCase();
  if (!BOOKS_SNAPSHOT_SOURCES.includes(source)) throw httpError(400, "The source is TALLY_XML or EXCEL.");
  const label = String(input.label ?? "").trim().slice(0, 120);
  const snapshot = await BooksSnapshot.create({ firmId, clientId: client._id, financialYear, source, label, createdBy: actorUserId });
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "BOOKS_SNAPSHOT_CREATED",
    entityType: "BooksSnapshot",
    entityId: snapshot._id,
    requestId,
    afterSummary: { clientId: client._id, financialYear, source },
  });
  return serializeSnapshot(snapshot.toObject());
}

export async function listSnapshots({ firmId, query = {} }) {
  const filter = { firmId };
  if (query.clientId) filter.clientId = objectId(query.clientId, "Client");
  if (query.financialYear) filter.financialYear = financialYearOf(query.financialYear);
  if (query.status) filter.status = String(query.status).toUpperCase() === "SEALED" ? "SEALED" : "DRAFT";
  const snapshots = await BooksSnapshot.find(filter).sort({ createdAt: -1, _id: -1 }).limit(50).lean();
  return { snapshots: snapshots.map(serializeSnapshot) };
}

async function requireSnapshot(firmId, snapshotId, { fields = null } = {}) {
  const query = BooksSnapshot.findOne({ _id: objectId(snapshotId, "Snapshot"), firmId });
  if (fields) query.select(fields);
  const snapshot = await query.lean();
  if (!snapshot) throw httpError(404, "That books snapshot is not in this firm.");
  return snapshot;
}

export async function getSnapshot({ firmId, snapshotId }) {
  return serializeSnapshot(await requireSnapshot(firmId, snapshotId));
}

// ─── chunks ─────────────────────────────────────────────────────────────

const CHUNK_FIELDS = new Set(["kind", "seq", "ndjson", "hash"]);
const MODEL_FOR_KIND = Object.freeze({ groups: BooksGroup, ledgers: BooksLedger, vouchers: BooksVoucher });

/**
 * Accepts one chunk. A repeat of a chunk already accepted (same position, same hash) answers duplicate
 * without storing it again; a chunk out of order, or a different chunk at an accepted position, is refused.
 */
export async function ingestChunk({ firmId, actorUserId, snapshotId, input }) {
  assertAllowed(input, CHUNK_FIELDS, "A chunk");
  const kind = String(input.kind || "");
  if (!BOOKS_CHUNK_KINDS.includes(kind)) throw httpError(400, "A chunk is groups, ledgers or vouchers.");
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw httpError(400, "A chunk needs its position (seq), starting at 0.");
  if (typeof input.hash !== "string" || !/^[a-f0-9]{64}$/.test(input.hash)) throw httpError(400, "A chunk needs the SHA-256 of its text.");
  if (typeof input.ndjson !== "string") throw httpError(400, "A chunk needs its records as text.");

  const snapshot = await requireSnapshot(firmId, snapshotId);
  if (snapshot.status !== "DRAFT") throw httpError(409, "This snapshot is sealed and cannot change. Make a new snapshot for a new export.", "BOOKS_SNAPSHOT_SEALED");
  if (sha256(input.ndjson) !== input.hash) throw httpError(400, "The chunk does not match its hash; it was changed or cut in transit. Send it again.", "BOOKS_CHUNK_HASH_MISMATCH");

  const logged = (snapshot.chunkLog || []).find((c) => c.kind === kind && c.seq === input.seq);
  if (logged) {
    if (logged.hash === input.hash) return { snapshot: serializeSnapshot(snapshot), duplicate: true, accepted: 0 };
    throw httpError(409, `Chunk ${input.seq} of ${kind} was already accepted with different contents.`, "BOOKS_CHUNK_CONFLICT");
  }
  const expected = snapshot.chunkCounts?.[kind] || 0;
  if (input.seq !== expected) {
    throw httpError(409, `Send chunk ${expected} of ${kind} next; this was chunk ${input.seq}.`, "BOOKS_CHUNK_OUT_OF_ORDER");
  }

  let parsed;
  try {
    parsed = parseChunk(kind, input.ndjson);
  } catch (error) {
    if (error instanceof RangeError) throw httpError(400, error.message, "BOOKS_CHUNK_INVALID");
    throw error;
  }

  const token = randomUUID();
  const Model = MODEL_FOR_KIND[kind];
  try {
    await Model.insertMany(
      parsed.docs.map((doc) => ({ ...doc, firmId, snapshotId: snapshot._id, chunkToken: token })),
      { ordered: true },
    );
  } catch (error) {
    await Model.deleteMany({ firmId, snapshotId: snapshot._id, chunkToken: token }).catch(() => {});
    if (error?.code === 11000) throw httpError(409, "A record in this chunk is already in the snapshot.", "BOOKS_DUPLICATE_RECORD");
    throw error;
  }

  // Claim the position. The filter names the chunk count this request read, so two uploads of the same
  // position cannot both win; the loser removes only the records it wrote (by its own token).
  const update = {
    $push: { chunkLog: { kind, seq: input.seq, hash: input.hash, count: parsed.count } },
    $inc: {
      [`chunkCounts.${kind}`]: 1,
      [`counts.${kind}`]: parsed.count,
      "warnings.recordsWithWarnings": parsed.recordsWithWarnings,
      "warnings.amountsUnreadable": parsed.amountsUnreadable,
      "warnings.datesUnreadable": parsed.datesUnreadable,
    },
  };
  const claimed = await BooksSnapshot.findOneAndUpdate(
    { _id: snapshot._id, firmId, status: "DRAFT", [`chunkCounts.${kind}`]: expected },
    update,
    { new: true },
  );
  if (!claimed) {
    await Model.deleteMany({ firmId, snapshotId: snapshot._id, chunkToken: token }).catch(() => {});
    const again = await requireSnapshot(firmId, snapshotId);
    const twin = (again.chunkLog || []).find((c) => c.kind === kind && c.seq === input.seq);
    if (twin && twin.hash === input.hash) return { snapshot: serializeSnapshot(again), duplicate: true, accepted: 0 };
    throw httpError(409, "Another upload took this position first. Reload the snapshot and continue from its next chunk.", "BOOKS_CHUNK_CONFLICT");
  }

  // Ranges only widen, so they can follow the claim without a race that matters. They are set from the
  // stored values rather than with $min/$max, because a null in Mongo sorts below every number.
  const fresh = await BooksSnapshot.findById(snapshot._id).lean();
  const set = {};
  if (parsed.alterMin !== null) {
    set["alterId.min"] = fresh.alterId?.min === null || fresh.alterId?.min === undefined ? parsed.alterMin : Math.min(fresh.alterId.min, parsed.alterMin);
    set["alterId.max"] = fresh.alterId?.max === null || fresh.alterId?.max === undefined ? parsed.alterMax : Math.max(fresh.alterId.max, parsed.alterMax);
  }
  if (parsed.dateMin !== null) {
    set["voucherDates.min"] = !fresh.voucherDates?.min || parsed.dateMin < fresh.voucherDates.min ? parsed.dateMin : fresh.voucherDates.min;
    set["voucherDates.max"] = !fresh.voucherDates?.max || parsed.dateMax > fresh.voucherDates.max ? parsed.dateMax : fresh.voucherDates.max;
  }
  const final = Object.keys(set).length
    ? await BooksSnapshot.findOneAndUpdate({ _id: snapshot._id, firmId }, { $set: set }, { new: true }).lean()
    : claimed.toObject();
  return { snapshot: serializeSnapshot(final), duplicate: false, accepted: parsed.count };
}

// ─── seal ───────────────────────────────────────────────────────────────

const SEAL_FIELDS = new Set(["counts", "chunkDigest"]);

export async function sealSnapshot({ firmId, actorUserId, requestId = "", snapshotId, input }) {
  assertAllowed(input, SEAL_FIELDS, "A seal");
  const snapshot = await requireSnapshot(firmId, snapshotId);
  if (snapshot.status === "SEALED") return { snapshot: serializeSnapshot(snapshot), alreadySealed: true };
  const claimed = input.counts;
  if (!claimed || typeof claimed !== "object") throw httpError(400, "Say how many groups, ledgers and vouchers were sent.");
  for (const kind of BOOKS_CHUNK_KINDS) {
    if (!Number.isSafeInteger(claimed[kind]) || claimed[kind] < 0) throw httpError(400, `The count of ${kind} must be a whole number.`);
  }
  // Counted from what is stored, not from what the upload kept saying.
  const stored = {};
  for (const kind of BOOKS_CHUNK_KINDS) stored[kind] = await MODEL_FOR_KIND[kind].countDocuments({ firmId, snapshotId: snapshot._id });
  const mismatched = BOOKS_CHUNK_KINDS.filter((kind) => stored[kind] !== claimed[kind] || stored[kind] !== (snapshot.counts?.[kind] || 0));
  if (mismatched.length) {
    throw httpError(409, `The snapshot holds ${mismatched.map((k) => `${stored[k]} ${k}`).join(", ")} but ${mismatched.map((k) => `${claimed[k]} ${k}`).join(", ")} were expected. Send the missing chunks, or start a new snapshot.`, "BOOKS_SNAPSHOT_COUNT_MISMATCH");
  }
  if (stored.groups + stored.ledgers + stored.vouchers === 0) throw httpError(409, "A snapshot with no records cannot be sealed.", "BOOKS_SNAPSHOT_EMPTY");
  const digest = chunkDigest(snapshot.chunkLog || []);
  if (typeof input.chunkDigest !== "string" || input.chunkDigest !== digest) {
    throw httpError(409, "The chunks the server holds are not the chunks the upload sent (their digests differ). Start a new snapshot.", "BOOKS_SNAPSHOT_DIGEST_MISMATCH");
  }
  const sealed = await BooksSnapshot.findOneAndUpdate(
    { _id: snapshot._id, firmId, status: "DRAFT" },
    { $set: { status: "SEALED", contentHash: digest, sealedBy: actorUserId, sealedAt: new Date() } },
    { new: true },
  ).lean();
  if (!sealed) return { snapshot: serializeSnapshot(await requireSnapshot(firmId, snapshotId)), alreadySealed: true };
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "BOOKS_SNAPSHOT_SEALED",
    entityType: "BooksSnapshot",
    entityId: sealed._id,
    requestId,
    afterSummary: { counts: stored, contentHash: digest },
  });
  return { snapshot: serializeSnapshot(sealed), alreadySealed: false };
}

// ─── reading a snapshot for the engines ───────────────────────────────────

/** Groups and ledgers of a snapshot with each ledger's standard group resolved. Masters are small: held whole. */
export async function readSnapshotMasters({ firmId, snapshotId }) {
  const snapshot = await requireSnapshot(firmId, snapshotId);
  const [groups, ledgers, mappings] = await Promise.all([
    BooksGroup.find({ firmId, snapshotId: snapshot._id }).select("name parent reserved").lean(),
    BooksLedger.find({ firmId, snapshotId: snapshot._id }).lean(),
    GroupMapping.find({ firmId, clientId: snapshot.clientId }).select("groupKey standardGroup").lean(),
  ]);
  const resolver = createGroupResolver({ groups, mappings: new Map(mappings.map((m) => [m.groupKey, m.standardGroup])) });
  const resolvedLedgers = ledgers.map((ledger) => {
    const resolution = standardGroupOfLedger(resolver, ledger);
    return { ...ledger, standardGroup: resolution.standardGroup, groupSource: resolution.source, groupChain: resolution.chain, groupProblem: resolution.reason };
  });
  return { snapshot, groups, ledgers: resolvedLedgers, resolver };
}

/** Vouchers of a snapshot in date order, a page at a time, so a year's day book is never held whole. */
export async function* streamVouchers({ firmId, snapshotId, filter = {}, batchSize = 2_000 }) {
  const id = objectId(snapshotId, "Snapshot");
  let lastId = null;
  for (;;) {
    const query = { firmId, snapshotId: id, ...filter };
    if (lastId) query._id = { $gt: lastId };
    const page = await BooksVoucher.find(query).sort({ _id: 1 }).limit(batchSize).lean();
    if (!page.length) return;
    for (const voucher of page) yield voucher;
    lastId = page[page.length - 1]._id;
    if (page.length < batchSize) return;
  }
}

// ─── group mapping (AP19) ───────────────────────────────────────────────────

export async function groupMappingReport({ firmId, snapshotId }) {
  const { snapshot, groups, ledgers, resolver } = await readSnapshotMasters({ firmId, snapshotId });
  const countByParent = new Map();
  for (const ledger of ledgers) countByParent.set(groupKey(ledger.parent), (countByParent.get(groupKey(ledger.parent)) || 0) + 1);
  const names = new Map();
  for (const group of groups) names.set(groupKey(group.name), group.name);
  for (const ledger of ledgers) if (ledger.parent) names.set(groupKey(ledger.parent), names.get(groupKey(ledger.parent)) || ledger.parent);
  const rows = [...names.values()].map((name) => {
    const entry = resolver.resolve(name);
    return {
      name,
      chain: entry.chain,
      standardGroup: entry.standardGroup,
      source: entry.source,
      reason: entry.reason,
      ledgers: countByParent.get(groupKey(name)) || 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const unmapped = rows.filter((r) => !r.standardGroup);
  const noParent = ledgers.filter((l) => !l.parent).length;
  return {
    snapshotId: String(snapshot._id),
    standardGroups: STANDARD_GROUP_CODES.map((code) => ({ code, label: STANDARD_GROUPS[code].label, nature: STANDARD_GROUPS[code].nature })),
    groups: rows,
    unmappedGroups: unmapped.length,
    unmappedLedgers: ledgers.filter((l) => !l.standardGroup).length,
    ledgersWithNoGroup: noParent,
  };
}

const MAPPING_FIELDS = new Set(["clientId", "groupName", "standardGroup", "source"]);

export async function setGroupMapping({ firmId, actorUserId, requestId = "", input }) {
  assertAllowed(input, MAPPING_FIELDS, "A group mapping");
  const client = await requireClient(firmId, input.clientId);
  const groupName = String(input.groupName ?? "").trim().slice(0, 300);
  if (!groupName) throw httpError(400, "Name the Tally group.");
  const standardGroup = String(input.standardGroup || "").toUpperCase();
  if (!STANDARD_GROUP_CODES.includes(standardGroup)) throw httpError(400, "That is not one of the standard groups.");
  const source = input.source === "AI_ACCEPTED" ? "AI_ACCEPTED" : "USER";
  const mapping = await GroupMapping.findOneAndUpdate(
    { firmId, clientId: client._id, groupKey: groupKey(groupName) },
    { $set: { groupName, standardGroup, source, setBy: actorUserId, setAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "BOOKS_GROUP_MAPPED",
    entityType: "GroupMapping",
    entityId: mapping._id,
    requestId,
    afterSummary: { groupName, standardGroup, source },
  });
  return { groupName: mapping.groupName, standardGroup: mapping.standardGroup, source: mapping.source };
}

// ─── parties (AP20) ───────────────────────────────────────────────────────

export function serializeBooksParty(p, gstStatus = null) {
  return {
    id: String(p._id),
    clientId: String(p.clientId),
    name: p.name,
    standardGroup: p.standardGroup,
    gstin: p.gstin,
    pan: p.pan,
    gstRegistrationType: p.gstRegistrationType,
    gstStatus,
    udyamNumber: p.udyamNumber,
    udyamCategory: p.udyamCategory,
    relatedPerson: p.relatedPerson,
    lenderOrDepositor: p.lenderOrDepositor,
    lenderHint: p.lenderHint,
    creditPeriodDays: p.creditPeriodDays,
    isBillwise: p.isBillwise,
    blanks: p.blanks || [],
    version: p.version || 0,
    confirmedBy: p.confirmedBy ? String(p.confirmedBy) : null,
    confirmedAt: p.confirmedAt || null,
  };
}

/**
 * Seeds the party master from a sealed snapshot's debtors, creditors and lenders. Idempotent. What Tally holds
 * is refreshed; a flag a person set (confirmedBy) is never touched, and an unknown flag stays unknown.
 */
export async function seedParties({ firmId, actorUserId, requestId = "", snapshotId }) {
  const { snapshot, ledgers } = await readSnapshotMasters({ firmId, snapshotId });
  if (snapshot.status !== "SEALED") throw httpError(409, "Seal the snapshot before building the party master from it.", "BOOKS_SNAPSHOT_NOT_SEALED");
  const parties = ledgers.filter((l) => PARTY_GROUPS.includes(l.standardGroup));
  const operations = [];
  for (const ledger of parties) {
    const blanks = [];
    if (!ledger.gstin) blanks.push("GSTIN");
    if (!ledger.pan) blanks.push("PAN");
    if (ledger.creditPeriodDays === null || ledger.creditPeriodDays === undefined) blanks.push("CREDIT_PERIOD");
    if (!ledger.udyam) blanks.push("UDYAM");
    const lenderHint = LENDER_GROUPS.includes(ledger.standardGroup) ? true : null;
    operations.push({
      updateOne: {
        filter: { firmId, clientId: snapshot.clientId, nameKey: groupKey(ledger.name) },
        update: {
          $set: {
            name: ledger.name,
            standardGroup: ledger.standardGroup,
            gstin: ledger.gstin || "",
            pan: ledger.pan || "",
            gstRegistrationType: ledger.gstRegistrationType || "",
            udyamNumber: ledger.udyam || "",
            lenderHint,
            creditPeriodDays: ledger.creditPeriodDays ?? null,
            isBillwise: ledger.isBillwise ?? null,
            blanks,
            seededFromSnapshotId: snapshot._id,
          },
          $setOnInsert: { firmId, clientId: snapshot.clientId, nameKey: groupKey(ledger.name), udyamCategory: "UNKNOWN", relatedPerson: null, lenderOrDepositor: null },
        },
        upsert: true,
      },
    });
  }
  if (operations.length) await BooksParty.bulkWrite(operations, { ordered: false });
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "BOOKS_PARTIES_SEEDED",
    entityType: "BooksSnapshot",
    entityId: snapshot._id,
    requestId,
    afterSummary: { parties: parties.length },
  });
  return listParties({ firmId, query: { clientId: String(snapshot.clientId) } });
}

export async function listParties({ firmId, query = {} }) {
  const client = await requireClient(firmId, query.clientId);
  const parties = await BooksParty.find({ firmId, clientId: client._id }).sort({ nameKey: 1 }).limit(5_000).lean();
  const gstins = [...new Set(parties.map((p) => p.gstin).filter(Boolean))];
  const statuses = gstins.length
    ? await PartyMaster.find({ firmId, clientId: client._id, gstin: { $in: gstins } }).select("gstin gstStatus confirmedBy").lean()
    : [];
  const statusOf = new Map(statuses.map((s) => [s.gstin, s.confirmedBy ? s.gstStatus : "UNKNOWN"]));
  const rows = parties.map((p) => serializeBooksParty(p, p.gstin ? statusOf.get(p.gstin) || "UNKNOWN" : "NO_GSTIN_IN_TALLY"));
  return {
    parties: rows,
    counts: {
      total: rows.length,
      udyamCategoryUnknown: rows.filter((p) => p.udyamCategory === "UNKNOWN").length,
      relatedPersonUnknown: rows.filter((p) => p.relatedPerson === null).length,
      lenderUnconfirmed: rows.filter((p) => p.lenderHint && p.lenderOrDepositor === null).length,
      gstinBlank: rows.filter((p) => !p.gstin).length,
    },
  };
}

const PARTY_PATCH_FIELDS = new Set(["expectedVersion", "udyamCategory", "relatedPerson", "lenderOrDepositor"]);

export async function updateBooksParty({ firmId, actorUserId, requestId = "", partyId, input }) {
  assertAllowed(input, PARTY_PATCH_FIELDS, "A party");
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw httpError(400, "expectedVersion is required.");
  const set = {};
  if (input.udyamCategory !== undefined) {
    const category = String(input.udyamCategory).toUpperCase();
    if (!BOOKS_PARTY_UDYAM.includes(category)) throw httpError(400, "The category is MICRO, SMALL, MEDIUM, NOT_MSME or UNKNOWN.");
    set.udyamCategory = category;
  }
  for (const key of ["relatedPerson", "lenderOrDepositor"]) {
    if (input[key] === undefined) continue;
    if (input[key] !== null && typeof input[key] !== "boolean") throw httpError(400, `${key} is true, false or null (unknown).`);
    set[key] = input[key];
  }
  if (!Object.keys(set).length) throw httpError(400, "Say what to change.");
  const updated = await BooksParty.findOneAndUpdate(
    { _id: objectId(partyId, "Party"), firmId, version: expectedVersion },
    { $set: { ...set, confirmedBy: actorUserId, confirmedAt: new Date() }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    const exists = await BooksParty.exists({ _id: objectId(partyId, "Party"), firmId });
    if (!exists) throw httpError(404, "That party is not in this firm.");
    throw httpError(409, "Someone else changed this party since you opened it. Reload it and answer again.", "PARTY_CHANGED");
  }
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "BOOKS_PARTY_UPDATED",
    entityType: "BooksParty",
    entityId: updated._id,
    requestId,
    afterSummary: set,
  });
  return serializeBooksParty(updated, null);
}

// ─── the difference between two snapshots (AP21) ───────────────────────────────

const DIFF_SAMPLE = 200;

function describe(voucher) {
  return { guid: voucher.guid, date: voucher.date, type: voucher.type, number: voucher.number, alterId: voucher.alterId };
}

function amountsDiffer(a, b) {
  const total = (v) => (v.entries || []).reduce((sum, e) => sum + Math.abs(e.amountMinor || 0), 0);
  return total(a) !== total(b) || (a.entries || []).length !== (b.entries || []).length;
}

/**
 * Compares a base snapshot (the first export) with a later one of the same client and year, voucher by
 * voucher, by merging two ordered cursors - neither snapshot is held in memory. Returns what was inserted,
 * deleted and altered after the base, and for each altered voucher which of date, type, number, narration,
 * party, cancellation or amounts changed.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It shows what changed in the books between two exports. It does
 * not show who changed it or when, and an edit made and undone between the two exports is invisible. It is
 * evidence for the person's judgement on the audit-trail rule, never a conclusion of its own.
 */
export async function diffSnapshots({ firmId, baseId, otherId }) {
  const base = await requireSnapshot(firmId, baseId);
  const other = await requireSnapshot(firmId, otherId);
  if (String(base._id) === String(other._id)) throw httpError(400, "Choose two different snapshots.");
  if (base.status !== "SEALED" || other.status !== "SEALED") throw httpError(409, "Both snapshots must be sealed to be compared.", "BOOKS_SNAPSHOT_NOT_SEALED");
  if (String(base.clientId) !== String(other.clientId) || base.financialYear !== other.financialYear) {
    throw httpError(400, "The two snapshots are for different clients or years.", "BOOKS_SNAPSHOT_MISMATCH");
  }
  const baseIsFirst = base.createdAt <= other.createdAt;
  const first = baseIsFirst ? base : other;
  const second = baseIsFirst ? other : base;

  const open = (snapshot) => BooksVoucher.find({ firmId, snapshotId: snapshot._id }).sort({ recordKey: 1 }).lean().cursor();
  const a = open(first);
  const b = open(second);
  const counts = { inserted: 0, deleted: 0, altered: 0, unchanged: 0 };
  const samples = { inserted: [], deleted: [], altered: [] };
  const alteredFields = { date: 0, type: 0, number: 0, narration: 0, partyLedger: 0, cancelled: 0, amounts: 0, other: 0 };
  let alteredAfterBase = 0;
  const baseMax = first.alterId?.max ?? null;
  let left = await a.next();
  let right = await b.next();
  const push = (list, item) => { if (list.length < DIFF_SAMPLE) list.push(item); };
  while (left || right) {
    if (left && (!right || left.recordKey < right.recordKey)) {
      counts.deleted += 1;
      push(samples.deleted, describe(left));
      left = await a.next();
    } else if (right && (!left || right.recordKey < left.recordKey)) {
      counts.inserted += 1;
      push(samples.inserted, describe(right));
      if (baseMax !== null && right.alterId !== null && right.alterId > baseMax) alteredAfterBase += 1;
      right = await b.next();
    } else {
      if (left.lineHash === right.lineHash) {
        counts.unchanged += 1;
      } else {
        counts.altered += 1;
        const changed = [];
        for (const field of ["date", "type", "number", "narration", "partyLedger", "cancelled"]) {
          if (left[field] !== right[field]) { alteredFields[field] += 1; changed.push(field); }
        }
        if (amountsDiffer(left, right)) { alteredFields.amounts += 1; changed.push("amounts"); }
        if (!changed.length) { alteredFields.other += 1; changed.push("other"); }
        if (baseMax !== null && right.alterId !== null && right.alterId > baseMax) alteredAfterBase += 1;
        push(samples.altered, { ...describe(right), baseAlterId: left.alterId, otherAlterId: right.alterId, changed });
      }
      left = await a.next();
      right = await b.next();
    }
  }
  return {
    base: serializeSnapshot(first),
    other: serializeSnapshot(second),
    counts,
    alteredFields,
    changedAfterBaseAlterId: alteredAfterBase,
    samples,
    truncated: counts.inserted > DIFF_SAMPLE || counts.deleted > DIFF_SAMPLE || counts.altered > DIFF_SAMPLE,
    limits: "This compares two exports of the books. It does not show who changed a record or when, and a change made and undone between the two exports is not visible.",
  };
}
