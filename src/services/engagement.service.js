import mongoose from "mongoose";
import {
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TYPES,
  getEngagementTemplate,
  listEngagementTemplates,
} from "../config/engagement-templates.js";
import ActivityEvent from "../models/ActivityEvent.js";
import AppConfig from "../models/AppConfig.js";
import CaseMatter from "../models/CaseMatter.js";
import Client from "../models/Client.js";
import Engagement from "../models/Engagement.js";
import FirmMembership from "../models/FirmMembership.js";
import EngagementFinding, {
  FINDING_RISKS,
  FINDING_STATUSES,
  FOLLOW_UP_RESULTS,
} from "../models/EngagementFinding.js";
import Task from "../models/Task.js";
import TaxWorkSession from "../models/TaxWorkSession.js";
import User from "../models/User.js";
import { recordActivity } from "./activity.service.js";
import {
  assertMutationRequestHash,
  boundedStringArray,
  boundedText,
  hashText,
  httpError,
  mutationKey,
  mutationRequestHash,
  objectId,
  parseDateValue,
  stableJson,
} from "./case-validation.service.js";

const ENGAGEMENT_STATUS_SET = new Set(ENGAGEMENT_STATUSES);
const ENGAGEMENT_TYPE_SET = new Set(ENGAGEMENT_TYPES);
const FINDING_STATUS_SET = new Set(FINDING_STATUSES);
const FINDING_RISK_SET = new Set(FINDING_RISKS);
const FOLLOW_UP_RESULT_SET = new Set(FOLLOW_UP_RESULTS);
const MAX_LIST_LIMIT = 100;
const MAX_DETAIL_LIMIT = 50;
const MAX_FINGERPRINT_FINDINGS = 5000;
const MAX_EXPORT_RECORDS = 10000;
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

const CREATE_FIELDS = new Set([
  "mutationKey",
  "clientId",
  "engagementType",
  "title",
  "period",
  "scope",
  "ownerUserId",
  "teamUserIds",
  "reviewerUserId",
  "startDate",
  "targetDate",
  "linkedTaskIds",
  "linkedTaxWorkSessionIds",
  "linkedCaseIds",
]);
const PATCH_FIELDS = new Set([
  "mutationKey",
  "expectedRevision",
  "title",
  "period",
  "scope",
  "status",
  "stage",
  "ownerUserId",
  "teamUserIds",
  "reviewerUserId",
  "startDate",
  "targetDate",
  "linkedTaskIds",
  "linkedTaxWorkSessionIds",
  "linkedCaseIds",
  "closureSummary",
  "outcome",
  "checklistUpdates",
  "milestoneUpdates",
  "clientRequestUpdates",
  "deliverableUpdates",
  "reviewPointAdds",
  "reviewPointUpdates",
]);
const FINDING_CREATE_FIELDS = new Set([
  "mutationKey",
  "title",
  "description",
  "category",
  "risk",
  "evidenceReferences",
]);
const FINDING_PATCH_FIELDS = new Set([
  "mutationKey",
  "expectedRevision",
  "title",
  "description",
  "category",
  "risk",
  "evidenceReferences",
  "managementResponseText",
  "actionPlan",
  "actionOwnerUserId",
  "actionDueAt",
  "actionCompletedAt",
  "actionCompletionNote",
  "followUpResult",
  "followUpNote",
  "reviewDecision",
  "reviewNote",
  "status",
]);
const REVIEW_FIELDS = new Set([
  "mutationKey",
  "expectedRevision",
  "action",
  "confirmed",
  "reviewerName",
  "credentialReference",
  "note",
]);

const STATUS_TRANSITIONS = Object.freeze({
  DRAFT: new Set(["PLANNING", "ARCHIVED"]),
  PLANNING: new Set(["DRAFT", "IN_PROGRESS", "ARCHIVED"]),
  IN_PROGRESS: new Set(["PLANNING", "CLIENT_INPUT_PENDING", "INTERNAL_REVIEW", "ARCHIVED"]),
  CLIENT_INPUT_PENDING: new Set(["IN_PROGRESS", "INTERNAL_REVIEW", "ARCHIVED"]),
  INTERNAL_REVIEW: new Set(["IN_PROGRESS", "CLIENT_REVIEW", "FINALIZATION", "ARCHIVED"]),
  CLIENT_REVIEW: new Set(["INTERNAL_REVIEW", "FINALIZATION", "ARCHIVED"]),
  FINALIZATION: new Set(["INTERNAL_REVIEW", "CLIENT_REVIEW", "COMPLETE", "ARCHIVED"]),
  COMPLETE: new Set(["ARCHIVED"]),
  ARCHIVED: new Set(),
});

const FINDING_TRANSITIONS = Object.freeze({
  OPEN: new Set(["MANAGEMENT_RESPONSE_PENDING"]),
  MANAGEMENT_RESPONSE_PENDING: new Set(["ACTION_IN_PROGRESS"]),
  ACTION_IN_PROGRESS: new Set(["FOLLOW_UP_PENDING"]),
  FOLLOW_UP_PENDING: new Set(["ACTION_IN_PROGRESS", "READY_FOR_REVIEW"]),
  READY_FOR_REVIEW: new Set(["ACTION_IN_PROGRESS", "FOLLOW_UP_PENDING", "CLOSED", "ACCEPTED_RISK"]),
  CLOSED: new Set(["ACTION_IN_PROGRESS"]),
  ACCEPTED_RISK: new Set(["ACTION_IN_PROGRESS"]),
});

function assertPlainObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, `${label} must be an object`, "INVALID_ENGAGEMENT_INPUT");
  }
  return value;
}

function assertAllowedFields(input, allowed, label) {
  assertPlainObject(input);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw httpError(
      400,
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
      "UNSUPPORTED_ENGAGEMENT_FIELD"
    );
  }
}

function parseExpectedRevision(value, label = "expectedRevision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw httpError(400, `${label} must be a positive integer`, "INVALID_ENGAGEMENT_REVISION");
  }
  return revision;
}

function parseLimit(value, fallback, maximum, label) {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw httpError(400, `${label} must be between 1 and ${maximum}`, "INVALID_PAGINATION");
  }
  return limit;
}

function parseIdArray(value, label, maximum) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array`);
  if (value.length > maximum) throw httpError(400, `${label} exceeds ${maximum} items`);
  return [...new Set(value.map((id) => objectId(id, label)))];
}

function engagementTeam(ownerUserId, reviewerUserId, teamUserIds) {
  const combined = [...new Set([
    String(ownerUserId),
    String(reviewerUserId),
    ...teamUserIds.map(String),
  ])];
  if (combined.length > 50) {
    throw httpError(400, "Engagement team exceeds 50 active users");
  }
  return combined;
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!allowed.has(normalized)) throw httpError(400, `Unsupported ${label}`);
  return normalized;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value, kind) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!decoded || decoded.kind !== kind) throw new Error("kind");
    return decoded;
  } catch {
    throw httpError(400, `${kind} cursor is invalid`, "INVALID_ENGAGEMENT_CURSOR");
  }
}

function snapshotDate(value, label = "snapshotAt") {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 60_000) {
    throw httpError(400, `${label} is invalid`, "INVALID_ENGAGEMENT_CURSOR");
  }
  return date;
}

function combineFilters(...filters) {
  const active = filters.filter(Boolean);
  if (!active.length) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

function engagementMutation(input, action) {
  return {
    key: mutationKey(input?.mutationKey),
    requestHash: mutationRequestHash(action, input),
    action,
  };
}

function mutationReceipt(document, mutation) {
  const receipt = document.mutationReceipts?.find((item) => item.key === mutation.key);
  if (!receipt) return null;
  assertMutationRequestHash(receipt.requestHash, mutation.requestHash);
  return receipt;
}

function appendMutationReceipt(document, mutation, resultId = "") {
  if ((document.mutationReceipts?.length || 0) >= 1000) {
    throw httpError(409, "Mutation receipt capacity reached; archive this record", "MUTATION_RECEIPT_LIMIT");
  }
  document.mutationReceipts.push({
    key: mutation.key,
    action: mutation.action,
    requestHash: mutation.requestHash,
    resultId: String(resultId || ""),
    appliedRevision: document.revision + 1,
    appliedAt: new Date(),
  });
}

function engagementPublicationFromRequest(req) {
  return {
    version: req.featureFlagVersions?.assuranceEngagements,
    publicationFence: req.featureFlagPublicationFences?.assuranceEngagements ?? null,
    writeStarted: false,
  };
}

async function assertEngagementPublicationCurrent(publication) {
  if (!Number.isSafeInteger(publication?.version)) {
    throw httpError(
      500,
      "Engagement publication context is unavailable",
      "ENGAGEMENT_PUBLICATION_CONTEXT_REQUIRED"
    );
  }
  return AppConfig.assertFeatureFlagVersion(
    "assuranceEngagements",
    publication.version,
    publication.publicationFence ?? null
  );
}

async function beginEngagementPublicationWrite(publication) {
  if (publication?.writeStarted === true) return null;
  const state = await assertEngagementPublicationCurrent(publication);
  publication.writeStarted = true;
  return state;
}

async function requireFirmClient(clientId, firmId) {
  const client = await Client.findOne({
    _id: objectId(clientId, "clientId"),
    firmId,
    isActive: true,
  })
    .select("_id name gstin pan")
    .lean();
  if (!client) throw httpError(400, "Client is unavailable in the active firm");
  return client;
}

async function validateFirmUsers(ids, firmId) {
  const requested = [...new Set(ids.filter(Boolean).map((id) => objectId(id, "userId")))];
  if (!requested.length) return new Map();
  const users = await User.find({
    _id: { $in: requested },
    firmId,
    isActive: { $ne: false },
  })
    .select("_id name email role")
    .lean();
  if (users.length !== requested.length) {
    throw httpError(400, "Every assigned user must be active in the current firm");
  }
  return new Map(users.map((user) => [String(user._id), user]));
}

// R15 (.kiro/finalreleasefix.md): a firm's own OWNER/ADMIN carries exactly the authority the app
// already trusts them with elsewhere (removing a member, rotating the join code), so that
// membership role now satisfies this check too. The formal, super-admin-approved FIRM_ADMIN
// account role stays valid as well, for a firm that has one. Before this change a brand-new
// firm had no member who could ever pass this check -- there was no path, self-service or
// otherwise, to acquire the FIRM_ADMIN role from inside the product -- so no firm could ever
// create an engagement. Async because the OWNER/ADMIN check reads FirmMembership.
async function assertReviewerRole(usersById, reviewerUserId, firmId) {
  const reviewer = usersById.get(String(reviewerUserId));
  if (!reviewer) {
    throw httpError(
      400,
      "The assigned reviewer must be an active member of this firm",
      "ENGAGEMENT_REVIEWER_ROLE_REQUIRED"
    );
  }

  if (reviewer.role === "FIRM_ADMIN") {
    return;
  }

  const membership = await FirmMembership.findOne({
    userId: reviewer._id,
    firmId,
    status: "ACTIVE",
  })
    .select("role")
    .lean();

  if (membership && (membership.role === "OWNER" || membership.role === "ADMIN")) {
    return;
  }

  throw httpError(
    400,
    "The assigned reviewer must be this firm's owner, an administrator, or an active FIRM_ADMIN",
    "ENGAGEMENT_REVIEWER_ROLE_REQUIRED"
  );
}

function assertAssignedReviewer(engagement, user) {
  if (
    user?.role !== "FIRM_ADMIN" ||
    String(engagement.reviewerUserId) !== String(user.id)
  ) {
    throw httpError(
      403,
      "Only the assigned active FIRM_ADMIN reviewer may perform this review action",
      "ENGAGEMENT_REVIEWER_REQUIRED"
    );
  }
}

async function validateFirmLinks({
  firmId,
  clientId,
  taskIds = [],
  taxWorkSessionIds = [],
  caseIds = [],
}) {
  const [tasks, sessions, cases] = await Promise.all([
    taskIds.length
      ? Task.find({ _id: { $in: taskIds }, firmId, isActive: true })
          .select("_id clientId")
          .lean()
      : [],
    taxWorkSessionIds.length
      ? TaxWorkSession.find({ _id: { $in: taxWorkSessionIds }, firmId })
          .select("_id clientId")
          .lean()
      : [],
    caseIds.length
      ? CaseMatter.find({ _id: { $in: caseIds }, firmId })
          .select("_id clientId")
          .lean()
      : [],
  ]);
  if (tasks.length !== taskIds.length) throw httpError(400, "Every linked Task must belong to the active firm");
  if (sessions.length !== taxWorkSessionIds.length) {
    throw httpError(400, "Every linked Tax Work session must belong to the active firm");
  }
  if (cases.length !== caseIds.length) throw httpError(400, "Every linked Case must belong to the active firm");
  const expectedClient = String(clientId);
  if (tasks.some((record) => record.clientId && String(record.clientId) !== expectedClient)) {
    throw httpError(400, "Linked Tasks with a client must belong to the engagement client");
  }
  if (sessions.some((record) => String(record.clientId) !== expectedClient)) {
    throw httpError(400, "Linked Tax Work sessions must belong to the engagement client");
  }
  if (cases.some((record) => String(record.clientId) !== expectedClient)) {
    throw httpError(400, "Linked Cases must belong to the engagement client");
  }
}

async function ensureActivity({
  firmId,
  actorUserId,
  action,
  entityType,
  entityId,
  mutation,
  publication,
  beforeSummary = null,
  afterSummary = null,
  requestId = "",
  metadata = {},
}) {
  const eventKey = `${entityType}:${entityId}:${action}:${mutation.key}`;
  const identity = new mongoose.Types.ObjectId(hashText(eventKey).slice(0, 24));
  const lookup = {
    firmId,
    entityType,
    entityId: String(entityId),
    action,
    "metadata.eventKey": eventKey,
  };
  const existing = await ActivityEvent.findOne(lookup).select("_id").lean();
  if (existing) return existing;

  await assertEngagementPublicationCurrent(publication);
  try {
    return await recordActivity({
      eventId: identity,
      firmId,
      actorUserId,
      source: "USER",
      action,
      entityType,
      entityId,
      beforeSummary,
      afterSummary,
      requestId,
      metadata: { ...metadata, eventKey, mutationKey: mutation.key },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await ActivityEvent.findById(identity).lean();
    if (winner?.metadata?.eventKey !== eventKey) {
      throw httpError(409, "Activity event identity collision", "ENGAGEMENT_ACTIVITY_CONFLICT");
    }
    return winner;
  }
}

function initializeTemplateItems(items, status) {
  return items.map((entry) => ({
    templateKey: entry.key,
    title: entry.title,
    category: entry.category || "",
    required: entry.required !== false,
    status,
  }));
}

async function findFirmEngagement(engagementId, firmId, session = null) {
  let query = Engagement.findOne({
    _id: objectId(engagementId, "engagementId"),
    firmId,
  });
  if (session) query = query.session(session);
  const engagement = await query;
  if (!engagement) throw httpError(404, "Engagement not found", "ENGAGEMENT_NOT_FOUND");
  return engagement;
}

async function mutationWinner(model, filter, mutation, session = null) {
  let query = model.findOne(filter);
  if (session) query = query.session(session);
  const winner = await query;
  if (!winner || !mutationReceipt(winner, mutation)) return null;
  return winner;
}

async function saveWithConflict(
  document,
  publication,
  label,
  { mutation = null, session = null } = {}
) {
  await beginEngagementPublicationWrite(publication);
  try {
    await document.save(session ? { session } : undefined);
    return document;
  } catch (error) {
    if (error?.name === "VersionError") {
      if (mutation && !session) {
        const winner = await mutationWinner(
          document.constructor,
          { _id: document._id, firmId: document.firmId },
          mutation
        );
        if (winner) return winner;
      }
      throw httpError(
        409,
        `${label} changed in another request; reload and retry`,
        "ENGAGEMENT_REVISION_CONFLICT"
      );
    }
    throw error;
  }
}

function assertRevision(document, expectedRevision, label) {
  if (document.revision !== expectedRevision) {
    throw httpError(
      409,
      `${label} changed since it was loaded; reload and retry`,
      "ENGAGEMENT_REVISION_CONFLICT"
    );
  }
}

function clearFinalReview(engagement, status = "PENDING") {
  engagement.finalReview.status = status;
  engagement.finalReview.reviewedBy = null;
  engagement.finalReview.reviewedAt = null;
  engagement.finalReview.note = "";
  engagement.finalReview.reviewedRevision = null;
  engagement.finalReview.reviewedContentRevision = null;
  engagement.finalReview.contentFingerprint = null;
}

function assertTemplateAttestedForFinding(engagement) {
  if (engagement.templateReview?.status !== "ATTESTED") {
    throw httpError(
      409,
      "Finding work requires a current assigned-reviewer template attestation",
      "ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED"
    );
  }
}

async function withEngagementTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}

async function touchEngagementForFinding({ engagement, actorUserId, publication, session }) {
  await beginEngagementPublicationWrite(publication);
  const updated = await Engagement.findOneAndUpdate(
    {
      _id: engagement._id,
      firmId: engagement.firmId,
      __v: engagement.__v,
      status: { $nin: ["COMPLETE", "ARCHIVED"] },
      "templateReview.status": "ATTESTED",
    },
    {
      $inc: { contentRevision: 1, revision: 1, __v: 1 },
      $set: {
        updatedBy: actorUserId,
        updatedAt: new Date(),
        "finalReview.status": "PENDING",
        "finalReview.reviewedBy": null,
        "finalReview.reviewedAt": null,
        "finalReview.note": "",
        "finalReview.reviewedRevision": null,
        "finalReview.reviewedContentRevision": null,
        "finalReview.contentFingerprint": null,
      },
    },
    { new: true, runValidators: true, session }
  );
  if (!updated) {
    throw httpError(
      409,
      "Engagement changed, completed, or lost template attestation during finding work",
      "ENGAGEMENT_REVISION_CONFLICT"
    );
  }
  return updated;
}

function assertEngagementStatusTransition(from, to) {
  if (from === to) return;
  if (!STATUS_TRANSITIONS[from]?.has(to)) {
    throw httpError(409, `Engagement cannot move from ${from} to ${to}`, "INVALID_ENGAGEMENT_TRANSITION");
  }
}

function assertFindingStatusTransition(from, to) {
  if (from === to) return;
  if (!FINDING_TRANSITIONS[from]?.has(to)) {
    throw httpError(409, `Finding cannot move from ${from} to ${to}`, "INVALID_FINDING_TRANSITION");
  }
}

function embeddedItem(collection, update, label) {
  assertPlainObject(update, `${label} update`);
  const target = update.id
    ? collection.id(objectId(update.id, `${label} id`))
    : collection.find((item) => item.templateKey === String(update.templateKey || "").trim());
  if (!target) throw httpError(400, `${label} item was not found in this template snapshot`);
  return target;
}

function parseUpdates(value, label, maximum = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw httpError(400, `${label} must contain at most ${maximum} updates`);
  }
  return value;
}

function collectUpdateOwnerIds(input) {
  const ids = [];
  for (const key of ["checklistUpdates", "milestoneUpdates", "clientRequestUpdates", "deliverableUpdates"]) {
    for (const update of parseUpdates(input[key], key)) {
      if (update?.ownerUserId) ids.push(update.ownerUserId);
    }
  }
  return ids;
}

function applyChecklistUpdates(engagement, updates, actorUserId) {
  const allowed = new Set(["id", "templateKey", "status", "ownerUserId", "dueAt", "evidenceReference", "note"]);
  for (const update of updates) {
    assertAllowedFields(update, allowed, "Checklist update");
    const item = embeddedItem(engagement.checklist, update, "Checklist");
    if (update.status !== undefined) {
      item.status = normalizeEnum(
        update.status,
        new Set(["OPEN", "IN_PROGRESS", "BLOCKED", "COMPLETE", "NOT_APPLICABLE"]),
        "checklist status"
      );
      if (item.status === "COMPLETE") {
        item.completedAt = new Date();
        item.completedBy = actorUserId;
      } else {
        item.completedAt = null;
        item.completedBy = null;
      }
    }
    if (update.ownerUserId !== undefined) item.ownerUserId = update.ownerUserId || null;
    if (update.dueAt !== undefined) item.dueAt = parseDateValue(update.dueAt, "checklist dueAt");
    if (update.evidenceReference !== undefined) {
      item.evidenceReference = boundedText(update.evidenceReference, 2000, { label: "evidenceReference" });
    }
    if (update.note !== undefined) item.note = boundedText(update.note, 5000, { label: "checklist note" });
    if (item.status === "NOT_APPLICABLE" && !item.note) {
      throw httpError(400, "Not-applicable checklist items require a reason note");
    }
  }
}

function applyMilestoneUpdates(engagement, updates, actorUserId) {
  const allowed = new Set(["id", "templateKey", "status", "ownerUserId", "dueAt", "note"]);
  for (const update of updates) {
    assertAllowedFields(update, allowed, "Milestone update");
    const item = embeddedItem(engagement.milestones, update, "Milestone");
    if (update.status !== undefined) {
      item.status = normalizeEnum(
        update.status,
        new Set(["PENDING", "IN_PROGRESS", "BLOCKED", "COMPLETE", "NOT_APPLICABLE"]),
        "milestone status"
      );
      if (item.status === "COMPLETE") {
        item.completedAt = new Date();
        item.completedBy = actorUserId;
      } else {
        item.completedAt = null;
        item.completedBy = null;
      }
    }
    if (update.ownerUserId !== undefined) item.ownerUserId = update.ownerUserId || null;
    if (update.dueAt !== undefined) item.dueAt = parseDateValue(update.dueAt, "milestone dueAt");
    if (update.note !== undefined) item.note = boundedText(update.note, 5000, { label: "milestone note" });
    if (item.status === "NOT_APPLICABLE" && !item.note) {
      throw httpError(400, "Not-applicable milestones require a reason note");
    }
  }
}

function applyClientRequestUpdates(engagement, updates) {
  const allowed = new Set(["id", "templateKey", "status", "ownerUserId", "dueAt", "responseReference", "note"]);
  for (const update of updates) {
    assertAllowedFields(update, allowed, "Client request update");
    const item = embeddedItem(engagement.clientRequests, update, "Client request");
    if (update.status !== undefined) {
      item.status = normalizeEnum(
        update.status,
        new Set(["NOT_REQUESTED", "REQUESTED", "PARTIAL", "RECEIVED", "WAIVED"]),
        "client request status"
      );
      if (item.status === "REQUESTED" && !item.requestedAt) item.requestedAt = new Date();
      item.receivedAt = item.status === "RECEIVED" ? new Date() : null;
    }
    if (update.ownerUserId !== undefined) item.ownerUserId = update.ownerUserId || null;
    if (update.dueAt !== undefined) item.dueAt = parseDateValue(update.dueAt, "client request dueAt");
    if (update.responseReference !== undefined) {
      item.responseReference = boundedText(update.responseReference, 2000, { label: "responseReference" });
    }
    if (update.note !== undefined) item.note = boundedText(update.note, 5000, { label: "client request note" });
    if (item.status === "WAIVED" && !item.note) {
      throw httpError(400, "Waived client requests require a reason note");
    }
    if (item.status === "RECEIVED" && !item.responseReference) {
      throw httpError(400, "Received client requests require a source reference");
    }
  }
}

function applyDeliverableUpdates(engagement, updates, user) {
  const allowed = new Set(["id", "templateKey", "status", "ownerUserId", "dueAt", "reference", "note"]);
  for (const update of updates) {
    assertAllowedFields(update, allowed, "Deliverable update");
    const item = embeddedItem(engagement.deliverables, update, "Deliverable");
    const previousStatus = item.status;
    const changesProtectedDeliverable =
      ["APPROVED", "ISSUED"].includes(previousStatus) &&
      Object.keys(update).some((key) => !["id", "templateKey"].includes(key));
    if (changesProtectedDeliverable) assertAssignedReviewer(engagement, user);
    if (update.status !== undefined) {
      const status = normalizeEnum(
        update.status,
        new Set(["NOT_STARTED", "DRAFT", "IN_REVIEW", "APPROVED", "ISSUED", "NOT_APPLICABLE"]),
        "deliverable status"
      );
      if (
        ["APPROVED", "ISSUED"].includes(status) ||
        ["APPROVED", "ISSUED"].includes(previousStatus)
      ) {
        assertAssignedReviewer(engagement, user);
      }
      item.status = status;
    }
    if (update.ownerUserId !== undefined) item.ownerUserId = update.ownerUserId || null;
    if (update.dueAt !== undefined) item.dueAt = parseDateValue(update.dueAt, "deliverable dueAt");
    if (update.reference !== undefined) item.reference = boundedText(update.reference, 2000, { label: "deliverable reference" });
    if (update.note !== undefined) item.note = boundedText(update.note, 5000, { label: "deliverable note" });
    if (["APPROVED", "ISSUED"].includes(item.status) && !item.reference) {
      throw httpError(400, "Approved or issued deliverables require a reference");
    }
    if (item.status === "NOT_APPLICABLE" && !item.note) {
      throw httpError(400, "Not-applicable deliverables require a reason note");
    }
    if (["APPROVED", "ISSUED"].includes(item.status)) {
      item.approvedBy = user.id;
      item.approvedAt ||= new Date();
      item.issuedAt = item.status === "ISSUED" ? new Date() : null;
    } else {
      item.approvedBy = null;
      item.approvedAt = null;
      item.issuedAt = null;
    }
  }
}

function applyReviewPointChanges(engagement, input, user) {
  const adds = parseUpdates(input.reviewPointAdds, "reviewPointAdds", 50);
  const updates = parseUpdates(input.reviewPointUpdates, "reviewPointUpdates", 100);
  if (!adds.length && !updates.length) return;
  assertAssignedReviewer(engagement, user);
  for (const addition of adds) {
    assertAllowedFields(addition, new Set(["title", "detail"]), "Review point");
    engagement.reviewPoints.push({
      title: boundedText(addition.title, 500, { required: true, label: "review point title" }),
      detail: boundedText(addition.detail, 5000, { label: "review point detail" }),
      createdBy: user.id,
    });
  }
  for (const update of updates) {
    assertAllowedFields(update, new Set(["id", "status", "resolutionNote"]), "Review point update");
    const point = engagement.reviewPoints.id(objectId(update.id, "review point id"));
    if (!point) throw httpError(400, "Review point was not found");
    const status = normalizeEnum(update.status, new Set(["OPEN", "RESOLVED", "WAIVED"]), "review point status");
    const resolutionNote = boundedText(update.resolutionNote, 5000, { label: "resolutionNote" });
    if (["RESOLVED", "WAIVED"].includes(status) && !resolutionNote) {
      throw httpError(400, "Resolved or waived review points require a resolution note");
    }
    point.status = status;
    point.resolutionNote = resolutionNote;
    point.resolvedBy = status === "OPEN" ? null : user.id;
    point.resolvedAt = status === "OPEN" ? null : new Date();
  }
}

function referenceId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value._id != null) return String(value._id);
  return String(value);
}

function canonicalEmbeddedReferences(collection, fields) {
  return (collection || []).map((entry) => {
    const normalized = { ...entry };
    for (const field of fields) normalized[field] = referenceId(entry[field]);
    return normalized;
  });
}

function engagementContentPayload(engagement) {
  const value = plain(typeof engagement.toObject === "function" ? engagement.toObject() : engagement);
  return {
    clientId: referenceId(value.clientId),
    engagementType: value.engagementType,
    title: value.title,
    period: value.period,
    scope: value.scope,
    ownerUserId: referenceId(value.ownerUserId),
    teamUserIds: (value.teamUserIds || []).map(referenceId),
    reviewerUserId: referenceId(value.reviewerUserId),
    stage: value.stage,
    startDate: value.startDate,
    targetDate: value.targetDate,
    linkedTaskIds: (value.linkedTaskIds || []).map(referenceId),
    linkedTaxWorkSessionIds: (value.linkedTaxWorkSessionIds || []).map(referenceId),
    linkedCaseIds: (value.linkedCaseIds || []).map(referenceId),
    templateHash: value.templateHash,
    templateReview: {
      ...value.templateReview,
      reviewedBy: referenceId(value.templateReview?.reviewedBy),
    },
    checklist: canonicalEmbeddedReferences(value.checklist, ["ownerUserId", "completedBy"]),
    milestones: canonicalEmbeddedReferences(value.milestones, ["ownerUserId", "completedBy"]),
    clientRequests: canonicalEmbeddedReferences(value.clientRequests, ["ownerUserId"]),
    deliverables: canonicalEmbeddedReferences(value.deliverables, ["ownerUserId", "approvedBy"]),
    reviewPoints: canonicalEmbeddedReferences(value.reviewPoints, ["createdBy", "resolvedBy"]),
    closureSummary: value.closureSummary,
    outcome: value.outcome,
  };
}

function aiFindingContentSnapshot(finding) {
  return {
    title: String(finding.title || ""),
    description: String(finding.description || ""),
    category: String(finding.category || ""),
    risk: String(finding.risk || ""),
    evidenceReferences: (finding.evidenceReferences || []).map((value) => String(value)),
  };
}

function aiFindingContentHash(snapshot) {
  return hashText(stableJson(snapshot));
}

function findingContentPayload(finding) {
  const value = plain(finding);
  return {
    id: value._id,
    title: value.title,
    description: value.description,
    category: value.category,
    risk: value.risk,
    status: value.status,
    evidenceReferences: value.evidenceReferences,
    aiProvenance: value.aiProvenance || null,
    managementResponse: value.managementResponse,
    action: value.action,
    followUp: value.followUp,
    review: value.review,
    closedAt: value.closedAt,
    closedBy: value.closedBy,
  };
}

async function engagementContentFingerprint(engagement, session = null) {
  let query = EngagementFinding.find({
    firmId: engagement.firmId,
    engagementId: engagement._id,
  })
    .select("-mutationReceipts -creationRequestHash")
    .sort({ _id: 1 })
    .limit(MAX_FINGERPRINT_FINDINGS + 1)
    .lean();
  if (session) query = query.session(session);
  const findings = await query;
  if (findings.length > MAX_FINGERPRINT_FINDINGS) {
    throw httpError(
      409,
      `Final review fingerprint supports at most ${MAX_FINGERPRINT_FINDINGS} findings`,
      "ENGAGEMENT_FINGERPRINT_LIMIT"
    );
  }
  return hashText(
    stableJson({
      engagement: engagementContentPayload(engagement),
      findings: findings.map(findingContentPayload),
    })
  );
}

async function closureReadiness(
  engagement,
  { includeFinalReview = true, session = null } = {}
) {
  let unresolvedQuery = EngagementFinding.countDocuments({
    firmId: engagement.firmId,
    engagementId: engagement._id,
    status: { $nin: ["CLOSED", "ACCEPTED_RISK"] },
  });
  if (session) unresolvedQuery = unresolvedQuery.session(session);
  const unresolvedFindingCount = await unresolvedQuery;
  const checks = {
    templateReviewAttested: engagement.templateReview?.status === "ATTESTED",
    requiredChecklistResolved: engagement.checklist
      .filter((item) => item.required)
      .every((item) => ["COMPLETE", "NOT_APPLICABLE"].includes(item.status)),
    requiredClientRequestsResolved: engagement.clientRequests
      .filter((item) => item.required)
      .every((item) => ["RECEIVED", "WAIVED"].includes(item.status)),
    requiredMilestonesComplete: engagement.milestones
      .filter((item) => item.required)
      .every((item) => ["COMPLETE", "NOT_APPLICABLE"].includes(item.status)),
    requiredDeliverablesApproved: engagement.deliverables
      .filter((item) => item.required)
      .every((item) => ["APPROVED", "ISSUED", "NOT_APPLICABLE"].includes(item.status)),
    reviewPointsResolved: engagement.reviewPoints.every((item) => ["RESOLVED", "WAIVED"].includes(item.status)),
    findingsReviewedAndClosed: unresolvedFindingCount === 0,
    closureSummaryRecorded: String(engagement.closureSummary || "").trim().length >= 20,
  };
  let finalReviewCurrent = false;
  if (includeFinalReview && engagement.finalReview?.status === "APPROVED") {
    finalReviewCurrent =
      engagement.finalReview.reviewedContentRevision === engagement.contentRevision &&
      engagement.finalReview.contentFingerprint ===
        (await engagementContentFingerprint(engagement, session));
  }
  if (includeFinalReview) checks.currentFinalReviewApproved = finalReviewCurrent;
  const incomplete = Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
  return { ready: incomplete.length === 0, checks, incomplete, unresolvedFindingCount };
}

function closureError(readiness) {
  return httpError(
    409,
    `Engagement closure requirements are incomplete: ${readiness.incomplete.join(", ")}`,
    "ENGAGEMENT_CLOSURE_INCOMPLETE"
  );
}

async function createEngagement({
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, CREATE_FIELDS, "Engagement creation");
  const mutation = engagementMutation(input, "engagement-create");
  let engagement = await Engagement.findOne({ firmId, creationMutationKey: mutation.key });
  if (engagement) {
    assertMutationRequestHash(engagement.creationRequestHash, mutation.requestHash);
  } else {
    const client = await requireFirmClient(input.clientId, firmId);
    const engagementType = normalizeEnum(input.engagementType, ENGAGEMENT_TYPE_SET, "engagementType");
    const template = getEngagementTemplate(engagementType);
    if (!template) throw httpError(400, "Engagement template is unavailable");
    const ownerUserId = input.ownerUserId || actorUserId;
    const reviewerUserId = objectId(input.reviewerUserId, "reviewerUserId");
    const teamUserIds = parseIdArray(input.teamUserIds, "teamUserIds", 50);
    const users = await validateFirmUsers(
      [ownerUserId, reviewerUserId, ...teamUserIds],
      firmId
    );
    await assertReviewerRole(users, reviewerUserId, firmId);
    const linkedTaskIds = parseIdArray(input.linkedTaskIds, "linkedTaskIds", 200);
    const linkedTaxWorkSessionIds = parseIdArray(
      input.linkedTaxWorkSessionIds,
      "linkedTaxWorkSessionIds",
      100
    );
    const linkedCaseIds = parseIdArray(input.linkedCaseIds, "linkedCaseIds", 100);
    await validateFirmLinks({
      firmId,
      clientId: client._id,
      taskIds: linkedTaskIds,
      taxWorkSessionIds: linkedTaxWorkSessionIds,
      caseIds: linkedCaseIds,
    });
    const startDate = parseDateValue(input.startDate, "startDate") || new Date();
    const targetDate = parseDateValue(input.targetDate, "targetDate", { required: true });
    if (targetDate < startDate) throw httpError(400, "targetDate cannot precede startDate");
    const templateHash = hashText(stableJson(template));
    await beginEngagementPublicationWrite(publication);
    try {
      engagement = await Engagement.create({
        firmId,
        clientId: client._id,
        engagementType,
        title: boundedText(input.title || template.title, 500, { required: true, label: "title" }),
        period: boundedText(input.period, 120, { label: "period" }),
        scope: boundedText(input.scope, 20000, { required: true, label: "scope" }),
        ownerUserId,
        reviewerUserId,
        teamUserIds: engagementTeam(ownerUserId, reviewerUserId, teamUserIds),
        status: "DRAFT",
        stage: template.stages[0]?.key || "INTAKE",
        startDate,
        targetDate,
        linkedTaskIds,
        linkedTaxWorkSessionIds,
        linkedCaseIds,
        templateSnapshot: template,
        templateHash,
        checklist: initializeTemplateItems(template.checklist, "OPEN"),
        milestones: initializeTemplateItems(template.milestones, "PENDING"),
        clientRequests: initializeTemplateItems(template.clientRequests, "NOT_REQUESTED"),
        deliverables: initializeTemplateItems(template.deliverables, "NOT_STARTED"),
        creationMutationKey: mutation.key,
        creationRequestHash: mutation.requestHash,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      engagement = await Engagement.findOne({ firmId, creationMutationKey: mutation.key });
      if (!engagement) throw error;
      assertMutationRequestHash(engagement.creationRequestHash, mutation.requestHash);
    }
  }
  await ensureActivity({
    firmId,
    actorUserId,
    action: "ENGAGEMENT_CREATED",
    entityType: "Engagement",
    entityId: engagement._id,
    mutation,
    publication,
    afterSummary: {
      clientId: engagement.clientId,
      engagementType: engagement.engagementType,
      status: engagement.status,
      templateHash: engagement.templateHash,
    },
    requestId,
    metadata: { professionalConclusionGenerated: false },
  });
  return engagement;
}

async function matchingEngagementClientIds(firmId, search) {
  if (!search) return [];
  const expression = new RegExp(escapeRegex(search), "i");
  const clients = await Client.find({ firmId, isActive: true, name: expression })
    .select("_id")
    .sort({ _id: 1 })
    .limit(100)
    .lean();
  return clients.map((client) => String(client._id)).sort();
}

async function engagementSnapshotVersion({ firmId, snapshotAt, clientIds }) {
  const [state] = await Engagement.aggregate([
    {
      $match: {
        firmId: new mongoose.Types.ObjectId(String(firmId)),
        createdAt: { $lte: snapshotAt },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        revisionTotal: { $sum: { $ifNull: ["$revision", 1] } },
      },
    },
  ]);
  return hashText(
    stableJson({
      count: state?.count || 0,
      revisionTotal: state?.revisionTotal || 0,
      matchingClientIds: clientIds,
    })
  );
}

async function listEngagements({ firmId, query }) {
  const limit = parseLimit(query?.limit, 25, MAX_LIST_LIMIT, "limit");
  const cursor = decodeCursor(query?.cursor, "engagement-list-v2");
  const snapshotAt = snapshotDate(query?.snapshotAt || cursor?.snapshotAt);
  if (cursor?.snapshotAt && new Date(cursor.snapshotAt).toISOString() !== snapshotAt.toISOString()) {
    throw httpError(400, "Engagement cursor does not match snapshotAt", "INVALID_ENGAGEMENT_CURSOR");
  }
  const status = String(query?.status || "").trim().toUpperCase();
  const engagementType = String(query?.engagementType || "").trim().toUpperCase();
  const clientId = String(query?.clientId || "").trim();
  const reviewerUserId = String(query?.reviewerUserId || "").trim();
  if (status && !ENGAGEMENT_STATUS_SET.has(status)) throw httpError(400, "Unsupported status filter");
  if (engagementType && !ENGAGEMENT_TYPE_SET.has(engagementType)) {
    throw httpError(400, "Unsupported engagementType filter");
  }
  const search = boundedText(query?.search, 120, { label: "search" });
  const clientIds = await matchingEngagementClientIds(firmId, search);
  const filter = { firmId };
  if (status) filter.status = status;
  if (engagementType) filter.engagementType = engagementType;
  if (clientId) filter.clientId = objectId(clientId, "clientId");
  if (reviewerUserId) filter.reviewerUserId = objectId(reviewerUserId, "reviewerUserId");
  if (search) {
    const expression = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { title: expression },
      { period: expression },
      { scope: expression },
      { clientId: { $in: clientIds } },
    ];
  }
  const filterHash = hashText(
    stableJson({
      status,
      engagementType,
      clientId: clientId.toLowerCase(),
      reviewerUserId: reviewerUserId.toLowerCase(),
      search: search.toLowerCase(),
    })
  );
  if (cursor?.filterHash !== undefined && cursor.filterHash !== filterHash) {
    throw httpError(400, "Engagement cursor does not match active filters", "INVALID_ENGAGEMENT_CURSOR");
  }
  const snapshotVersion = await engagementSnapshotVersion({ firmId, snapshotAt, clientIds });
  if (cursor && cursor.snapshotVersion !== snapshotVersion) {
    throw httpError(
      409,
      "Engagement snapshot changed; restart pagination from the first page",
      "ENGAGEMENT_SNAPSHOT_CHANGED"
    );
  }
  let cursorFilter = null;
  if (cursor) {
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw httpError(400, "Engagement cursor is invalid");
    const id = objectId(cursor.id, "engagement cursor id");
    cursorFilter = {
      $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: id } },
      ],
    };
  }
  const snapshotFilter = { createdAt: { $lte: snapshotAt } };
  const stableFilter = combineFilters(filter, snapshotFilter, cursorFilter);
  const totalFilter = combineFilters(filter, snapshotFilter);
  const [documents, total] = await Promise.all([
    Engagement.find(stableFilter)
      .select("-templateSnapshot -mutationReceipts -creationRequestHash")
      .populate("clientId", "name pan gstin")
      .populate("ownerUserId reviewerUserId teamUserIds", "name email role")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    Engagement.countDocuments(totalFilter),
  ]);
  const currentClientIds = await matchingEngagementClientIds(firmId, search);
  const currentVersion = await engagementSnapshotVersion({
    firmId,
    snapshotAt,
    clientIds: currentClientIds,
  });
  if (currentVersion !== snapshotVersion) {
    throw httpError(
      409,
      "Engagement snapshot changed while reading; restart pagination",
      "ENGAGEMENT_SNAPSHOT_CHANGED"
    );
  }
  const hasMore = documents.length > limit;
  const engagements = hasMore ? documents.slice(0, limit) : documents;
  const last = engagements.at(-1);
  return {
    engagements,
    templates: listEngagementTemplates(),
    pagination: {
      limit,
      total,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              kind: "engagement-list-v2",
              filterHash,
              snapshotVersion,
              snapshotAt: snapshotAt.toISOString(),
              createdAt: new Date(last.createdAt).toISOString(),
              id: String(last._id),
            })
          : null,
      snapshotAt: snapshotAt.toISOString(),
      snapshotVersion,
      sort: "createdAt_desc_id_desc",
      membershipConsistency: "version_guarded_snapshot_rejects_mutation",
      filterHash,
    },
  };
}

function assertMatchingCursorSnapshot(cursor, snapshotAt, label) {
  if (
    cursor?.snapshotAt &&
    new Date(cursor.snapshotAt).toISOString() !== snapshotAt.toISOString()
  ) {
    throw httpError(400, `${label} cursor does not match snapshotAt`, "INVALID_ENGAGEMENT_CURSOR");
  }
}

function cursorDateFilter(cursor, dateField, idLabel) {
  if (!cursor) return null;
  const occurredAt = new Date(cursor.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw httpError(400, `${idLabel} cursor date is invalid`);
  const id = objectId(cursor.id, `${idLabel} cursor id`);
  return {
    $or: [
      { [dateField]: { $lt: occurredAt } },
      { [dateField]: occurredAt, _id: { $lt: id } },
    ],
  };
}

async function getEngagementDetail({ engagementId, firmId, query }) {
  const engagement = await Engagement.findOne({
    _id: objectId(engagementId, "engagementId"),
    firmId,
  })
    .select("-mutationReceipts -creationRequestHash")
    .populate("clientId", "name pan gstin email phone")
    .populate("ownerUserId reviewerUserId teamUserIds", "name email role")
    .populate("linkedTaskIds", "title status dueDateISO assignedTo clientId")
    .populate("linkedTaxWorkSessionIds", "taxType period status dueDate clientId")
    .populate("linkedCaseIds", "title caseType status clientId confirmedFacts.responseDueDate")
    .lean();
  if (!engagement) throw httpError(404, "Engagement not found", "ENGAGEMENT_NOT_FOUND");

  const findingLimit = parseLimit(query?.findingLimit, 25, MAX_DETAIL_LIMIT, "findingLimit");
  const findingCursor = decodeCursor(query?.findingCursor, "engagement-findings-v1");
  const findingSnapshotAt = snapshotDate(query?.findingSnapshotAt || findingCursor?.snapshotAt, "findingSnapshotAt");
  assertMatchingCursorSnapshot(findingCursor, findingSnapshotAt, "Finding");
  const findingFilter = combineFilters(
    { firmId, engagementId: engagement._id },
    { createdAt: { $lte: findingSnapshotAt } },
    cursorDateFilter(findingCursor, "createdAt", "finding")
  );
  const findingQuery = EngagementFinding.find(findingFilter)
    .select("-mutationReceipts -creationRequestHash")
    .populate("action.ownerUserId followUp.verifiedBy review.reviewedBy closedBy", "name email role")
    .sort({ createdAt: -1, _id: -1 })
    .limit(findingLimit + 1)
    .lean();

  const activityLimit = parseLimit(query?.activityLimit, 25, MAX_DETAIL_LIMIT, "activityLimit");
  const activityCursor = decodeCursor(query?.activityCursor, "engagement-activity-v1");
  const activitySnapshotAt = snapshotDate(query?.activitySnapshotAt || activityCursor?.snapshotAt, "activitySnapshotAt");
  assertMatchingCursorSnapshot(activityCursor, activitySnapshotAt, "Activity");
  const activityScope = {
    firmId,
    $or: [
      { entityType: "Engagement", entityId: String(engagement._id) },
      { entityType: "EngagementFinding", "metadata.engagementId": String(engagement._id) },
    ],
  };
  const activityFilter = combineFilters(
    activityScope,
    { occurredAt: { $lte: activitySnapshotAt } },
    cursorDateFilter(activityCursor, "occurredAt", "activity")
  );
  const activityQuery = ActivityEvent.find(activityFilter)
    .populate("actorUserId", "name email role")
    .sort({ occurredAt: -1, _id: -1 })
    .limit(activityLimit + 1)
    .lean();

  const [findingDocuments, activityDocuments, readiness] = await Promise.all([
    findingQuery,
    activityQuery,
    closureReadiness(engagement),
  ]);
  const findingHasMore = findingDocuments.length > findingLimit;
  const findings = findingHasMore ? findingDocuments.slice(0, findingLimit) : findingDocuments;
  const findingLast = findings.at(-1);
  const activityHasMore = activityDocuments.length > activityLimit;
  const activity = activityHasMore ? activityDocuments.slice(0, activityLimit) : activityDocuments;
  const activityLast = activity.at(-1);
  return {
    engagement,
    findings,
    activity,
    closureReadiness: readiness,
    professionalConclusionGenerated: false,
    automaticPortalSubmissionPerformed: false,
    templateQualificationVerifiedByPlatform: false,
    findingPagination: {
      limit: findingLimit,
      hasMore: findingHasMore,
      nextCursor:
        findingHasMore && findingLast
          ? encodeCursor({
              kind: "engagement-findings-v1",
              snapshotAt: findingSnapshotAt.toISOString(),
              occurredAt: new Date(findingLast.createdAt).toISOString(),
              id: String(findingLast._id),
            })
          : null,
      snapshotAt: findingSnapshotAt.toISOString(),
    },
    activityPagination: {
      limit: activityLimit,
      hasMore: activityHasMore,
      nextCursor:
        activityHasMore && activityLast
          ? encodeCursor({
              kind: "engagement-activity-v1",
              snapshotAt: activitySnapshotAt.toISOString(),
              occurredAt: new Date(activityLast.occurredAt).toISOString(),
              id: String(activityLast._id),
            })
          : null,
      snapshotAt: activitySnapshotAt.toISOString(),
    },
  };
}

async function updateEngagement({
  engagementId,
  firmId,
  actorUserId,
  user,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, PATCH_FIELDS, "Engagement update");
  const mutation = engagementMutation(input, "engagement-update");
  let engagement = await findFirmEngagement(engagementId, firmId);
  const replay = mutationReceipt(engagement, mutation);
  if (replay) {
    await ensureActivity({
      firmId,
      actorUserId,
      action: "ENGAGEMENT_UPDATED",
      entityType: "Engagement",
      entityId: engagement._id,
      mutation,
      publication,
      afterSummary: { status: engagement.status, revision: engagement.revision },
      requestId,
    });
    return engagement;
  }
  assertRevision(engagement, parseExpectedRevision(input.expectedRevision), "Engagement");
  const requestedStatus = input.status === undefined
    ? engagement.status
    : normalizeEnum(input.status, ENGAGEMENT_STATUS_SET, "engagement status");
  assertEngagementStatusTransition(engagement.status, requestedStatus);
  if (engagement.status === "ARCHIVED") throw httpError(409, "Archived engagements are read-only");
  if (engagement.status === "COMPLETE") {
    const archiveFields = new Set(["mutationKey", "expectedRevision", "status"]);
    const extraFields = Object.keys(input).filter((key) => !archiveFields.has(key));
    if (requestedStatus !== "ARCHIVED" || extraFields.length) {
      throw httpError(
        409,
        "Complete engagements accept only an archive status transition",
        "ENGAGEMENT_COMPLETE_READ_ONLY"
      );
    }
  }

  const contentChanged = Object.keys(input).some(
    (key) => !["mutationKey", "expectedRevision", "status"].includes(key)
  );

  const assignmentChanged =
    input.ownerUserId !== undefined ||
    input.reviewerUserId !== undefined ||
    input.teamUserIds !== undefined;
  const reviewerChanged =
    input.reviewerUserId !== undefined &&
    String(input.reviewerUserId) !== String(engagement.reviewerUserId);
  const protectedReviewerAction =
    input.deliverableUpdates !== undefined ||
    input.reviewPointAdds !== undefined ||
    input.reviewPointUpdates !== undefined ||
    requestedStatus === "COMPLETE";
  if (reviewerChanged) {
    assertAssignedReviewer(engagement, user);
    if (protectedReviewerAction) {
      throw httpError(
        409,
        "Reviewer reassignment cannot be combined with reviewer-protected actions",
        "ENGAGEMENT_REVIEWER_REASSIGNMENT_CONFLICT"
      );
    }
  }
  const nextOwnerUserId = input.ownerUserId === undefined
    ? String(engagement.ownerUserId)
    : objectId(input.ownerUserId, "ownerUserId");
  const nextReviewerUserId = input.reviewerUserId === undefined
    ? String(engagement.reviewerUserId)
    : objectId(input.reviewerUserId, "reviewerUserId");
  const nextTeamUserIds = input.teamUserIds === undefined
    ? engagement.teamUserIds.map(String)
    : parseIdArray(input.teamUserIds, "teamUserIds", 50);
  const embeddedOwnerIds = collectUpdateOwnerIds(input);
  const users = await validateFirmUsers(
    assignmentChanged
      ? [nextOwnerUserId, nextReviewerUserId, ...nextTeamUserIds, ...embeddedOwnerIds]
      : embeddedOwnerIds,
    firmId
  );
  if (assignmentChanged) await assertReviewerRole(users, nextReviewerUserId, firmId);

  const beforeSummary = {
    status: engagement.status,
    stage: engagement.stage,
    revision: engagement.revision,
  };
  if (input.title !== undefined) {
    engagement.title = boundedText(input.title, 500, { required: true, label: "title" });
  }
  if (input.period !== undefined) engagement.period = boundedText(input.period, 120, { label: "period" });
  if (input.scope !== undefined) {
    engagement.scope = boundedText(input.scope, 20000, { required: true, label: "scope" });
  }
  if (assignmentChanged) {
    engagement.ownerUserId = nextOwnerUserId;
    engagement.teamUserIds = engagementTeam(
      nextOwnerUserId,
      nextReviewerUserId,
      nextTeamUserIds
    );
  }
  if (input.startDate !== undefined) engagement.startDate = parseDateValue(input.startDate, "startDate");
  if (input.targetDate !== undefined) {
    engagement.targetDate = parseDateValue(input.targetDate, "targetDate", { required: true });
  }
  if (engagement.startDate && engagement.targetDate < engagement.startDate) {
    throw httpError(400, "targetDate cannot precede startDate");
  }
  if (input.stage !== undefined) {
    const stage = boundedText(input.stage, 120, { required: true, label: "stage" }).toUpperCase();
    const stages = new Set((engagement.templateSnapshot?.stages || []).map((item) => item.key));
    if (!stages.has(stage)) throw httpError(400, "Stage is not defined by this template snapshot");
    engagement.stage = stage;
  }

  const linkedTaskIds = input.linkedTaskIds === undefined
    ? engagement.linkedTaskIds.map(String)
    : parseIdArray(input.linkedTaskIds, "linkedTaskIds", 200);
  const linkedTaxWorkSessionIds = input.linkedTaxWorkSessionIds === undefined
    ? engagement.linkedTaxWorkSessionIds.map(String)
    : parseIdArray(input.linkedTaxWorkSessionIds, "linkedTaxWorkSessionIds", 100);
  const linkedCaseIds = input.linkedCaseIds === undefined
    ? engagement.linkedCaseIds.map(String)
    : parseIdArray(input.linkedCaseIds, "linkedCaseIds", 100);
  if (
    input.linkedTaskIds !== undefined ||
    input.linkedTaxWorkSessionIds !== undefined ||
    input.linkedCaseIds !== undefined
  ) {
    await validateFirmLinks({
      firmId,
      clientId: engagement.clientId,
      taskIds: linkedTaskIds,
      taxWorkSessionIds: linkedTaxWorkSessionIds,
      caseIds: linkedCaseIds,
    });
    engagement.linkedTaskIds = linkedTaskIds;
    engagement.linkedTaxWorkSessionIds = linkedTaxWorkSessionIds;
    engagement.linkedCaseIds = linkedCaseIds;
  }
  if (input.closureSummary !== undefined) {
    engagement.closureSummary = boundedText(input.closureSummary, 10000, { label: "closureSummary" });
  }
  if (input.outcome !== undefined) engagement.outcome = boundedText(input.outcome, 10000, { label: "outcome" });

  applyChecklistUpdates(
    engagement,
    parseUpdates(input.checklistUpdates, "checklistUpdates"),
    actorUserId
  );
  applyMilestoneUpdates(
    engagement,
    parseUpdates(input.milestoneUpdates, "milestoneUpdates"),
    actorUserId
  );
  applyClientRequestUpdates(
    engagement,
    parseUpdates(input.clientRequestUpdates, "clientRequestUpdates")
  );
  applyDeliverableUpdates(
    engagement,
    parseUpdates(input.deliverableUpdates, "deliverableUpdates"),
    user
  );
  applyReviewPointChanges(engagement, input, user);

  if (assignmentChanged) engagement.reviewerUserId = nextReviewerUserId;
  const reopenedReviewCycle =
    engagement.status === "FINALIZATION" &&
    ["INTERNAL_REVIEW", "CLIENT_REVIEW"].includes(requestedStatus);
  if (contentChanged || reopenedReviewCycle) clearFinalReview(engagement);
  if (contentChanged) engagement.contentRevision += 1;

  if (
    requestedStatus !== "DRAFT" &&
    requestedStatus !== "ARCHIVED" &&
    engagement.templateReview?.status !== "ATTESTED"
  ) {
    throw httpError(
      409,
      "Record the assigned firm-admin template review attestation before planning starts",
      "ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED"
    );
  }
  if (requestedStatus === "COMPLETE") {
    const readiness = await closureReadiness(engagement);
    if (!readiness.ready) throw closureError(readiness);
    engagement.completedAt = new Date();
    engagement.completedBy = actorUserId;
  }
  if (requestedStatus !== "COMPLETE" && engagement.status !== "COMPLETE") {
    engagement.completedAt = null;
    engagement.completedBy = null;
  }
  engagement.status = requestedStatus;
  engagement.archivedAt = requestedStatus === "ARCHIVED" ? new Date() : null;
  engagement.updatedBy = actorUserId;
  appendMutationReceipt(engagement, mutation);
  engagement.revision += 1;
  engagement = await saveWithConflict(engagement, publication, "Engagement", { mutation });
  await ensureActivity({
    firmId,
    actorUserId,
    action: "ENGAGEMENT_UPDATED",
    entityType: "Engagement",
    entityId: engagement._id,
    mutation,
    publication,
    beforeSummary,
    afterSummary: {
      status: engagement.status,
      stage: engagement.stage,
      revision: engagement.revision,
      completedAt: engagement.completedAt,
    },
    requestId,
    metadata: { professionalConclusionGenerated: false },
  });
  return engagement;
}

function validateFindingCategory(engagement, value) {
  const category = boundedText(value, 120, { required: true, label: "category" }).toUpperCase();
  const categories = new Set([...(engagement.templateSnapshot?.findingCategories || []), "OTHER"]);
  if (!categories.has(category)) throw httpError(400, "Finding category is not defined by this template snapshot");
  return category;
}

async function createEngagementFinding({
  engagementId,
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, FINDING_CREATE_FIELDS, "Finding creation");
  const mutation = engagementMutation(input, "engagement-finding-create");
  const evidenceReferences = boundedStringArray(input.evidenceReferences, "evidenceReferences", {
    maxItems: 100,
    maxLength: 2000,
  });
  if (!evidenceReferences.length) {
    throw httpError(400, "At least one evidence or source reference is required for a finding");
  }

  let finding;
  try {
    finding = await withEngagementTransaction(async (session) => {
      const engagement = await findFirmEngagement(engagementId, firmId, session);
      let replayQuery = EngagementFinding.findOne({
        firmId,
        engagementId: engagement._id,
        creationMutationKey: mutation.key,
      }).session(session);
      const existing = await replayQuery;
      if (existing) {
        assertMutationRequestHash(existing.creationRequestHash, mutation.requestHash);
        return existing;
      }
      if (["COMPLETE", "ARCHIVED"].includes(engagement.status)) {
        throw httpError(409, "Findings cannot be added to complete or archived engagements");
      }
      assertTemplateAttestedForFinding(engagement);
      await beginEngagementPublicationWrite(publication);
      const [created] = await EngagementFinding.create(
        [{
          firmId,
          engagementId: engagement._id,
          clientId: engagement.clientId,
          title: boundedText(input.title, 500, { required: true, label: "title" }),
          description: boundedText(input.description, 10000, { required: true, label: "description" }),
          category: validateFindingCategory(engagement, input.category),
          risk: input.risk === undefined
            ? "UNASSESSED"
            : normalizeEnum(input.risk, FINDING_RISK_SET, "finding risk"),
          status: "OPEN",
          evidenceReferences,
          creationMutationKey: mutation.key,
          creationRequestHash: mutation.requestHash,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        }],
        { session }
      );
      await touchEngagementForFinding({ engagement, actorUserId, publication, session });
      return created;
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    finding = await EngagementFinding.findOne({
      firmId,
      engagementId: objectId(engagementId, "engagementId"),
      creationMutationKey: mutation.key,
    });
    if (!finding) throw error;
    assertMutationRequestHash(finding.creationRequestHash, mutation.requestHash);
  }

  await ensureActivity({
    firmId,
    actorUserId,
    action: "ENGAGEMENT_FINDING_CREATED",
    entityType: "EngagementFinding",
    entityId: finding._id,
    mutation,
    publication,
    afterSummary: { status: finding.status, risk: finding.risk, category: finding.category },
    requestId,
    metadata: { engagementId: String(engagementId), professionalConclusionGenerated: false },
  });
  return finding;
}

function assertFindingClosure(finding, targetStatus, engagement, user) {
  assertAssignedReviewer(engagement, user);
  if (finding.review?.decision !== "APPROVED") {
    throw httpError(409, "Finding closure requires assigned reviewer approval");
  }
  if (!finding.managementResponse?.text) {
    throw httpError(409, "Finding closure requires a recorded management response");
  }
  if (!finding.action?.plan || !finding.action?.ownerUserId || !finding.action?.dueAt) {
    throw httpError(409, "Finding closure requires an action plan, active owner, and due date");
  }
  if (!finding.evidenceReferences?.length) {
    throw httpError(409, "Finding closure requires evidence references");
  }
  if (targetStatus === "CLOSED") {
    if (!finding.action.completedAt) throw httpError(409, "Closed findings require action completion evidence");
    if (!["EFFECTIVE", "NOT_APPLICABLE"].includes(finding.followUp?.result)) {
      throw httpError(409, "Closed findings require an effective or not-applicable follow-up result");
    }
  }
  if (targetStatus === "ACCEPTED_RISK" && finding.followUp?.result !== "NOT_APPLICABLE") {
    throw httpError(409, "Accepted-risk findings require a not-applicable follow-up result");
  }
  if (!finding.followUp?.note) throw httpError(409, "Finding closure requires a follow-up note");
}

async function updateEngagementFinding({
  engagementId,
  findingId,
  firmId,
  actorUserId,
  user,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, FINDING_PATCH_FIELDS, "Finding update");
  const mutation = engagementMutation(input, "engagement-finding-update");
  const findingFilter = {
    _id: objectId(findingId, "findingId"),
    engagementId: objectId(engagementId, "engagementId"),
    firmId,
  };

  let finding;
  try {
    finding = await withEngagementTransaction(async (session) => {
      const engagement = await findFirmEngagement(engagementId, firmId, session);
      const current = await EngagementFinding.findOne(findingFilter).session(session);
      if (!current) throw httpError(404, "Engagement finding not found", "ENGAGEMENT_FINDING_NOT_FOUND");
      if (mutationReceipt(current, mutation)) return current;
      if (["COMPLETE", "ARCHIVED"].includes(engagement.status)) {
        throw httpError(409, "Findings on complete or archived engagements are read-only");
      }
      assertTemplateAttestedForFinding(engagement);
      assertRevision(current, parseExpectedRevision(input.expectedRevision), "Finding");
      const beforeSummary = { status: current.status, risk: current.risk, revision: current.revision };
      const aiContentBefore = current.aiProvenance
        ? aiFindingContentSnapshot(current)
        : null;
      const aiChangedFields = new Set();
      let substantiveChange = false;
      let responseChanged = false;
      let actionDefinitionChanged = false;
      let actionCompletionChanged = false;
      let followUpChanged = false;
      const changed = (previous, next) => String(previous ?? "") !== String(next ?? "");
      const dateChanged = (previous, next) =>
        (previous ? new Date(previous).toISOString() : "") !==
        (next ? new Date(next).toISOString() : "");

      if (input.title !== undefined) {
        const value = boundedText(input.title, 500, { required: true, label: "title" });
        const fieldChanged = changed(current.title, value);
        substantiveChange ||= fieldChanged;
        if (fieldChanged) aiChangedFields.add("title");
        current.title = value;
      }
      if (input.description !== undefined) {
        const value = boundedText(input.description, 10000, { required: true, label: "description" });
        const fieldChanged = changed(current.description, value);
        substantiveChange ||= fieldChanged;
        if (fieldChanged) aiChangedFields.add("description");
        current.description = value;
      }
      if (input.category !== undefined) {
        const value = validateFindingCategory(engagement, input.category);
        const fieldChanged = changed(current.category, value);
        substantiveChange ||= fieldChanged;
        if (fieldChanged) aiChangedFields.add("category");
        current.category = value;
      }
      if (input.risk !== undefined) {
        const value = normalizeEnum(input.risk, FINDING_RISK_SET, "finding risk");
        const fieldChanged = changed(current.risk, value);
        substantiveChange ||= fieldChanged;
        if (fieldChanged) aiChangedFields.add("risk");
        current.risk = value;
      }
      if (input.evidenceReferences !== undefined) {
        const value = boundedStringArray(input.evidenceReferences, "evidenceReferences", {
          maxItems: 100,
          maxLength: 2000,
        });
        if (!value.length) throw httpError(400, "At least one evidence or source reference is required");
        const fieldChanged =
          stableJson(current.evidenceReferences || []) !== stableJson(value);
        substantiveChange ||= fieldChanged;
        if (fieldChanged) aiChangedFields.add("evidenceReferences");
        current.evidenceReferences = value;
      }
      if (aiContentBefore && aiChangedFields.size) {
        const beforeContentHash = aiFindingContentHash(aiContentBefore);
        const recordedCurrentHash = current.aiProvenance.currentContentHash;
        if (recordedCurrentHash && recordedCurrentHash !== beforeContentHash) {
          throw httpError(
            409,
            "AI finding provenance no longer matches current content; reload and investigate before editing",
            "ENGAGEMENT_FINDING_AI_PROVENANCE_CONFLICT"
          );
        }
        if ((current.aiProvenance.humanEditLineage?.length || 0) >= 500) {
          throw httpError(
            409,
            "AI finding edit lineage capacity reached",
            "ENGAGEMENT_FINDING_AI_LINEAGE_LIMIT"
          );
        }
        const afterContentHash = aiFindingContentHash(
          aiFindingContentSnapshot(current)
        );
        current.aiProvenance.humanEditLineage.push({
          mutationKey: mutation.key,
          editedBy: actorUserId,
          editedAt: new Date(),
          changedFields: [...aiChangedFields],
          beforeContentHash,
          afterContentHash,
        });
        current.aiProvenance.currentContentHash = afterContentHash;
      }
      if (input.managementResponseText !== undefined) {
        const value = boundedText(input.managementResponseText, 10000, {
          required: true,
          label: "managementResponseText",
        });
        responseChanged = changed(current.managementResponse.text, value);
        substantiveChange ||= responseChanged;
        current.managementResponse.text = value;
        if (responseChanged) {
          current.managementResponse.respondedAt = new Date();
          current.managementResponse.recordedBy = actorUserId;
        }
      }
      if (input.actionPlan !== undefined) {
        const value = boundedText(input.actionPlan, 10000, { required: true, label: "actionPlan" });
        actionDefinitionChanged ||= changed(current.action.plan, value);
        substantiveChange ||= actionDefinitionChanged;
        current.action.plan = value;
      }
      if (input.actionOwnerUserId !== undefined) {
        if (input.actionOwnerUserId) await validateFirmUsers([input.actionOwnerUserId], firmId);
        const value = input.actionOwnerUserId || null;
        const ownerChanged = changed(current.action.ownerUserId, value);
        actionDefinitionChanged ||= ownerChanged;
        substantiveChange ||= ownerChanged;
        current.action.ownerUserId = value;
      }
      if (input.actionDueAt !== undefined) {
        const value = parseDateValue(input.actionDueAt, "actionDueAt");
        const dueChanged = dateChanged(current.action.dueAt, value);
        actionDefinitionChanged ||= dueChanged;
        substantiveChange ||= dueChanged;
        current.action.dueAt = value;
      }
      if (input.actionCompletedAt !== undefined) {
        const value = parseDateValue(input.actionCompletedAt, "actionCompletedAt");
        actionCompletionChanged ||= dateChanged(current.action.completedAt, value);
        substantiveChange ||= actionCompletionChanged;
        current.action.completedAt = value;
      }
      if (input.actionCompletionNote !== undefined) {
        const value = boundedText(input.actionCompletionNote, 5000, { label: "actionCompletionNote" });
        const noteChanged = changed(current.action.completionNote, value);
        actionCompletionChanged ||= noteChanged;
        substantiveChange ||= noteChanged;
        current.action.completionNote = value;
      }
      if (input.followUpResult !== undefined) {
        const value = normalizeEnum(input.followUpResult, FOLLOW_UP_RESULT_SET, "followUpResult");
        followUpChanged ||= changed(current.followUp.result, value);
        substantiveChange ||= followUpChanged;
        current.followUp.result = value;
        if (followUpChanged) {
          current.followUp.verifiedBy = actorUserId;
          current.followUp.verifiedAt = new Date();
        }
      }
      if (input.followUpNote !== undefined) {
        const value = boundedText(input.followUpNote, 10000, { label: "followUpNote" });
        const noteChanged = changed(current.followUp.note, value);
        followUpChanged ||= noteChanged;
        substantiveChange ||= noteChanged;
        current.followUp.note = value;
        if (noteChanged) {
          current.followUp.verifiedBy = actorUserId;
          current.followUp.verifiedAt = new Date();
        }
      }
      if (substantiveChange && input.reviewDecision !== undefined) {
        throw httpError(
          409,
          "Save substantive finding changes before recording a reviewer decision",
          "ENGAGEMENT_FINDING_REVIEW_CONFLICT"
        );
      }

      let forcedStatus = null;
      if (responseChanged || actionDefinitionChanged) {
        current.action.completedAt = null;
        current.action.completionNote = "";
        current.followUp.result = "NOT_STARTED";
        current.followUp.note = "";
        current.followUp.verifiedBy = null;
        current.followUp.verifiedAt = null;
        if (["FOLLOW_UP_PENDING", "READY_FOR_REVIEW", "CLOSED", "ACCEPTED_RISK"].includes(current.status)) {
          forcedStatus = "ACTION_IN_PROGRESS";
        }
      } else if (actionCompletionChanged) {
        current.followUp.result = "NOT_STARTED";
        current.followUp.note = "";
        current.followUp.verifiedBy = null;
        current.followUp.verifiedAt = null;
        if (["CLOSED", "ACCEPTED_RISK"].includes(current.status)) forcedStatus = "ACTION_IN_PROGRESS";
        else if (current.status === "READY_FOR_REVIEW") forcedStatus = "FOLLOW_UP_PENDING";
      } else if (followUpChanged && ["CLOSED", "ACCEPTED_RISK"].includes(current.status)) {
        forcedStatus = "ACTION_IN_PROGRESS";
      }
      if (substantiveChange && ["CLOSED", "ACCEPTED_RISK"].includes(current.status)) {
        forcedStatus = "ACTION_IN_PROGRESS";
      }
      if (substantiveChange) {
        current.review.decision = "PENDING";
        current.review.note = "";
        current.review.reviewedBy = null;
        current.review.reviewedAt = null;
      }

      const requestedStatus = input.status === undefined
        ? current.status
        : normalizeEnum(input.status, FINDING_STATUS_SET, "finding status");
      const targetStatus = forcedStatus || requestedStatus;
      assertFindingStatusTransition(current.status, targetStatus);
      if (["CLOSED", "ACCEPTED_RISK"].includes(current.status) && targetStatus !== current.status) {
        assertAssignedReviewer(engagement, user);
        current.review.decision = "PENDING";
        current.review.note = "";
        current.review.reviewedBy = null;
        current.review.reviewedAt = null;
      }

      if (input.reviewDecision !== undefined) {
        assertAssignedReviewer(engagement, user);
        if (current.status !== "READY_FOR_REVIEW" && targetStatus !== "READY_FOR_REVIEW") {
          throw httpError(409, "Finding review decisions require Ready for Review status");
        }
        const decision = normalizeEnum(
          input.reviewDecision,
          new Set(["APPROVED", "CHANGES_REQUESTED"]),
          "reviewDecision"
        );
        const note = boundedText(input.reviewNote, 5000, { label: "reviewNote" });
        if (decision === "CHANGES_REQUESTED" && !note) {
          throw httpError(400, "Changes-requested review requires a note");
        }
        current.review.decision = decision;
        current.review.note = note;
        current.review.reviewedBy = actorUserId;
        current.review.reviewedAt = new Date();
      } else if (input.reviewNote !== undefined) {
        throw httpError(400, "reviewNote requires reviewDecision");
      }

      if (["ACTION_IN_PROGRESS", "FOLLOW_UP_PENDING", "READY_FOR_REVIEW", "CLOSED", "ACCEPTED_RISK"].includes(targetStatus)) {
        if (!current.managementResponse.text) {
          throw httpError(409, "Record management response before advancing the finding");
        }
        if (!current.action.plan || !current.action.ownerUserId || !current.action.dueAt) {
          throw httpError(409, "Record action plan, active owner, and due date before advancing the finding");
        }
      }
      if (["FOLLOW_UP_PENDING", "READY_FOR_REVIEW", "CLOSED"].includes(targetStatus)) {
        if (!current.action.completedAt) {
          throw httpError(409, "Record action completion before follow-up or review");
        }
        if (!current.action.completionNote) {
          throw httpError(409, "Record an action completion note before follow-up or review");
        }
      }
      if (["READY_FOR_REVIEW", "CLOSED", "ACCEPTED_RISK"].includes(targetStatus)) {
        if (current.followUp.result === "NOT_STARTED" || !current.followUp.note) {
          throw httpError(409, "Record follow-up result and note before review");
        }
      }
      if (["CLOSED", "ACCEPTED_RISK"].includes(targetStatus)) {
        await validateFirmUsers([current.action.ownerUserId], firmId);
        assertFindingClosure(current, targetStatus, engagement, user);
        current.closedAt = new Date();
        current.closedBy = actorUserId;
      } else {
        current.closedAt = null;
        current.closedBy = null;
      }

      current.status = targetStatus;
      current.updatedBy = actorUserId;
      appendMutationReceipt(current, mutation);
      current.revision += 1;
      const saved = await saveWithConflict(current, publication, "Finding", { mutation, session });
      await touchEngagementForFinding({ engagement, actorUserId, publication, session });
      saved.$locals.engagementBeforeSummary = beforeSummary;
      return saved;
    });
  } catch (error) {
    const winner = await mutationWinner(EngagementFinding, findingFilter, mutation);
    if (winner) finding = winner;
    else if (
      error?.name === "VersionError" ||
      error?.code === 112 ||
      error?.hasErrorLabel?.("TransientTransactionError")
    ) {
      throw httpError(
        409,
        "Finding changed in another request; reload and retry",
        "ENGAGEMENT_REVISION_CONFLICT"
      );
    } else {
      throw error;
    }
  }

  await ensureActivity({
    firmId,
    actorUserId,
    action: "ENGAGEMENT_FINDING_UPDATED",
    entityType: "EngagementFinding",
    entityId: finding._id,
    mutation,
    publication,
    beforeSummary: finding.$locals?.engagementBeforeSummary || null,
    afterSummary: {
      status: finding.status,
      risk: finding.risk,
      reviewDecision: finding.review.decision,
      revision: finding.revision,
    },
    requestId,
    metadata: { engagementId: String(engagementId), professionalConclusionGenerated: false },
  });
  return finding;
}

async function reviewEngagement({
  engagementId,
  firmId,
  actorUserId,
  user,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, REVIEW_FIELDS, "Engagement review");
  const action = String(input.action || "").trim().toUpperCase();
  const allowedActions = new Set([
    "ATTEST_TEMPLATE",
    "REQUEST_TEMPLATE_CHANGES",
    "APPROVE_FINAL",
    "REQUEST_FINAL_CHANGES",
  ]);
  if (!allowedActions.has(action)) throw httpError(400, "Unsupported engagement review action");
  const mutation = engagementMutation(input, `engagement-review-${action.toLowerCase()}`);
  let engagement = await findFirmEngagement(engagementId, firmId);
  const replay = mutationReceipt(engagement, mutation);
  const eventAction = {
    ATTEST_TEMPLATE: "ENGAGEMENT_TEMPLATE_ATTESTED",
    REQUEST_TEMPLATE_CHANGES: "ENGAGEMENT_TEMPLATE_CHANGES_REQUESTED",
    APPROVE_FINAL: "ENGAGEMENT_FINAL_REVIEW_APPROVED",
    REQUEST_FINAL_CHANGES: "ENGAGEMENT_FINAL_CHANGES_REQUESTED",
  }[action];
  if (replay) {
    await ensureActivity({
      firmId,
      actorUserId,
      action: eventAction,
      entityType: "Engagement",
      entityId: engagement._id,
      mutation,
      publication,
      afterSummary: {
        templateReview: engagement.templateReview?.status,
        finalReview: engagement.finalReview?.status,
        revision: engagement.revision,
      },
      requestId,
    });
    return engagement;
  }
  assertRevision(engagement, parseExpectedRevision(input.expectedRevision), "Engagement");
  if (["COMPLETE", "ARCHIVED"].includes(engagement.status)) {
    throw httpError(409, "Complete or archived engagements are read-only");
  }
  assertAssignedReviewer(engagement, user);
  const note = boundedText(input.note, 5000, { label: "review note" });
  const beforeSummary = {
    templateReview: engagement.templateReview?.status,
    finalReview: engagement.finalReview?.status,
    revision: engagement.revision,
  };

  const templateReviewAction = ["ATTEST_TEMPLATE", "REQUEST_TEMPLATE_CHANGES"].includes(action);
  if (templateReviewAction && engagement.status !== "DRAFT") {
    throw httpError(
      409,
      "Template review decisions are restricted to Draft engagements",
      "ENGAGEMENT_TEMPLATE_REVIEW_DRAFT_ONLY"
    );
  }

  if (action === "ATTEST_TEMPLATE") {
    if (!input.confirmed) throw httpError(400, "Template review attestation must be explicitly confirmed");
    engagement.templateReview.status = "ATTESTED";
    engagement.templateReview.reviewedBy = actorUserId;
    engagement.templateReview.reviewedAt = new Date();
    engagement.templateReview.reviewerName = boundedText(input.reviewerName, 300, {
      required: true,
      label: "reviewerName",
    });
    engagement.templateReview.credentialReference = boundedText(input.credentialReference, 500, {
      required: true,
      label: "credentialReference",
    });
    engagement.templateReview.note = note;
    engagement.templateReview.attestationText =
      "Assigned firm administrator attests that a human professional reviewed this template snapshot for this engagement. CA PRO does not verify qualification or correctness.";
  } else if (action === "REQUEST_TEMPLATE_CHANGES") {
    if (!note) throw httpError(400, "Template changes request requires a note");
    engagement.templateReview.status = "CHANGES_REQUESTED";
    engagement.templateReview.reviewedBy = actorUserId;
    engagement.templateReview.reviewedAt = new Date();
    engagement.templateReview.note = note;
    engagement.templateReview.attestationText = "";
  } else if (action === "APPROVE_FINAL") {
    if (engagement.status !== "FINALIZATION") {
      throw httpError(409, "Final review approval requires Finalization status");
    }
    const readiness = await closureReadiness(engagement, { includeFinalReview: false });
    if (!readiness.ready) throw closureError(readiness);
    engagement.finalReview.status = "APPROVED";
    engagement.finalReview.reviewedBy = actorUserId;
    engagement.finalReview.reviewedAt = new Date();
    engagement.finalReview.note = note;
    engagement.finalReview.reviewedRevision = engagement.revision + 1;
    engagement.finalReview.reviewedContentRevision = engagement.contentRevision;
    engagement.finalReview.contentFingerprint = await engagementContentFingerprint(engagement);
  } else {
    if (!["INTERNAL_REVIEW", "CLIENT_REVIEW", "FINALIZATION"].includes(engagement.status)) {
      throw httpError(409, "Final changes request requires an active review or finalization status");
    }
    if (!note) throw httpError(400, "Final changes request requires a note");
    engagement.finalReview.status = "CHANGES_REQUESTED";
    engagement.finalReview.reviewedBy = actorUserId;
    engagement.finalReview.reviewedAt = new Date();
    engagement.finalReview.note = note;
    engagement.finalReview.reviewedRevision = engagement.revision + 1;
    engagement.finalReview.reviewedContentRevision = null;
    engagement.finalReview.contentFingerprint = null;
  }
  if (templateReviewAction) {
    clearFinalReview(engagement);
    engagement.contentRevision += 1;
  }
  engagement.updatedBy = actorUserId;
  appendMutationReceipt(engagement, mutation);
  engagement.revision += 1;
  engagement = await saveWithConflict(engagement, publication, "Engagement", { mutation });
  await ensureActivity({
    firmId,
    actorUserId,
    action: eventAction,
    entityType: "Engagement",
    entityId: engagement._id,
    mutation,
    publication,
    beforeSummary,
    afterSummary: {
      templateReview: engagement.templateReview?.status,
      finalReview: engagement.finalReview?.status,
      revision: engagement.revision,
      platformQualificationVerified: false,
    },
    requestId,
    metadata: {
      professionalConclusionGenerated: false,
      templateQualificationVerifiedByPlatform: false,
    },
  });
  return engagement;
}

function exportSafeDocument(value) {
  const document = plain(value);
  delete document.__v;
  delete document.creationRequestHash;
  delete document.mutationReceipts;
  return document;
}

async function loadBoundedExport(model, filter, sort, label, session) {
  const documents = await model.find(filter)
    .select("-mutationReceipts -creationRequestHash")
    .sort(sort)
    .limit(MAX_EXPORT_RECORDS + 1)
    .session(session)
    .lean();
  if (documents.length > MAX_EXPORT_RECORDS) {
    throw httpError(
      413,
      `${label} exceeds the coherent export limit of ${MAX_EXPORT_RECORDS} records`,
      "ENGAGEMENT_EXPORT_LIMIT"
    );
  }
  return documents.map(exportSafeDocument);
}

function serializeExport(payload) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    if (buffer.byteLength > MAX_EXPORT_BYTES) {
      throw httpError(
        413,
        `Engagement export exceeds ${MAX_EXPORT_BYTES} serialized bytes`,
        "ENGAGEMENT_EXPORT_LIMIT"
      );
    }
    if (payload.exportCompleteness.serializedBytes === buffer.byteLength) return buffer;
    payload.exportCompleteness.serializedBytes = buffer.byteLength;
  }
  throw httpError(
    500,
    "Engagement export byte metadata could not be stabilized",
    "ENGAGEMENT_EXPORT_SERIALIZATION_ERROR"
  );
}

async function buildEngagementExport({ engagementId, firmId }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      readPreference: "primary",
    });
    const engagement = await Engagement.findOne({
      _id: objectId(engagementId, "engagementId"),
      firmId,
    })
      .select("-mutationReceipts -creationRequestHash")
      .session(session)
      .populate("clientId", "name pan gstin email phone")
      .populate("ownerUserId reviewerUserId teamUserIds", "name email role")
      .lean();
    if (!engagement) throw httpError(404, "Engagement not found", "ENGAGEMENT_NOT_FOUND");
    const findings = await loadBoundedExport(
      EngagementFinding,
      { firmId, engagementId: engagement._id },
      { createdAt: 1, _id: 1 },
      "Findings",
      session
    );
    const activity = await loadBoundedExport(
      ActivityEvent,
      {
        firmId,
        $or: [
          { entityType: "Engagement", entityId: String(engagement._id) },
          { entityType: "EngagementFinding", "metadata.engagementId": String(engagement._id) },
        ],
      },
      { occurredAt: 1, _id: 1 },
      "Activity",
      session
    );
    const payload = {
      schemaVersion: "engagement-export-v1",
      exportedAt: new Date().toISOString(),
      professionalConclusionGenerated: false,
      automaticPortalSubmissionPerformed: false,
      templateQualificationVerifiedByPlatform: false,
      safetyBoundary: {
        operationalSupportOnly: true,
        humanReviewRequired: true,
        binaryEvidenceIncluded: false,
        automaticOpinionGenerated: false,
      },
      exportCompleteness: {
        complete: true,
        consistency: "mongodb_transaction_snapshot",
        snapshotBoundary: "transaction_snapshot",
        exactSnapshotTimeAvailable: false,
        maximumRecordsPerCollection: MAX_EXPORT_RECORDS,
        maximumSerializedBytes: MAX_EXPORT_BYTES,
        serializedBytes: 0,
      },
      engagement: exportSafeDocument(engagement),
      findings,
      activity,
      truncation: { findings: false, activity: false },
    };
    const buffer = serializeExport(payload);
    await session.commitTransaction();
    return buffer;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (error?.statusCode) throw error;
    throw httpError(
      503,
      "A coherent MongoDB snapshot is unavailable; Engagement export was not produced",
      "ENGAGEMENT_EXPORT_SNAPSHOT_UNAVAILABLE"
    );
  } finally {
    await session.endSession();
  }
}

export {
  beginEngagementPublicationWrite,
  buildEngagementExport,
  closureReadiness,
  createEngagement,
  createEngagementFinding,
  engagementContentFingerprint,
  engagementPublicationFromRequest,
  getEngagementDetail,
  listEngagements,
  listEngagementTemplates,
  reviewEngagement,
  updateEngagement,
  updateEngagementFinding,
};
