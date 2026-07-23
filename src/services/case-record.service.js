import mongoose from "mongoose";
import Client from "../models/Client.js";
import CaseAnalysis from "../models/CaseAnalysis.js";
import CaseDraft from "../models/CaseDraft.js";
import CaseMatter, {
  CASE_FIELD_NAMES,
  CASE_STATUSES,
  CASE_TYPES,
} from "../models/CaseMatter.js";
import CaseSubmission from "../models/CaseSubmission.js";
import CaseTimelineEvent from "../models/CaseTimelineEvent.js";
import User from "../models/User.js";
import { proposeCaseExtraction } from "./case-ai.service.js";
import {
  completeCaseProviderOperation,
  failCaseProviderOperation,
  readCaseProviderOperationResult,
  reserveCaseProviderOperation,
  stageCaseProviderOperationResult,
} from "./case-provider-operation.service.js";
import { syncCaseDeadlineArtifacts } from "./case-deadline.service.js";
import { findFirmCase, recordCaseEvent } from "./case-event.service.js";
import {
  boundedStringArray,
  boundedText,
  hashText,
  httpError,
  assertMutationRequestHash,
  mutationKey,
  mutationRequestHash,
  normalizeConfirmedValue,
  normalizeOffsets,
  objectId,
  parsePagination,
  sourceText,
  stableJson,
} from "./case-validation.service.js";
import {
  beginNoticePublicationWrite,
} from "./notice-publication.service.js";

const CASE_TYPE_SET = new Set(CASE_TYPES);
const CASE_STATUS_SET = new Set(CASE_STATUSES);
const CASE_FIELD_SET = new Set(CASE_FIELD_NAMES);
const SOURCE_METHODS = new Set([
  "DIGITAL_PDF_LOCAL",
  "OCR_SPACE",
  "SCREENSHOT_OCR",
  "PASTED_TEXT",
  "MANUAL",
]);
const PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);
const RISKS = new Set(["UNASSESSED", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const CASE_HISTORY_DEFAULT_LIMIT = 100;
const CASE_HISTORY_MAX_LIMIT = 200;
const CASE_EXPORT_MAX_RECORDS_PER_COLLECTION = 2000;
const CASE_EXPORT_MAX_BYTES = 25 * 1024 * 1024;
const CASE_MUTATION_RECEIPT_LIMIT = 1000;
const CASE_STATUS_TRANSITIONS = new Map([
  ["INTAKE", new Set(["EXTRACTION_NEEDS_REVIEW", "OPEN", "DOCUMENTS_PENDING", "ANALYSIS", "RESPONSE_DRAFT", "CLOSED", "ARCHIVED"])],
  ["EXTRACTION_NEEDS_REVIEW", new Set(["OPEN", "DOCUMENTS_PENDING", "ANALYSIS", "RESPONSE_DRAFT", "CLOSED", "ARCHIVED"])],
  ["OPEN", new Set(["DOCUMENTS_PENDING", "ANALYSIS", "RESPONSE_DRAFT", "CLOSED", "ARCHIVED"])],
  ["DOCUMENTS_PENDING", new Set(["OPEN", "ANALYSIS", "RESPONSE_DRAFT", "CLOSED", "ARCHIVED"])],
  ["ANALYSIS", new Set(["DOCUMENTS_PENDING", "RESPONSE_DRAFT", "CLOSED", "ARCHIVED"])],
  ["RESPONSE_DRAFT", new Set(["DOCUMENTS_PENDING", "INTERNAL_REVIEW", "CLOSED", "ARCHIVED"])],
  ["INTERNAL_REVIEW", new Set(["RESPONSE_DRAFT", "CLIENT_APPROVAL", "CLOSED", "ARCHIVED"])],
  ["CLIENT_APPROVAL", new Set(["RESPONSE_DRAFT", "INTERNAL_REVIEW", "READY_TO_SUBMIT", "CLOSED", "ARCHIVED"])],
  ["READY_TO_SUBMIT", new Set(["SUBMITTED", "CLOSED", "ARCHIVED"])],
  ["SUBMITTED", new Set(["HEARING_SCHEDULED", "ORDER_RECEIVED", "APPEAL_REVIEW", "CLOSED", "ARCHIVED"])],
  ["HEARING_SCHEDULED", new Set(["ORDER_RECEIVED", "APPEAL_REVIEW", "CLOSED", "ARCHIVED"])],
  ["ORDER_RECEIVED", new Set(["APPEAL_REVIEW", "CLOSED", "ARCHIVED"])],
  ["APPEAL_REVIEW", new Set(["HEARING_SCHEDULED", "ORDER_RECEIVED", "CLOSED", "ARCHIVED"])],
  ["CLOSED", new Set(["ARCHIVED"])],
  ["ARCHIVED", new Set()],
]);

async function recordPublishedCaseEvent(noticePublication, event) {
  await beginNoticePublicationWrite(noticePublication);
  return recordCaseEvent(event);
}

async function syncPublishedCaseDeadlineArtifacts(
  noticePublication,
  parameters
) {
  await beginNoticePublicationWrite(noticePublication);
  return syncCaseDeadlineArtifacts(parameters);
}

function assertCaseStatusTransition(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return;
  if (!CASE_STATUS_TRANSITIONS.get(currentStatus)?.has(targetStatus)) {
    throw httpError(
      409,
      `Case status cannot move from ${currentStatus} to ${targetStatus} through generic tracking`,
      "CASE_STATUS_TRANSITION_NOT_ALLOWED"
    );
  }
}

function assertCaseDocumentWritable(caseMatter) {
  const transition = caseMatter?.contentTransition;
  if (!transition?.token) return;
  if (transition.expiresAt && new Date(transition.expiresAt) <= new Date()) {
    caseMatter.set("contentTransition", {});
    return;
  }
  throw httpError(
    409,
    "A Case content transition is in progress; retry after it completes",
    "CASE_CONTENT_TRANSITION_IN_PROGRESS"
  );
}

function caseMutation(input, action) {
  const key = mutationKey(input?.mutationKey);
  return {
    key,
    action,
    requestHash: mutationRequestHash(action, input),
    eventKey: `${action}:${key}`,
  };
}

function mutationReceipt(caseMatter, mutation) {
  const receipt = caseMatter.mutationReceipts?.find(
    (item) => item.key === mutation.key
  );
  if (!receipt) return null;
  assertMutationRequestHash(receipt.requestHash, mutation.requestHash);
  if (receipt.action !== mutation.action && receipt.action !== undefined) {
    throw httpError(409, "mutationKey was already used for another Case action", "MUTATION_KEY_REUSED");
  }
  return receipt;
}

function appendMutationReceipt(caseMatter, mutation, resultId = "") {
  if ((caseMatter.mutationReceipts?.length || 0) >= CASE_MUTATION_RECEIPT_LIMIT) {
    throw httpError(
      409,
      "Case mutation receipt limit reached; archive this case before more writes",
      "CASE_MUTATION_LIMIT_REACHED"
    );
  }
  caseMatter.mutationReceipts.push({
    key: mutation.key,
    action: mutation.action,
    requestHash: mutation.requestHash,
    resultId,
    appliedRevision: caseMatter.revision + 1,
    appliedAt: new Date(),
  });
}

async function findEventReplay(caseMatter, mutation) {
  const event = await CaseTimelineEvent.findOne({
    firmId: caseMatter.firmId,
    caseId: caseMatter._id,
    mutationKey: mutation.eventKey,
  });
  if (event) assertMutationRequestHash(event.requestHash, mutation.requestHash);
  return event;
}

function encodeCaseCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCaseCursor(value, expectedKind) {
  const encoded = boundedText(value, 1000, { label: `${expectedKind} cursor` });
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || parsed.kind !== expectedKind) throw new Error("kind mismatch");
    return parsed;
  } catch {
    throw httpError(400, `${expectedKind} cursor is invalid`, "INVALID_CASE_CURSOR");
  }
}

function combineCaseFilters(...filters) {
  const active = filters.filter((filter) => filter && Object.keys(filter).length);
  if (!active.length) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

function caseSnapshot(value) {
  if (!value) return new Date();
  const snapshot = new Date(value);
  if (Number.isNaN(snapshot.getTime())) {
    throw httpError(400, "snapshotAt must be a valid date", "INVALID_CASE_SNAPSHOT");
  }
  const now = new Date();
  return snapshot > now ? now : snapshot;
}

function historyLimit(query) {
  const limit = Number(query?.historyLimit || CASE_HISTORY_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > CASE_HISTORY_MAX_LIMIT) {
    throw httpError(
      400,
      `historyLimit must be between 1 and ${CASE_HISTORY_MAX_LIMIT}`
    );
  }
  return limit;
}

async function loadTimelinePage(filter, cursorValue, limit) {
  const cursor = decodeCaseCursor(cursorValue, "case-timeline-v1");
  let cursorFilter = null;
  if (cursor) {
    const occurredAt = new Date(cursor.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw httpError(400, "case-timeline-v1 cursor is invalid", "INVALID_CASE_CURSOR");
    }
    const id = objectId(cursor.id, "timeline cursor ID");
    cursorFilter = {
      $or: [
        { occurredAt: { $lt: occurredAt } },
        { occurredAt, _id: { $lt: id } },
      ],
    };
  }
  const documents = await CaseTimelineEvent.find(
    combineCaseFilters(filter, cursorFilter)
  )
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCaseCursor({
            kind: "case-timeline-v1",
            occurredAt: new Date(last.occurredAt).toISOString(),
            id: String(last._id),
          })
        : null,
  };
}

async function loadVersionPage(Model, filter, cursorValue, cursorKind, limit) {
  const cursor = decodeCaseCursor(cursorValue, cursorKind);
  let cursorFilter = null;
  if (cursor) {
    const version = Number(cursor.version);
    if (!Number.isInteger(version) || version < 1) {
      throw httpError(400, `${cursorKind} cursor is invalid`, "INVALID_CASE_CURSOR");
    }
    cursorFilter = { version: { $lt: version } };
  }
  const documents = await Model.find(combineCaseFilters(filter, cursorFilter))
    .sort({ version: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCaseCursor({ kind: cursorKind, version: last.version })
        : null,
  };
}

async function loadCompleteCaseHistory(Model, filter, sort, label, session) {
  const documents = await Model.find(filter)
    .session(session)
    .sort(sort)
    .limit(CASE_EXPORT_MAX_RECORDS_PER_COLLECTION + 1)
    .lean();
  if (documents.length > CASE_EXPORT_MAX_RECORDS_PER_COLLECTION) {
    throw httpError(
      413,
      `Case export exceeds ${CASE_EXPORT_MAX_RECORDS_PER_COLLECTION} ${label} records; narrow or archive history before exporting`,
      "CASE_EXPORT_TOO_LARGE"
    );
  }
  return documents;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requireFirmClient(clientId, firmId) {
  const client = await Client.findOne({
    _id: objectId(clientId, "clientId"),
    firmId,
    isActive: true,
  })
    .select("_id name")
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

function sourceProvider(method) {
  if (method === "OCR_SPACE" || method === "SCREENSHOT_OCR") return "OCR_SPACE";
  if (method === "DIGITAL_PDF_LOCAL") return "LOCAL";
  return "MANUAL";
}

async function createCaseMatter({
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const mutation = caseMutation(input, "case-intake");
  let caseMatter = await CaseMatter.findOne({
    firmId,
    intakeMutationKey: mutation.key,
  });
  if (caseMatter) {
    assertMutationRequestHash(caseMatter.intakeRequestHash, mutation.requestHash);
  } else {
    const client = await requireFirmClient(input.clientId, firmId);
    const caseType = String(input.caseType || "").trim().toUpperCase();
    if (!CASE_TYPE_SET.has(caseType)) throw httpError(400, "Unsupported caseType");
    const method = String(input.sourceMethod || "MANUAL").trim().toUpperCase();
    if (!SOURCE_METHODS.has(method)) throw httpError(400, "Unsupported sourceMethod");
    const isExternalOcr = method === "OCR_SPACE" || method === "SCREENSHOT_OCR";
    if (isExternalOcr && input.externalProcessingConsent !== true) {
      throw httpError(400, "Explicit OCR processing consent is required for this source method");
    }
    const text = sourceText(input.sourceText || "");
    if (method !== "MANUAL" && !text) {
      throw httpError(400, "sourceText is required for this intake method");
    }
    const title = boundedText(input.title, 500, { required: true, label: "title" });
    const assignmentIds = [
      input.ownerUserId || actorUserId,
      input.reviewerUserId,
      input.escalationOwnerUserId,
    ];
    await validateFirmUsers(assignmentIds, firmId);
    const reminderOffsets = normalizeOffsets(input.reminderOffsets);

    await beginNoticePublicationWrite(noticePublication);
    try {
      caseMatter = await CaseMatter.create({
        firmId,
        intakeMutationKey: mutation.key,
        intakeRequestHash: mutation.requestHash,
        clientId: client._id,
        caseType,
        title,
        internalReference: boundedText(input.internalReference, 160, {
          label: "internalReference",
        }),
        priority: PRIORITIES.has(String(input.priority || "").toUpperCase())
          ? String(input.priority).toUpperCase()
          : "NORMAL",
        risk: RISKS.has(String(input.risk || "").toUpperCase())
          ? String(input.risk).toUpperCase()
          : "UNASSESSED",
        ownerUserId: input.ownerUserId || actorUserId,
        reviewerUserId: input.reviewerUserId || null,
        escalationOwnerUserId: input.escalationOwnerUserId || null,
        source: {
          method,
          sourceName: boundedText(input.sourceName, 240, { label: "sourceName" }),
          mimeType: boundedText(input.mimeType || "text/plain", 120, {
            label: "mimeType",
          }),
          sizeBytes: Math.max(
            0,
            Math.min(25 * 1024 * 1024, Number(input.sizeBytes) || 0)
          ),
          extractedText: text,
          textHash: hashText(text),
          extractionProvider: sourceProvider(method),
          extractedAt: new Date(),
          externalProcessingConsentAt: isExternalOcr ? new Date() : null,
          binaryStored: false,
        },
        extractionStatus: "NOT_REQUESTED",
        reminderOffsets,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      caseMatter = await CaseMatter.findOne({
        firmId,
        intakeMutationKey: mutation.key,
      });
      if (!caseMatter) throw error;
      assertMutationRequestHash(caseMatter.intakeRequestHash, mutation.requestHash);
    }
  }

  await beginNoticePublicationWrite(noticePublication);
  await recordPublishedCaseEvent(noticePublication, {
    caseMatter,
    actorUserId,
    type: "INTAKE_CREATED",
    title: "Case intake created",
    detail: `Source method ${caseMatter.source.method}; binary file not stored.`,
    metadata: {
      clientId: String(caseMatter.clientId),
      sourceMethod: caseMatter.source.method,
      binaryStored: false,
    },
    mutationKey: mutation.eventKey,
    requestHash: mutation.requestHash,
    requestId,
  });
  return caseMatter;
}

async function listCaseMatters({ firmId, query }) {
  const { limit } = parsePagination(query);
  const cursor = decodeCaseCursor(query?.cursor, "case-list-v1");
  const snapshotAt = caseSnapshot(query?.snapshotAt || cursor?.snapshotAt);
  if (
    cursor?.snapshotAt &&
    new Date(cursor.snapshotAt).toISOString() !== snapshotAt.toISOString()
  ) {
    throw httpError(400, "Case list cursor does not match snapshotAt", "INVALID_CASE_CURSOR");
  }
  const filter = { firmId };
  const status = String(query?.status || "").trim().toUpperCase();
  const caseType = String(query?.caseType || "").trim().toUpperCase();
  const clientId = String(query?.clientId || "").trim().toLowerCase();
  if (status) {
    if (!CASE_STATUS_SET.has(status)) throw httpError(400, "Unsupported status filter");
    filter.status = status;
  }
  if (caseType) {
    if (!CASE_TYPE_SET.has(caseType)) throw httpError(400, "Unsupported caseType filter");
    filter.caseType = caseType;
  }
  if (clientId) filter.clientId = objectId(clientId, "clientId");
  const search = boundedText(query?.search, 120, { label: "search" });
  if (search) {
    const expression = new RegExp(escapeRegex(search), "i");
    const clientIds = await Client.find({ firmId, isActive: true, name: expression })
      .select("_id")
      .limit(100)
      .lean();
    filter.$or = [
      { title: expression },
      { internalReference: expression },
      { "confirmedFacts.din": expression },
      { clientId: { $in: clientIds.map((client) => client._id) } },
    ];
  }

  const filterHash = hashText(
    stableJson({ status, caseType, clientId, search: search.toLowerCase() })
  );
  if (cursor?.filterHash !== undefined && cursor.filterHash !== filterHash) {
    throw httpError(
      400,
      "Case list cursor does not match the active filters",
      "INVALID_CASE_CURSOR"
    );
  }
  if (cursor && !cursor.filterHash) {
    throw httpError(
      400,
      "Legacy Case list cursor is no longer valid; restart pagination",
      "INVALID_CASE_CURSOR"
    );
  }

  let cursorFilter = null;
  if (cursor) {
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw httpError(400, "case-list-v1 cursor is invalid", "INVALID_CASE_CURSOR");
    }
    const id = objectId(cursor.id, "case cursor ID");
    cursorFilter = {
      $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: id } },
      ],
    };
  }
  const snapshotFilter = { createdAt: { $lte: snapshotAt } };
  const stableFilter = combineCaseFilters(filter, snapshotFilter, cursorFilter);
  const totalFilter = combineCaseFilters(filter, snapshotFilter);
  const [documents, total] = await Promise.all([
    CaseMatter.find(stableFilter)
      .select("-source.extractedText -extractionProposals -confirmationEvidence")
      .populate("clientId", "name pan gstin")
      .populate("ownerUserId reviewerUserId escalationOwnerUserId", "name email role")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    CaseMatter.countDocuments(totalFilter),
  ]);
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const last = items.at(-1);
  return {
    cases: items,
    pagination: {
      limit,
      total,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCaseCursor({
              kind: "case-list-v1",
              filterHash,
              snapshotAt: snapshotAt.toISOString(),
              createdAt: new Date(last.createdAt).toISOString(),
              id: String(last._id),
            })
          : null,
      snapshotAt: snapshotAt.toISOString(),
      sort: "createdAt_desc_id_desc",
      membershipConsistency: "created_at_snapshot_with_live_filter_membership",
      filterHash,
    },
  };
}

async function getCaseDetail({ caseId, firmId, query = {} }) {
  const caseMatter = await CaseMatter.findOne({ _id: objectId(caseId, "caseId"), firmId })
    .populate("clientId", "name pan gstin email phone")
    .populate("ownerUserId reviewerUserId escalationOwnerUserId", "name email role")
    .lean();
  if (!caseMatter) throw httpError(404, "Case not found", "CASE_NOT_FOUND");
  const filter = { firmId, caseId: caseMatter._id };
  const limit = historyLimit(query);
  const [timelinePage, analysisPage, draftPage, submissionPage] = await Promise.all([
    loadTimelinePage(filter, query.timelineCursor, limit),
    loadVersionPage(
      CaseAnalysis,
      filter,
      query.analysisCursor,
      "case-analysis-v1",
      limit
    ),
    loadVersionPage(
      CaseDraft,
      filter,
      query.draftCursor,
      "case-draft-v1",
      limit
    ),
    loadVersionPage(
      CaseSubmission,
      filter,
      query.submissionCursor,
      "case-submission-v1",
      limit
    ),
  ]);
  return {
    case: caseMatter,
    timeline: timelinePage.items,
    analyses: analysisPage.items,
    drafts: draftPage.items,
    submissions: submissionPage.items,
    historyPagination: {
      limit,
      timeline: {
        hasMore: timelinePage.hasMore,
        nextCursor: timelinePage.nextCursor,
      },
      analyses: {
        hasMore: analysisPage.hasMore,
        nextCursor: analysisPage.nextCursor,
      },
      drafts: {
        hasMore: draftPage.hasMore,
        nextCursor: draftPage.nextCursor,
      },
      submissions: {
        hasMore: submissionPage.hasMore,
        nextCursor: submissionPage.nextCursor,
      },
    },
    truncation: {
      timeline: timelinePage.hasMore,
      analyses: analysisPage.hasMore,
      drafts: draftPage.hasMore,
      submissions: submissionPage.hasMore,
    },
  };
}

async function runCaseExtraction({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  if (input?.consent !== true) {
    throw httpError(400, "Explicit DeepSeek processing consent is required", "CASE_AI_CONSENT_REQUIRED");
  }
  const mutation = caseMutation(input, "case-extraction");
  let caseMatter = await findFirmCase(caseId, firmId);
  let replay = mutationReceipt(caseMatter, mutation);
  if (!replay) {
    await beginNoticePublicationWrite(noticePublication);
    let reservation = await reserveCaseProviderOperation({
      firmId,
      caseId: caseMatter._id,
      action: "CASE_EXTRACTION",
      mutationKey: mutation.key,
      requestHash: mutation.requestHash,
    });
    if (reservation.completed) {
      caseMatter = await findFirmCase(caseId, firmId);
      replay = mutationReceipt(caseMatter, mutation);
      if (!replay) {
        throw httpError(
          409,
          "Completed extraction reservation has no Case result",
          "CASE_PROVIDER_RESULT_MISSING"
        );
      }
    } else {
      try {
        await beginNoticePublicationWrite(noticePublication);
        let result = readCaseProviderOperationResult(reservation.operation);
        if (!result) {
          result = await proposeCaseExtraction(caseMatter);
          reservation = {
            ...reservation,
            operation: await stageCaseProviderOperationResult(
              reservation.operation,
              result
            ),
          };
        }
        await beginNoticePublicationWrite(noticePublication);
        caseMatter.extractionProposals = result.proposals;
        caseMatter.extractionStatus = "EXTRACTION_NEEDS_REVIEW";
        if (caseMatter.status === "INTAKE") caseMatter.status = "EXTRACTION_NEEDS_REVIEW";
        caseMatter.updatedBy = actorUserId;
        appendMutationReceipt(caseMatter, mutation);
        caseMatter.revision += 1;
        await saveCaseMatterOrConflict(caseMatter, noticePublication);
        await completeCaseProviderOperation(reservation.operation, caseMatter._id);
        await beginNoticePublicationWrite(noticePublication);
        await recordPublishedCaseEvent(noticePublication, {
          caseMatter,
          actorUserId,
          type: "EXTRACTION_PROPOSED",
          title: "Source-linked extraction proposed",
          detail: `${result.proposals.length} field proposal(s) require confirmation.`,
          metadata: {
            proposalCount: result.proposals.length,
            provider: result.provider,
            model: result.model,
          },
          mutationKey: mutation.eventKey,
          requestHash: mutation.requestHash,
          requestId,
          activitySource: "AI_ASSISTED",
        });
        return caseMatter;
      } catch (error) {
        await failCaseProviderOperation(reservation.operation, error);
        throw error;
      }
    }
  }

  if (!(await findEventReplay(caseMatter, mutation))) {
    await beginNoticePublicationWrite(noticePublication);
    await recordPublishedCaseEvent(noticePublication, {
      caseMatter,
      actorUserId,
      type: "EXTRACTION_PROPOSED",
      title: "Source-linked extraction proposed",
      detail: `${caseMatter.extractionProposals.length} field proposal(s) require confirmation.`,
      metadata: { proposalCount: caseMatter.extractionProposals.length, replayRecovered: true },
      mutationKey: mutation.eventKey,
      requestHash: mutation.requestHash,
      requestId,
      activitySource: "AI_ASSISTED",
    });
  }
  return caseMatter;
}

function proposalForConfirmation(caseMatter, confirmation) {
  if (!confirmation.proposalId) return null;
  const proposal = caseMatter.extractionProposals.id(confirmation.proposalId);
  if (!proposal || proposal.field !== confirmation.field) {
    throw httpError(400, `No matching extraction proposal exists for ${confirmation.field}`);
  }
  return proposal;
}

async function saveCaseMatterOrConflict(caseMatter, noticePublication) {
  assertCaseDocumentWritable(caseMatter);
  await beginNoticePublicationWrite(noticePublication);
  try {
    await caseMatter.save();
  } catch (error) {
    if (error?.name === "VersionError") {
      throw httpError(
        409,
        "Case changed in another request; reload and retry",
        "CASE_REVISION_CONFLICT"
      );
    }
    throw error;
  }
}

async function confirmCaseFields({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const mutation = caseMutation(input, "case-confirmations");
  const caseMatter = await findFirmCase(caseId, firmId);
  const replay = mutationReceipt(caseMatter, mutation);
  if (replay) {
    const deadlineArtifacts = await syncPublishedCaseDeadlineArtifacts(noticePublication, { caseMatter, actorUserId });
    if (!(await findEventReplay(caseMatter, mutation))) {
      await recordPublishedCaseEvent(noticePublication, {
        caseMatter,
        actorUserId,
        type: "FIELDS_CONFIRMED",
        title: "Case fields confirmed",
        detail: "Confirmation mutation replay recovered.",
        metadata: { replayRecovered: true },
        mutationKey: mutation.eventKey,
        requestHash: mutation.requestHash,
        requestId,
      });
    }
    return { caseMatter, deadlineArtifacts };
  }
  const confirmations = Array.isArray(input.confirmations) ? input.confirmations : [];
  if (!confirmations.length || confirmations.length > CASE_FIELD_NAMES.length) {
    throw httpError(400, "confirmations must contain 1-17 case fields");
  }
  const seen = new Set();
  const confirmedFields = [];
  if (caseMatter.confirmationEvidence.length + confirmations.length > 500) {
    throw httpError(409, "Case confirmation history has reached its 500-entry limit");
  }
  for (const confirmation of confirmations) {
    const field = String(confirmation?.field || "").trim();
    if (!CASE_FIELD_SET.has(field) || seen.has(field)) {
      throw httpError(400, `Invalid or duplicate confirmation field: ${field || "unknown"}`);
    }
    seen.add(field);
    const proposal = proposalForConfirmation(caseMatter, confirmation);
    const value = normalizeConfirmedValue(field, confirmation.value ?? proposal?.value);
    const source = proposal ? "AI_PROPOSAL" : String(confirmation.source || "MANUAL").toUpperCase();
    if (!new Set(["AI_PROPOSAL", "SOURCE_TEXT", "MANUAL"]).has(source)) {
      throw httpError(400, `Invalid confirmation source for ${field}`);
    }
    const sourceExcerpt = boundedText(
      confirmation.sourceText ?? proposal?.sourceText,
      1200,
      { label: `${field} sourceText` }
    );
    caseMatter.set(`confirmedFacts.${field}`, value);
    caseMatter.confirmationEvidence.push({
      field,
      valueHash: hashText(stableJson(value)),
      sourceText: sourceExcerpt,
      confidence: proposal?.confidence ?? null,
      confirmedBy: actorUserId,
      confirmedAt: new Date(),
      source,
    });
    confirmedFields.push(field);
  }
  if (input.reminderOffsets !== undefined) {
    caseMatter.reminderOffsets = normalizeOffsets(input.reminderOffsets);
  }
  caseMatter.extractionStatus = "CONFIRMED";
  if (["INTAKE", "EXTRACTION_NEEDS_REVIEW"].includes(caseMatter.status)) caseMatter.status = "OPEN";
  caseMatter.updatedBy = actorUserId;
  appendMutationReceipt(caseMatter, mutation);
  caseMatter.revision += 1;
  await saveCaseMatterOrConflict(caseMatter, noticePublication);

  const deadlineArtifacts = await syncPublishedCaseDeadlineArtifacts(noticePublication, { caseMatter, actorUserId });
  await recordPublishedCaseEvent(noticePublication, {
    caseMatter,
    actorUserId,
    type: "FIELDS_CONFIRMED",
    title: "Case fields confirmed",
    detail: `${confirmedFields.length} field(s) confirmed by a user.`,
    metadata: {
      confirmedFields,
      deadlineProjection: deadlineArtifacts.active
        ? "ACTIVE"
        : deadlineArtifacts.deactivated
          ? "DEACTIVATED"
          : "NONE",
    },
    mutationKey: mutation.eventKey,
    requestHash: mutation.requestHash,
    requestId,
  });
  if (deadlineArtifacts.active || deadlineArtifacts.deactivated) {
    await recordPublishedCaseEvent(noticePublication, {
      caseMatter,
      actorUserId,
      type: "DEADLINE_ARTIFACTS_SYNCED",
      title: deadlineArtifacts.active
        ? "Confirmed response deadline synchronized"
        : "Response deadline artifacts deactivated",
      detail: deadlineArtifacts.active
        ? "Case task and reminder use the confirmed response due date."
        : "Case task and reminder are inactive for the current case state.",
      metadata: {
        taskId: deadlineArtifacts.task?._id ? String(deadlineArtifacts.task._id) : null,
        reminderId: deadlineArtifacts.reminder?._id
          ? String(deadlineArtifacts.reminder._id)
          : null,
        scheduleChanged: deadlineArtifacts.scheduleChanged,
        caseRevision: deadlineArtifacts.caseRevision,
      },
      mutationKey: `${mutation.eventKey}:deadline`,
      requestHash: mutation.requestHash,
      requestId,
    });
  }
  return { caseMatter, deadlineArtifacts };
}

async function updateCaseMatter({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const mutation = caseMutation(input, "case-update");
  const caseMatter = await findFirmCase(caseId, firmId);
  const replay = mutationReceipt(caseMatter, mutation);
  if (replay) {
    await syncPublishedCaseDeadlineArtifacts(noticePublication, { caseMatter, actorUserId });
    return caseMatter;
  }
  const beforeStatus = caseMatter.status;
  const assignmentKeys = ["ownerUserId", "reviewerUserId", "escalationOwnerUserId"];
  await validateFirmUsers(
    assignmentKeys.map((key) => input[key]).filter((value) => value !== undefined && value !== null && value !== ""),
    firmId
  );
  if (input.title !== undefined) {
    caseMatter.title = boundedText(input.title, 500, { required: true, label: "title" });
  }
  if (input.internalReference !== undefined) {
    caseMatter.internalReference = boundedText(input.internalReference, 160, { label: "internalReference" });
  }
  if (input.priority !== undefined) {
    const priority = String(input.priority).toUpperCase();
    if (!PRIORITIES.has(priority)) throw httpError(400, "Unsupported priority");
    caseMatter.priority = priority;
  }
  if (input.risk !== undefined) {
    const risk = String(input.risk).toUpperCase();
    if (!RISKS.has(risk)) throw httpError(400, "Unsupported risk");
    caseMatter.risk = risk;
  }
  for (const key of assignmentKeys) {
    if (input[key] !== undefined) caseMatter[key] = input[key] ? objectId(input[key], key) : null;
  }
  if (input.outcome !== undefined) {
    caseMatter.outcome = boundedText(input.outcome, 5000, { label: "outcome" });
  }
  if (input.status !== undefined) {
    const status = String(input.status).toUpperCase();
    if (!CASE_STATUS_SET.has(status)) throw httpError(400, "Unsupported case status");
    assertCaseStatusTransition(beforeStatus, status);
    if (status === "INTERNAL_REVIEW") {
      const reviewDraft = await CaseDraft.exists({
        firmId,
        caseId: caseMatter._id,
        status: "IN_REVIEW",
      });
      if (!reviewDraft) throw httpError(409, "An in-review draft is required before Internal Review");
    }
    if (status === "CLIENT_APPROVAL") {
      const approvedDraft = await CaseDraft.exists({
        firmId,
        caseId: caseMatter._id,
        status: { $in: ["APPROVED", "FINAL"] },
      });
      if (!approvedDraft) throw httpError(409, "An approved draft is required before Client Approval");
    }
    if (status === "READY_TO_SUBMIT") {
      const finalDraft = await CaseDraft.exists({ firmId, caseId: caseMatter._id, status: "FINAL" });
      if (!finalDraft) throw httpError(409, "A reviewer-approved final draft is required before Ready to Submit");
    }
    if (status === "SUBMITTED") {
      const submission = await CaseSubmission.exists({ firmId, caseId: caseMatter._id });
      if (!submission) throw httpError(409, "Record a submission before setting the case to Submitted");
    }
    caseMatter.status = status;
    caseMatter.archivedAt = status === "ARCHIVED" ? new Date() : null;
  }
  caseMatter.updatedBy = actorUserId;
  appendMutationReceipt(caseMatter, mutation);
  caseMatter.revision += 1;
  await saveCaseMatterOrConflict(caseMatter, noticePublication);
  const deadlineArtifacts = await syncPublishedCaseDeadlineArtifacts(noticePublication, { caseMatter, actorUserId });
  await recordPublishedCaseEvent(noticePublication, {
    caseMatter,
    actorUserId,
    type: beforeStatus === caseMatter.status ? "NOTE_ADDED" : "STATUS_CHANGED",
    title: beforeStatus === caseMatter.status ? "Case details updated" : "Case status changed",
    detail: beforeStatus === caseMatter.status ? "Case assignment or tracking details changed." : `${beforeStatus} to ${caseMatter.status}`,
    metadata: {
      beforeStatus,
      afterStatus: caseMatter.status,
      deadlineProjection: deadlineArtifacts.active
        ? "ACTIVE"
        : deadlineArtifacts.deactivated
          ? "DEACTIVATED"
          : "NONE",
      projectionRevision: deadlineArtifacts.caseRevision,
    },
    mutationKey: mutation.eventKey,
    requestHash: mutation.requestHash,
    requestId,
  });
  return caseMatter;
}

async function addCaseTimelineEntry({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const mutation = caseMutation(input, "case-timeline");
  const caseMatter = await findFirmCase(caseId, firmId);
  const existingEvent = await findEventReplay(caseMatter, mutation);
  if (existingEvent) return existingEvent;

  const kind = String(input.type || "NOTE_ADDED").toUpperCase();
  if (!new Set(["NOTE_ADDED", "HEARING_RECORDED", "OUTCOME_RECORDED"]).has(kind)) {
    throw httpError(400, "Timeline type must be NOTE_ADDED, HEARING_RECORDED, or OUTCOME_RECORDED");
  }
  const title = boundedText(input.title, 500, { required: true, label: "title" });
  const detail = boundedText(input.detail, 5000, { label: "detail" });
  const metadata = {};
  if (kind === "HEARING_RECORDED") {
    const hearingAt = new Date(input.hearingAt);
    if (Number.isNaN(hearingAt.getTime())) {
      throw httpError(400, "hearingAt must be a valid date");
    }
    metadata.hearingAt = hearingAt.toISOString();
  }
  if (kind === "OUTCOME_RECORDED" && !mutationReceipt(caseMatter, mutation)) {
    caseMatter.outcome = detail;
    caseMatter.updatedBy = actorUserId;
    appendMutationReceipt(caseMatter, mutation);
    caseMatter.revision += 1;
    await saveCaseMatterOrConflict(caseMatter, noticePublication);
  }
  return recordPublishedCaseEvent(noticePublication, {
    caseMatter,
    actorUserId,
    type: kind,
    title,
    detail,
    metadata,
    mutationKey: mutation.eventKey,
    requestHash: mutation.requestHash,
    requestId,
  });
}

async function addVerifiedReference({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const mutation = caseMutation(input, "case-reference");
  const caseMatter = await findFirmCase(caseId, firmId);
  const replay = mutationReceipt(caseMatter, mutation);
  if (replay) {
    const reference = caseMatter.verifiedReferences.id(replay.resultId);
    if (!reference) {
      throw httpError(409, "Reference replay target is unavailable", "CASE_REPLAY_TARGET_MISSING");
    }
    return reference;
  }
  if (caseMatter.verifiedReferences.length >= 100) {
    throw httpError(409, "Case already has the maximum 100 verified references");
  }
  const title = boundedText(input.title, 500, { required: true, label: "reference title" });
  const locator = boundedText(input.locator, 1000, { label: "reference locator" });
  const excerpt = boundedText(input.excerpt, 5000, { label: "reference excerpt" });
  if (!locator && !excerpt) throw httpError(400, "Reference locator or excerpt is required");
  caseMatter.verifiedReferences.push({
    sourceType: "USER_VERIFIED",
    title,
    locator,
    excerpt,
    verifiedBy: actorUserId,
    verifiedAt: new Date(),
  });
  const reference = caseMatter.verifiedReferences.at(-1);
  caseMatter.updatedBy = actorUserId;
  appendMutationReceipt(caseMatter, mutation, String(reference._id));
  caseMatter.revision += 1;
  await saveCaseMatterOrConflict(caseMatter, noticePublication);
  await recordPublishedCaseEvent(noticePublication, {
    caseMatter,
    actorUserId,
    type: "REFERENCE_VERIFIED",
    title: "User-verified reference added",
    detail: title,
    metadata: { referenceId: String(reference._id), sourceType: "USER_VERIFIED" },
    mutationKey: mutation.eventKey,
    requestHash: mutation.requestHash,
    requestId,
  });
  return reference;
}

function serializeCaseExport(payload) {
  let serializedBytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    payload.exportCompleteness.serializedBytes = serializedBytes;
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    if (buffer.byteLength === serializedBytes) {
      if (buffer.byteLength > CASE_EXPORT_MAX_BYTES) {
        throw httpError(
          413,
          `Complete case export is ${buffer.byteLength} bytes and exceeds the ${CASE_EXPORT_MAX_BYTES}-byte safety limit`,
          "CASE_EXPORT_TOO_LARGE"
        );
      }
      return buffer;
    }
    serializedBytes = buffer.byteLength;
  }
  throw httpError(
    500,
    "Case export byte measurement did not converge",
    "CASE_EXPORT_SERIALIZATION_FAILED"
  );
}

async function buildCaseExport({ caseId, firmId }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      readPreference: "primary",
    });
    const caseMatter = await CaseMatter.findOne({
      _id: objectId(caseId, "caseId"),
      firmId,
    })
      .session(session)
      .populate("clientId", "name pan gstin email phone")
      .populate("ownerUserId reviewerUserId escalationOwnerUserId", "name email role")
      .lean();
    if (!caseMatter) throw httpError(404, "Case not found", "CASE_NOT_FOUND");
    const historyFilter = {
      firmId,
      caseId: caseMatter._id,
    };
    // MongoDB does not support parallel operations on one transaction session.
    // Sequential reads all observe the same transaction snapshot.
    const timeline = await loadCompleteCaseHistory(
      CaseTimelineEvent,
      historyFilter,
      { occurredAt: -1, _id: -1 },
      "timeline",
      session
    );
    const analyses = await loadCompleteCaseHistory(
      CaseAnalysis,
      historyFilter,
      { version: -1, _id: -1 },
      "analysis",
      session
    );
    const drafts = await loadCompleteCaseHistory(
      CaseDraft,
      historyFilter,
      { version: -1, _id: -1 },
      "draft",
      session
    );
    const submissions = await loadCompleteCaseHistory(
      CaseSubmission,
      historyFilter,
      { version: -1, _id: -1 },
      "submission",
      session
    );
    const payload = {
      schemaVersion: "case-export-v4",
      exportedAt: new Date().toISOString(),
      binaryFilesIncluded: false,
      automaticSubmissionPerformed: false,
      exportCompleteness: {
        complete: true,
        consistency: "mongodb_transaction_snapshot",
        snapshotBoundary: "transaction_snapshot",
        exactSnapshotTimeAvailable: false,
        maximumRecordsPerCollection: CASE_EXPORT_MAX_RECORDS_PER_COLLECTION,
        maximumSerializedBytes: CASE_EXPORT_MAX_BYTES,
        serializedBytes: 0,
      },
      case: caseMatter,
      timeline,
      analyses,
      drafts,
      submissions,
      truncation: {
        timeline: false,
        analyses: false,
        drafts: false,
        submissions: false,
      },
    };
    const buffer = serializeCaseExport(payload);
    await session.commitTransaction();
    return buffer;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (error?.statusCode) throw error;
    throw httpError(
      503,
      "A coherent MongoDB snapshot is unavailable; Case export was not produced",
      "CASE_EXPORT_SNAPSHOT_UNAVAILABLE"
    );
  } finally {
    await session.endSession();
  }
}

export {
  addCaseTimelineEntry,
  addVerifiedReference,
  buildCaseExport,
  confirmCaseFields,
  createCaseMatter,
  getCaseDetail,
  listCaseMatters,
  requireFirmClient,
  runCaseExtraction,
  updateCaseMatter,
  validateFirmUsers,
};
