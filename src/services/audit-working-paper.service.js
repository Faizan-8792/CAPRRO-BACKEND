import mongoose from "mongoose";
import ActivityEvent from "../models/ActivityEvent.js";
import AppConfig from "../models/AppConfig.js";
import AuditWorkingPaper from "../models/AuditWorkingPaper.js";
import AuditWorkingPaperAnalysis, {
  OUTBOUND_DATA_CLASSES,
  PROVIDER_ADMISSION_VERSION,
} from "../models/AuditWorkingPaperAnalysis.js";
import AuditWorkingPaperRow from "../models/AuditWorkingPaperRow.js";
import Engagement from "../models/Engagement.js";
import EngagementFinding from "../models/EngagementFinding.js";
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
  stableJson,
} from "./case-validation.service.js";
import {
  callDeepSeek,
  parseJsonObject,
} from "./deepseek-provider.service.js";

const WORKING_PAPER_FLAGS = Object.freeze([
  "assuranceEngagements",
  "auditWorkingPapers",
]);
const ANALYSIS_PROMPT_VERSION = "audit-working-paper-findings-v1";
const FINDING_RISKS = new Set(["UNASSESSED", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const PROPOSAL_DECISIONS = new Set(["ACCEPTED", "REJECTED", "EDITED"]);
const MAX_ROWS_PER_ANALYSIS = 50;
const MAX_LIST_LIMIT = 100;
const MAX_ROW_PAGE_LIMIT = 200;
const MAX_ANALYSIS_PAGE_LIMIT = 50;
const MAX_EXPORT_RECORDS = 10000;
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

const PAPER_CREATE_FIELDS = new Set([
  "mutationKey",
  "engagementId",
  "title",
  "purpose",
  "period",
  "priorWorkingPaperId",
]);
const ROW_CREATE_FIELDS = new Set([
  "mutationKey",
  "expectedRevision",
  "rowKey",
  "description",
  "observedValue",
  "currentAmountMinor",
  "sourceReference",
  "assertionTags",
  "note",
]);
const ANALYSIS_CREATE_FIELDS = new Set([
  "mutationKey",
  "expectedRevision",
  "rowIds",
  "consentToExternalProcessing",
]);
const DISPOSITION_FIELDS = new Set([
  "mutationKey",
  "expectedPaperRevision",
  "expectedAnalysisRevision",
  "decision",
  "note",
  "editedFinding",
]);
const EDITED_FINDING_FIELDS = new Set([
  "title",
  "description",
  "category",
  "risk",
]);

function assertPlainObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, `${label} must be an object`, "INVALID_AUDIT_WORKING_PAPER_INPUT");
  }
  return value;
}

function assertAllowedFields(input, allowed, label) {
  assertPlainObject(input, label);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw httpError(
      400,
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
      "UNSUPPORTED_AUDIT_WORKING_PAPER_FIELD"
    );
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw httpError(
      400,
      `${label} must be a positive integer`,
      "INVALID_AUDIT_WORKING_PAPER_REVISION"
    );
  }
  return number;
}

function pageOptions(query, prefix, defaultLimit, maximum) {
  const page = Number(query?.[`${prefix}Page`] || 1);
  const limit = Number(query?.[`${prefix}Limit`] || defaultLimit);
  if (!Number.isInteger(page) || page < 1) {
    throw httpError(400, `${prefix}Page must be a positive integer`, "INVALID_PAGINATION");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw httpError(
      400,
      `${prefix}Limit must be between 1 and ${maximum}`,
      "INVALID_PAGINATION"
    );
  }
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!allowed.has(normalized)) throw httpError(400, `Unsupported ${label}`);
  return normalized;
}

function normalizeRowKey(value) {
  return boundedText(value, 120, { required: true, label: "rowKey" }).toUpperCase();
}

function parseSignedMinor(value, label = "currentAmountMinor") {
  if (value == null || value === "") return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw httpError(400, `${label} must be a safe integer in minor units`);
  }
  return amount;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function operationMutation(input, action) {
  return {
    key: mutationKey(input?.mutationKey),
    requestHash: mutationRequestHash(action, input),
    action,
  };
}

function analysisReceipt(analysis, mutation) {
  const receipt = analysis.mutationReceipts?.find((item) => item.key === mutation.key);
  if (!receipt) return null;
  assertMutationRequestHash(receipt.requestHash, mutation.requestHash);
  return receipt;
}

function appendAnalysisReceipt(analysis, mutation, resultId = "") {
  if ((analysis.mutationReceipts?.length || 0) >= 500) {
    throw httpError(
      409,
      "Analysis mutation receipt capacity reached",
      "AUDIT_ANALYSIS_MUTATION_RECEIPT_LIMIT"
    );
  }
  analysis.mutationReceipts.push({
    key: mutation.key,
    action: mutation.action,
    requestHash: mutation.requestHash,
    resultId: String(resultId || ""),
    appliedRevision: analysis.revision + 1,
    appliedAt: new Date(),
  });
}

function workingPaperPublicationFromRequest(req) {
  return {
    states: Object.fromEntries(
      WORKING_PAPER_FLAGS.map((flagName) => [
        flagName,
        {
          version: req.featureFlagVersions?.[flagName],
          publicationFence:
            req.featureFlagPublicationFences?.[flagName] ?? null,
        },
      ])
    ),
    writeStarted: false,
  };
}

async function assertWorkingPaperPublicationCurrent(publication) {
  for (const flagName of WORKING_PAPER_FLAGS) {
    const state = publication?.states?.[flagName];
    if (!Number.isSafeInteger(state?.version)) {
      throw httpError(
        500,
        `Working-paper publication context is unavailable for ${flagName}`,
        "AUDIT_WORKING_PAPER_PUBLICATION_CONTEXT_REQUIRED"
      );
    }
    await AppConfig.assertFeatureFlagVersion(
      flagName,
      state.version,
      state.publicationFence ?? null
    );
  }
}

async function beginWorkingPaperWrite(publication) {
  if (publication?.writeStarted === true) return;
  await assertWorkingPaperPublicationCurrent(publication);
  publication.writeStarted = true;
}

async function withWorkingPaperTransaction(work) {
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

async function findEngagement(engagementId, firmId, session = null) {
  let query = Engagement.findOne({
    _id: objectId(engagementId, "engagementId"),
    firmId,
  });
  if (session) query = query.session(session);
  const engagement = await query;
  if (!engagement) {
    throw httpError(404, "Engagement not found", "ENGAGEMENT_NOT_FOUND");
  }
  return engagement;
}

async function findWorkingPaper(workingPaperId, firmId, session = null) {
  let query = AuditWorkingPaper.findOne({
    _id: objectId(workingPaperId, "workingPaperId"),
    firmId,
  });
  if (session) query = query.session(session);
  const paper = await query;
  if (!paper) {
    throw httpError(
      404,
      "Audit working paper not found",
      "AUDIT_WORKING_PAPER_NOT_FOUND"
    );
  }
  return paper;
}

function assertEngagementWritable(engagement) {
  if (["COMPLETE", "ARCHIVED"].includes(engagement.status)) {
    throw httpError(
      409,
      "Audit working papers on complete or archived engagements are read-only",
      "AUDIT_WORKING_PAPER_READ_ONLY"
    );
  }
  if (engagement.templateReview?.status !== "ATTESTED") {
    throw httpError(
      409,
      "Audit working-paper work requires current assigned-reviewer template attestation",
      "ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED"
    );
  }
}

function assertPaperRevision(paper, expectedRevision) {
  if (paper.revision !== expectedRevision) {
    throw httpError(
      409,
      "Audit working paper changed since it was loaded; reload and retry",
      "AUDIT_WORKING_PAPER_REVISION_CONFLICT"
    );
  }
}

function assertAnalysisRevision(analysis, expectedRevision) {
  if (analysis.revision !== expectedRevision) {
    throw httpError(
      409,
      "AI analysis changed since it was loaded; reload and retry",
      "AUDIT_ANALYSIS_REVISION_CONFLICT"
    );
  }
}

async function savePaperContentChange(paper, actorUserId, session) {
  paper.contentRevision += 1;
  paper.revision += 1;
  paper.updatedBy = actorUserId;
  try {
    await paper.save({ session });
  } catch (error) {
    if (error?.name === "VersionError") {
      throw httpError(
        409,
        "Audit working paper changed in another request; reload and retry",
        "AUDIT_WORKING_PAPER_REVISION_CONFLICT"
      );
    }
    throw error;
  }
  return paper;
}

async function touchEngagementContent({ engagement, actorUserId, session }) {
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
      "Engagement changed, completed, or lost template attestation during working-paper work",
      "ENGAGEMENT_REVISION_CONFLICT"
    );
  }
  return updated;
}

async function ensureWorkingPaperActivity({
  firmId,
  actorUserId,
  action,
  entityType,
  entityId,
  mutation,
  publication,
  requestId = "",
  afterSummary = null,
  metadata = {},
  source = "USER",
  session,
}) {
  const eventKey = `${entityType}:${entityId}:${action}:${mutation.key}`;
  const identity = new mongoose.Types.ObjectId(hashText(eventKey).slice(0, 24));
  let existingQuery = ActivityEvent.findById(identity).select("_id metadata.eventKey");
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery.lean();
  if (existing) {
    if (existing.metadata?.eventKey !== eventKey) {
      throw httpError(
        409,
        "Working-paper activity identity collision",
        "AUDIT_WORKING_PAPER_ACTIVITY_CONFLICT"
      );
    }
    return existing;
  }

  await beginWorkingPaperWrite(publication);
  return recordActivity({
    eventId: identity,
    firmId,
    actorUserId,
    source,
    action,
    entityType,
    entityId,
    afterSummary,
    requestId,
    metadata: {
      ...metadata,
      eventKey,
      mutationKey: mutation.key,
      privacyReviewPassed: false,
      professionalConclusionGenerated: false,
    },
    session,
  });
}

function workingPaperRowPayload(input) {
  const payload = {
    rowKey: normalizeRowKey(input.rowKey),
    description: boundedText(input.description, 2000, {
      required: true,
      label: "description",
    }),
    observedValue: boundedText(input.observedValue, 4000, {
      label: "observedValue",
    }),
    currentAmountMinor: parseSignedMinor(input.currentAmountMinor),
    sourceReference: boundedText(input.sourceReference, 2000, {
      required: true,
      label: "sourceReference",
    }),
    assertionTags: boundedStringArray(input.assertionTags, "assertionTags", {
      maxItems: 20,
      maxLength: 80,
    }).map((value) => value.toUpperCase()),
    note: boundedText(input.note, 5000, { label: "note" }),
  };
  return { ...payload, contentHash: hashText(stableJson(payload)) };
}

function allowedFindingCategories(engagement) {
  return new Set(
    [...(engagement.templateSnapshot?.findingCategories || []), "OTHER"].map((value) =>
      String(value).trim().toUpperCase()
    )
  );
}

function validateFindingCategory(engagement, value) {
  const category = boundedText(value, 120, {
    required: true,
    label: "category",
  }).toUpperCase();
  if (!allowedFindingCategories(engagement).has(category)) {
    throw httpError(
      400,
      "Finding category is not defined by this engagement template snapshot"
    );
  }
  return category;
}

function comparisonForRows(rows, priorRowsByKey) {
  return rows.map((row) => {
    const prior = priorRowsByKey.get(row.rowKey) || null;
    const currentAmount = Number.isSafeInteger(row.currentAmountMinor)
      ? row.currentAmountMinor
      : null;
    const priorAmount = Number.isSafeInteger(prior?.currentAmountMinor)
      ? prior.currentAmountMinor
      : null;
    let varianceMinor = null;
    let varianceBasisPoints = null;
    if (currentAmount != null && priorAmount != null) {
      const variance = BigInt(currentAmount) - BigInt(priorAmount);
      if (
        variance <= BigInt(Number.MAX_SAFE_INTEGER) &&
        variance >= BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        varianceMinor = Number(variance);
      }
      if (priorAmount !== 0) {
        const basisPoints = (variance * 10000n) / BigInt(Math.abs(priorAmount));
        if (
          basisPoints <= BigInt(Number.MAX_SAFE_INTEGER) &&
          basisPoints >= BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          varianceBasisPoints = Number(basisPoints);
        }
      }
    }
    return {
      rowId: String(row._id),
      rowKey: row.rowKey,
      priorRowId: prior ? String(prior._id) : null,
      priorAmountMinor: priorAmount,
      varianceMinor,
      varianceBasisPoints,
      comparisonAvailable: prior != null,
    };
  });
}

async function createAuditWorkingPaper({
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, PAPER_CREATE_FIELDS, "Audit working-paper creation");
  const mutation = operationMutation(input, "audit-working-paper-create");
  const engagementId = objectId(input.engagementId, "engagementId");
  const recordCreationActivity = (paper, session) =>
    ensureWorkingPaperActivity({
      firmId,
      actorUserId,
      action: "AUDIT_WORKING_PAPER_CREATED",
      entityType: "AuditWorkingPaper",
      entityId: paper._id,
      mutation,
      publication,
      requestId,
      afterSummary: {
        engagementId: String(paper.engagementId),
        priorWorkingPaperId: paper.priorWorkingPaperId
          ? String(paper.priorWorkingPaperId)
          : null,
        revision: paper.revision,
      },
      metadata: { engagementId: String(paper.engagementId) },
      session,
    });

  let paper;
  try {
    paper = await withWorkingPaperTransaction(async (session) => {
      const existing = await AuditWorkingPaper.findOne({
        firmId,
        engagementId,
        creationMutationKey: mutation.key,
      }).session(session);
      if (existing) {
        assertMutationRequestHash(existing.creationRequestHash, mutation.requestHash);
        await recordCreationActivity(existing, session);
        return existing;
      }

      const engagement = await findEngagement(engagementId, firmId, session);
      assertEngagementWritable(engagement);
      const period = boundedText(input.period ?? engagement.period, 120, {
        label: "period",
      });
      let priorWorkingPaperId = null;
      if (input.priorWorkingPaperId) {
        priorWorkingPaperId = objectId(
          input.priorWorkingPaperId,
          "priorWorkingPaperId"
        );
        const prior = await AuditWorkingPaper.findOne({
          _id: priorWorkingPaperId,
          firmId,
        }).session(session);
        if (!prior || String(prior.clientId) !== String(engagement.clientId)) {
          throw httpError(
            400,
            "Prior-period working paper must belong to the same active-firm client",
            "INVALID_PRIOR_WORKING_PAPER"
          );
        }
        if (String(prior.engagementId) === String(engagement._id)) {
          throw httpError(
            400,
            "Prior-period working paper must belong to a different engagement",
            "INVALID_PRIOR_WORKING_PAPER"
          );
        }
        const priorEngagement = await findEngagement(
          prior.engagementId,
          firmId,
          session
        );
        const priorEnd = priorEngagement.completedAt || priorEngagement.targetDate;
        const currentStart = engagement.startDate;
        const compatible =
          String(priorEngagement.clientId) === String(engagement.clientId) &&
          priorEngagement.engagementType === engagement.engagementType &&
          priorEngagement.templateHash === engagement.templateHash &&
          ["COMPLETE", "ARCHIVED"].includes(priorEngagement.status) &&
          priorEnd instanceof Date &&
          currentStart instanceof Date &&
          priorEnd.getTime() < currentStart.getTime() &&
          Boolean(prior.period) &&
          Boolean(period) &&
          prior.period !== period;
        if (!compatible) {
          throw httpError(
            400,
            "Prior-period comparison requires a completed earlier engagement for the same client, engagement type, template, and a different period; the current engagement must have a later start date",
            "INCOMPATIBLE_PRIOR_WORKING_PAPER"
          );
        }
      }

      await beginWorkingPaperWrite(publication);
      const [created] = await AuditWorkingPaper.create(
        [
          {
            firmId,
            engagementId: engagement._id,
            clientId: engagement.clientId,
            title: boundedText(input.title, 500, {
              required: true,
              label: "title",
            }),
            purpose: boundedText(input.purpose, 5000, {
              required: true,
              label: "purpose",
            }),
            period,
            priorWorkingPaperId,
            creationMutationKey: mutation.key,
            creationRequestHash: mutation.requestHash,
            createdBy: actorUserId,
            updatedBy: actorUserId,
          },
        ],
        { session }
      );
      await touchEngagementContent({ engagement, actorUserId, session });
      await recordCreationActivity(created, session);
      return created;
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    paper = await AuditWorkingPaper.findOne({
      firmId,
      engagementId,
      creationMutationKey: mutation.key,
    });
    if (!paper) throw error;
    assertMutationRequestHash(paper.creationRequestHash, mutation.requestHash);
  }

  return paper;
}

async function listAuditWorkingPapers({ firmId, query }) {
  const engagementId = objectId(query?.engagementId, "engagementId");
  const { page, limit, skip } = pageOptions(query, "paper", 25, MAX_LIST_LIMIT);
  const filter = { firmId, engagementId };
  const [papers, total] = await Promise.all([
    AuditWorkingPaper.find(filter)
      .select("-creationRequestHash")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("clientId", "name pan gstin")
      .populate("priorWorkingPaperId", "title period")
      .lean(),
    AuditWorkingPaper.countDocuments(filter),
  ]);
  return {
    papers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    safetyBoundary: {
      professionalConclusionGenerated: false,
      privacyReviewPassed: false,
      automaticFindingCreation: false,
    },
  };
}

async function getAuditWorkingPaperDetail({ workingPaperId, firmId, query = {} }) {
  const rowPage = pageOptions(query, "row", 100, MAX_ROW_PAGE_LIMIT);
  const analysisPage = pageOptions(
    query,
    "analysis",
    25,
    MAX_ANALYSIS_PAGE_LIMIT
  );
  const paper = await AuditWorkingPaper.findOne({
    _id: objectId(workingPaperId, "workingPaperId"),
    firmId,
  })
    .select("-creationRequestHash")
    .populate("engagementId", "title period status engagementType templateReview reviewerUserId")
    .populate("clientId", "name pan gstin")
    .populate("priorWorkingPaperId", "title period engagementId")
    .lean();
  if (!paper) {
    throw httpError(
      404,
      "Audit working paper not found",
      "AUDIT_WORKING_PAPER_NOT_FOUND"
    );
  }
  const rowFilter = { firmId, workingPaperId: paper._id };
  const analysisFilter = { firmId, workingPaperId: paper._id };
  const [rows, rowTotal, analyses, analysisTotal] = await Promise.all([
    AuditWorkingPaperRow.find(rowFilter)
      .select("-creationRequestHash")
      .sort({ createdAt: 1, _id: 1 })
      .skip(rowPage.skip)
      .limit(rowPage.limit)
      .lean(),
    AuditWorkingPaperRow.countDocuments(rowFilter),
    AuditWorkingPaperAnalysis.find(analysisFilter)
      .select("-creationRequestHash -mutationReceipts")
      .sort({ createdAt: -1, _id: -1 })
      .skip(analysisPage.skip)
      .limit(analysisPage.limit)
      .lean(),
    AuditWorkingPaperAnalysis.countDocuments(analysisFilter),
  ]);

  const priorRows = paper.priorWorkingPaperId && rows.length
    ? await AuditWorkingPaperRow.find({
        firmId,
        workingPaperId: paper.priorWorkingPaperId._id,
        rowKey: { $in: rows.map((row) => row.rowKey) },
      })
        .select("_id rowKey currentAmountMinor contentHash")
        .lean()
    : [];
  const priorRowsByKey = new Map(priorRows.map((row) => [row.rowKey, row]));

  return {
    paper,
    rows,
    analyses,
    comparison: {
      priorWorkingPaper: paper.priorWorkingPaperId || null,
      rows: comparisonForRows(rows, priorRowsByKey),
    },
    rowPagination: {
      page: rowPage.page,
      limit: rowPage.limit,
      total: rowTotal,
      totalPages: Math.max(1, Math.ceil(rowTotal / rowPage.limit)),
    },
    analysisPagination: {
      page: analysisPage.page,
      limit: analysisPage.limit,
      total: analysisTotal,
      totalPages: Math.max(1, Math.ceil(analysisTotal / analysisPage.limit)),
    },
    safetyBoundary: {
      professionalConclusionGenerated: false,
      privacyReviewPassed: false,
      aiProposalRequiresHumanDisposition: true,
      sourceRowsAreAppendOnly: true,
    },
  };
}

async function createAuditWorkingPaperRow({
  workingPaperId,
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, ROW_CREATE_FIELDS, "Audit source-row creation");
  const mutation = operationMutation(input, "audit-working-paper-row-create");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const rowPayload = workingPaperRowPayload(input);
  const paperId = objectId(workingPaperId, "workingPaperId");
  const recordRowActivity = (row, paper, session) =>
    ensureWorkingPaperActivity({
      firmId,
      actorUserId,
      action: "AUDIT_WORKING_PAPER_ROW_ADDED",
      entityType: "AuditWorkingPaperRow",
      entityId: row._id,
      mutation,
      publication,
      requestId,
      afterSummary: {
        rowKey: row.rowKey,
        contentHash: row.contentHash,
        paperRevision: paper.revision,
      },
      metadata: {
        workingPaperId: String(paper._id),
        engagementId: String(paper.engagementId),
      },
      session,
    });

  let result;
  try {
    result = await withWorkingPaperTransaction(async (session) => {
      const paper = await findWorkingPaper(paperId, firmId, session);
      const existing = await AuditWorkingPaperRow.findOne({
        firmId,
        workingPaperId: paper._id,
        creationMutationKey: mutation.key,
      }).session(session);
      if (existing) {
        assertMutationRequestHash(existing.creationRequestHash, mutation.requestHash);
        await recordRowActivity(existing, paper, session);
        return { row: existing, paper };
      }
      assertPaperRevision(paper, expectedRevision);
      const engagement = await findEngagement(paper.engagementId, firmId, session);
      assertEngagementWritable(engagement);
      const duplicateKey = await AuditWorkingPaperRow.findOne({
        firmId,
        workingPaperId: paper._id,
        rowKey: rowPayload.rowKey,
      })
        .select("_id")
        .session(session)
        .lean();
      if (duplicateKey) {
        throw httpError(
          409,
          "rowKey already exists in this append-only working paper",
          "AUDIT_WORKING_PAPER_ROW_KEY_EXISTS"
        );
      }

      await beginWorkingPaperWrite(publication);
      const [row] = await AuditWorkingPaperRow.create(
        [
          {
            firmId,
            workingPaperId: paper._id,
            engagementId: paper.engagementId,
            clientId: paper.clientId,
            ...rowPayload,
            creationMutationKey: mutation.key,
            creationRequestHash: mutation.requestHash,
            createdBy: actorUserId,
          },
        ],
        { session }
      );
      await savePaperContentChange(paper, actorUserId, session);
      await touchEngagementContent({ engagement, actorUserId, session });
      await recordRowActivity(row, paper, session);
      return { row, paper };
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await AuditWorkingPaperRow.findOne({
      firmId,
      workingPaperId: paperId,
      creationMutationKey: mutation.key,
    });
    if (!winner) {
      throw httpError(
        409,
        "rowKey already exists in this append-only working paper",
        "AUDIT_WORKING_PAPER_ROW_KEY_EXISTS"
      );
    }
    assertMutationRequestHash(winner.creationRequestHash, mutation.requestHash);
    result = {
      row: winner,
      paper: await findWorkingPaper(paperId, firmId),
    };
  }

  return result;
}

function buildAuditAiPrompt({ paper, engagement, rows }) {
  return JSON.stringify(
    {
      instruction:
        "Assess only the supplied immutable source rows. Return either source-row-cited finding proposals or an explicit insufficient-evidence result. Do not provide an audit opinion or professional conclusion.",
      responseSchema: {
        result: "SUPPORTED or INSUFFICIENT_EVIDENCE",
        insufficientEvidenceReason: "required when result is INSUFFICIENT_EVIDENCE",
        findings: [
          {
            title: "text",
            description: "text",
            category: "one allowed category",
            risk: "UNASSESSED, LOW, MEDIUM, HIGH, or CRITICAL",
            citedRowIds: ["one or more supplied rowId values"],
          },
        ],
      },
      allowedFindingCategories: [...allowedFindingCategories(engagement)],
      workingPaper: {
        id: String(paper._id),
        title: paper.title,
        purpose: paper.purpose,
        period: paper.period,
      },
      sourceRows: rows.map((row) => ({
        rowId: String(row._id),
        rowKey: row.rowKey,
        description: row.description,
        observedValue: row.observedValue,
        currentAmountMinor: row.currentAmountMinor,
        sourceReference: row.sourceReference,
        assertionTags: row.assertionTags,
        note: row.note,
        contentHash: row.contentHash,
      })),
    },
    null,
    2
  );
}

function providerText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
}

function providerResultMetadata(providerResult) {
  const content =
    typeof providerResult?.content === "string" ? providerResult.content : "";
  return {
    provider: providerText(providerResult?.provider, 80) || "",
    model: providerText(providerResult?.model, 120) || "",
    providerResultHash: content ? hashText(content) : null,
  };
}

function insufficientEvidenceResult(reason, providerResult) {
  return {
    status: "INSUFFICIENT_EVIDENCE",
    proposals: [],
    insufficientEvidenceReason: reason,
    providerFailureReason: "",
    ...providerResultMetadata(providerResult),
  };
}

function invalidProviderResult(reason, providerResult) {
  return {
    status: "PROVIDER_RESULT_INVALID",
    proposals: [],
    insufficientEvidenceReason: "",
    providerFailureReason: reason,
    ...providerResultMetadata(providerResult),
  };
}

function hasOnlyProviderFields(value, allowed) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((field) => allowed.has(field))
  );
}

function normalizeAuditAiResult(providerResult, rows, categories) {
  if (!providerResult?.ok) {
    return {
      status: "PROVIDER_UNAVAILABLE",
      proposals: [],
      insufficientEvidenceReason: "",
      providerFailureReason: boundedText(
        providerResult?.reason || "AI provider unavailable",
        500,
        { label: "providerFailureReason" }
      ),
      ...providerResultMetadata(providerResult),
    };
  }

  const parsed = parseJsonObject(providerResult.content);
  const topLevelFields = new Set([
    "result",
    "insufficientEvidenceReason",
    "findings",
  ]);
  if (!hasOnlyProviderFields(parsed, topLevelFields)) {
    return invalidProviderResult(
      "AI provider returned malformed JSON or unsupported top-level fields; no proposal was retained.",
      providerResult
    );
  }

  const result = String(parsed.result || "").trim().toUpperCase();
  if (result === "INSUFFICIENT_EVIDENCE") {
    const reason = providerText(parsed.insufficientEvidenceReason, 5000);
    const findingsAreEmpty =
      parsed.findings === undefined ||
      (Array.isArray(parsed.findings) && parsed.findings.length === 0);
    if (!reason || !findingsAreEmpty) {
      return invalidProviderResult(
        "AI provider returned an invalid insufficient-evidence result; no proposal was retained.",
        providerResult
      );
    }
    return insufficientEvidenceResult(reason, providerResult);
  }

  if (result !== "SUPPORTED" || !Array.isArray(parsed.findings)) {
    return invalidProviderResult(
      "AI provider did not return a supported or explicit insufficient-evidence result; no proposal was retained.",
      providerResult
    );
  }
  if (!parsed.findings.length || parsed.findings.length > 10) {
    return invalidProviderResult(
      "AI provider returned an empty or oversized finding set; no proposal was retained.",
      providerResult
    );
  }

  const rowsById = new Map(rows.map((row) => [String(row._id), row]));
  const findingFields = new Set([
    "title",
    "description",
    "category",
    "risk",
    "citedRowIds",
  ]);
  const proposals = [];
  for (const candidate of parsed.findings) {
    if (!hasOnlyProviderFields(candidate, findingFields)) {
      return invalidProviderResult(
        "AI provider returned unsupported finding fields; no proposal was retained.",
        providerResult
      );
    }
    const title = providerText(candidate.title, 500);
    const description = providerText(candidate.description, 10000);
    const category = String(candidate.category || "").trim().toUpperCase();
    const risk = String(candidate.risk || "").trim().toUpperCase();
    const rawCitedIds = Array.isArray(candidate.citedRowIds)
      ? candidate.citedRowIds.map((value) => String(value))
      : [];
    const citedIds = [...new Set(rawCitedIds)];
    const valid =
      title &&
      description &&
      categories.has(category) &&
      FINDING_RISKS.has(risk) &&
      citedIds.length === rawCitedIds.length &&
      citedIds.length > 0 &&
      citedIds.length <= MAX_ROWS_PER_ANALYSIS &&
      citedIds.every((rowId) => rowsById.has(rowId));
    if (!valid) {
      return invalidProviderResult(
        "AI provider returned invalid finding fields or citations outside selected immutable rows; no proposal was retained.",
        providerResult
      );
    }
    proposals.push({
      title,
      description,
      category,
      risk,
      citedRows: citedIds.map((rowId) => ({
        rowId,
        contentHash: rowsById.get(rowId).contentHash,
      })),
    });
  }

  return {
    status: "SUPPORTED",
    proposals,
    insufficientEvidenceReason: "",
    providerFailureReason: "",
    ...providerResultMetadata(providerResult),
  };
}

async function generateAuditWorkingPaperAnalysis({
  workingPaperId,
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, ANALYSIS_CREATE_FIELDS, "Audit AI analysis request");
  if (input.consentToExternalProcessing !== true) {
    throw httpError(
      400,
      "Explicit consent is required before selected source rows are sent to DeepSeek",
      "AUDIT_AI_CONSENT_REQUIRED"
    );
  }
  const mutation = operationMutation(input, "audit-working-paper-analysis-create");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  if (!Array.isArray(input.rowIds)) {
    throw httpError(400, "rowIds must be an array");
  }
  const rowIdStrings = [
    ...new Set(input.rowIds.map((value) => String(objectId(value, "rowId")))),
  ];
  const rowIds = rowIdStrings.map((value) => new mongoose.Types.ObjectId(value));
  if (!rowIds.length || rowIds.length > MAX_ROWS_PER_ANALYSIS) {
    throw httpError(
      400,
      `Select between 1 and ${MAX_ROWS_PER_ANALYSIS} source rows for analysis`
    );
  }
  const paperId = objectId(workingPaperId, "workingPaperId");
  const processingAttemptId = new mongoose.Types.ObjectId().toString();
  const consentAt = new Date();

  const recordReservationActivity = (analysis, paper, session) =>
    ensureWorkingPaperActivity({
      firmId,
      actorUserId,
      action: "AUDIT_WORKING_PAPER_AI_ANALYSIS_RESERVED",
      entityType: "AuditWorkingPaperAnalysis",
      entityId: analysis._id,
      mutation,
      publication,
      requestId,
      source: "AI_ASSISTED",
      afterSummary: {
        status: analysis.status,
        selectedRowCount: analysis.selectedRows.length,
        outboundPayloadHash: analysis.outboundPayloadHash,
        paperRevision: paper.revision,
      },
      metadata: {
        workingPaperId: String(paper._id),
        engagementId: String(paper.engagementId),
        providerAdmissionVersion: analysis.providerAdmissionVersion,
        outboundDataClasses: analysis.outboundDataClasses,
        externalProcessingConsentAt: analysis.externalProcessingConsentAt,
      },
      session,
    });
  const recordCompletionActivity = (analysis, paper, session) =>
    ensureWorkingPaperActivity({
      firmId,
      actorUserId,
      action: "AUDIT_WORKING_PAPER_AI_ANALYSIS_RECORDED",
      entityType: "AuditWorkingPaperAnalysis",
      entityId: analysis._id,
      mutation,
      publication,
      requestId,
      source: "AI_ASSISTED",
      afterSummary: {
        status: analysis.status,
        proposalCount: analysis.proposals.length,
        selectedRowCount: analysis.selectedRows.length,
        paperRevision: paper.revision,
      },
      metadata: {
        workingPaperId: String(paper._id),
        engagementId: String(paper.engagementId),
        sourceRowCitationsRequired: true,
        humanDispositionRequired: true,
      },
      session,
    });

  let reservation;
  try {
    reservation = await withWorkingPaperTransaction(async (session) => {
      const existing = await AuditWorkingPaperAnalysis.findOne({
        firmId,
        workingPaperId: paperId,
        creationMutationKey: mutation.key,
      })
        .select("+processingAttemptId")
        .session(session);
      if (existing) {
        assertMutationRequestHash(existing.creationRequestHash, mutation.requestHash);
        const existingPaper = await findWorkingPaper(paperId, firmId, session);
        if (existing.status === "PROCESSING") {
          await recordReservationActivity(existing, existingPaper, session);
        } else {
          await recordCompletionActivity(existing, existingPaper, session);
        }
        return {
          analysis: existing,
          paper: existingPaper,
          rows: null,
          engagement: null,
          prompt: null,
          created: false,
        };
      }

      const paper = await findWorkingPaper(paperId, firmId, session);
      assertPaperRevision(paper, expectedRevision);
      const engagement = await findEngagement(paper.engagementId, firmId, session);
      assertEngagementWritable(engagement);
      const rows = await AuditWorkingPaperRow.find({
        firmId,
        workingPaperId: paperId,
        _id: { $in: rowIds },
      })
        .sort({ createdAt: 1, _id: 1 })
        .session(session)
        .lean();
      if (rows.length !== rowIds.length) {
        throw httpError(
          400,
          "Every selected row must belong to this active-firm working paper",
          "INVALID_AUDIT_SOURCE_ROW"
        );
      }

      const prompt = buildAuditAiPrompt({ paper, engagement, rows });
      await beginWorkingPaperWrite(publication);
      const [analysis] = await AuditWorkingPaperAnalysis.create(
        [
          {
            firmId,
            workingPaperId: paper._id,
            engagementId: paper.engagementId,
            clientId: paper.clientId,
            status: "PROCESSING",
            selectedRows: rows.map((row) => ({
              rowId: row._id,
              contentHash: row.contentHash,
            })),
            proposals: [],
            insufficientEvidenceReason: "",
            providerFailureReason: "",
            provider: "",
            model: "",
            promptVersion: ANALYSIS_PROMPT_VERSION,
            providerResultHash: null,
            providerAdmissionVersion: PROVIDER_ADMISSION_VERSION,
            processingAttemptId,
            processingStartedAt: consentAt,
            providerCompletedAt: null,
            outboundDataClasses: [...OUTBOUND_DATA_CLASSES],
            outboundPayloadHash: hashText(prompt),
            externalProcessingConsentAt: consentAt,
            externalProcessingConsentBy: actorUserId,
            creationMutationKey: mutation.key,
            creationRequestHash: mutation.requestHash,
            createdBy: actorUserId,
            updatedBy: actorUserId,
          },
        ],
        { session }
      );
      await savePaperContentChange(paper, actorUserId, session);
      await touchEngagementContent({ engagement, actorUserId, session });
      await recordReservationActivity(analysis, paper, session);
      return { analysis, paper, rows, engagement, prompt, created: true };
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await AuditWorkingPaperAnalysis.findOne({
      firmId,
      workingPaperId: paperId,
      creationMutationKey: mutation.key,
    });
    if (!winner) throw error;
    assertMutationRequestHash(winner.creationRequestHash, mutation.requestHash);
    return {
      analysis: winner,
      paper: await findWorkingPaper(paperId, firmId),
      providerCallState:
        winner.status === "PROCESSING" ? "PROCESSING_UNKNOWN" : "COMPLETED",
    };
  }

  if (!reservation.created) {
    return {
      analysis: reservation.analysis,
      paper: reservation.paper,
      providerCallState:
        reservation.analysis.status === "PROCESSING"
          ? "PROCESSING_UNKNOWN"
          : "COMPLETED",
    };
  }

  let providerResult;
  try {
    providerResult = await callDeepSeek({
      system:
        "You are an audit working-paper assistant. Use only supplied rows. Return strict JSON. Every supported proposal must cite one or more supplied rowId values. If support is inadequate, return INSUFFICIENT_EVIDENCE with a reason. Never issue an audit opinion, legal conclusion, filing decision, or professional conclusion.",
      prompt: reservation.prompt,
      jsonResponse: true,
      maxTokens: 1800,
      timeoutMs: 25000,
      temperature: 0.1,
      userId: actorUserId,
    });
  } catch {
    providerResult = {
      ok: false,
      reason: "AI provider request failed before a usable result was returned",
    };
  }
  const normalized = normalizeAuditAiResult(
    providerResult,
    reservation.rows,
    allowedFindingCategories(reservation.engagement)
  );

  const result = await withWorkingPaperTransaction(async (session) => {
    const analysis = await AuditWorkingPaperAnalysis.findOne({
      _id: reservation.analysis._id,
      firmId,
      workingPaperId: paperId,
      creationMutationKey: mutation.key,
    })
      .select("+processingAttemptId")
      .session(session);
    if (!analysis) {
      throw httpError(409, "Durable AI analysis reservation is unavailable", "AUDIT_AI_RESERVATION_LOST");
    }
    assertMutationRequestHash(analysis.creationRequestHash, mutation.requestHash);
    const paper = await findWorkingPaper(paperId, firmId, session);
    if (analysis.status !== "PROCESSING") {
      await recordCompletionActivity(analysis, paper, session);
      return { analysis, paper };
    }
    if (analysis.processingAttemptId !== processingAttemptId) {
      return { analysis, paper };
    }

    const selectedHashes = new Map(
      analysis.selectedRows.map((row) => [String(row.rowId), row.contentHash])
    );
    const currentRows = await AuditWorkingPaperRow.find({
      firmId,
      workingPaperId: paperId,
      _id: { $in: [...selectedHashes.keys()] },
    })
      .session(session)
      .lean();
    if (
      currentRows.length !== selectedHashes.size ||
      currentRows.some(
        (row) => selectedHashes.get(String(row._id)) !== row.contentHash
      )
    ) {
      throw httpError(
        409,
        "Selected source rows changed before provider result finalization",
        "AUDIT_SOURCE_ROW_CHANGED"
      );
    }

    const engagement = await findEngagement(paper.engagementId, firmId, session);
    assertEngagementWritable(engagement);
    await beginWorkingPaperWrite(publication);
    analysis.status = normalized.status;
    analysis.proposals = normalized.proposals;
    analysis.insufficientEvidenceReason = normalized.insufficientEvidenceReason;
    analysis.providerFailureReason = normalized.providerFailureReason;
    analysis.provider = normalized.provider;
    analysis.model = normalized.model;
    analysis.providerResultHash = normalized.providerResultHash;
    analysis.providerCompletedAt = new Date();
    analysis.revision += 1;
    analysis.updatedBy = actorUserId;
    try {
      await analysis.save({ session });
    } catch (error) {
      if (error?.name === "VersionError") {
        throw httpError(
          409,
          "AI analysis changed in another request; reload without resending source rows",
          "AUDIT_ANALYSIS_REVISION_CONFLICT"
        );
      }
      throw error;
    }
    await savePaperContentChange(paper, actorUserId, session);
    await touchEngagementContent({ engagement, actorUserId, session });
    await recordCompletionActivity(analysis, paper, session);
    return { analysis, paper };
  });

  return { ...result, providerCallState: "COMPLETED" };
}

function auditFindingContentSnapshot(finding, evidenceReferences) {
  return {
    title: finding.title,
    description: finding.description,
    category: finding.category,
    risk: finding.risk,
    evidenceReferences: [...evidenceReferences],
  };
}

function auditFindingContentHash(snapshot) {
  return hashText(stableJson(snapshot));
}

function finalFindingFromDisposition(engagement, proposal, decision, editedFinding) {
  if (decision === "ACCEPTED") {
    if (editedFinding != null) {
      throw httpError(400, "editedFinding is allowed only for an EDITED decision");
    }
    return {
      title: proposal.title,
      description: proposal.description,
      category: validateFindingCategory(engagement, proposal.category),
      risk: normalizeEnum(proposal.risk, FINDING_RISKS, "finding risk"),
    };
  }
  if (decision !== "EDITED") return null;
  assertAllowedFields(editedFinding, EDITED_FINDING_FIELDS, "editedFinding");
  return {
    title: boundedText(editedFinding.title, 500, {
      required: true,
      label: "editedFinding.title",
    }),
    description: boundedText(editedFinding.description, 10000, {
      required: true,
      label: "editedFinding.description",
    }),
    category: validateFindingCategory(engagement, editedFinding.category),
    risk: normalizeEnum(editedFinding.risk, FINDING_RISKS, "finding risk"),
  };
}

async function dispositionAuditFindingProposal({
  workingPaperId,
  analysisId,
  proposalId,
  firmId,
  actorUserId,
  input,
  requestId,
  publication,
}) {
  assertAllowedFields(input, DISPOSITION_FIELDS, "AI proposal disposition");
  const mutation = operationMutation(input, "audit-ai-proposal-disposition");
  const expectedPaperRevision = positiveInteger(
    input.expectedPaperRevision,
    "expectedPaperRevision"
  );
  const expectedAnalysisRevision = positiveInteger(
    input.expectedAnalysisRevision,
    "expectedAnalysisRevision"
  );
  const decision = normalizeEnum(input.decision, PROPOSAL_DECISIONS, "proposal decision");
  const note = boundedText(input.note, 5000, { label: "note" });
  if (["REJECTED", "EDITED"].includes(decision) && !note) {
    throw httpError(400, `${decision} decisions require a note`);
  }
  if (decision !== "EDITED" && input.editedFinding != null) {
    throw httpError(400, "editedFinding is allowed only for an EDITED decision");
  }
  const paperId = objectId(workingPaperId, "workingPaperId");
  const checkedAnalysisId = objectId(analysisId, "analysisId");
  const checkedProposalId = objectId(proposalId, "proposalId");
  const recordDispositionActivity = (analysis, paper, finding, session) =>
    ensureWorkingPaperActivity({
      firmId,
      actorUserId,
      action: "AUDIT_AI_PROPOSAL_DISPOSITION_RECORDED",
      entityType: "AuditWorkingPaperAnalysis",
      entityId: analysis._id,
      mutation,
      publication,
      requestId,
      afterSummary: {
        proposalId: String(checkedProposalId),
        decision,
        linkedFindingId: finding?._id ? String(finding._id) : null,
        paperRevision: paper.revision,
        analysisRevision: analysis.revision,
      },
      metadata: {
        workingPaperId: String(paper._id),
        engagementId: String(paper.engagementId),
        proposalId: String(checkedProposalId),
        sourceRowCitationCount:
          analysis.proposals.id(checkedProposalId)?.citedRows?.length || 0,
      },
      session,
    });

  return withWorkingPaperTransaction(async (session) => {
    const paper = await findWorkingPaper(paperId, firmId, session);
    const analysis = await AuditWorkingPaperAnalysis.findOne({
      _id: checkedAnalysisId,
      firmId,
      workingPaperId: paper._id,
    }).session(session);
    if (!analysis) {
      throw httpError(404, "AI analysis not found", "AUDIT_ANALYSIS_NOT_FOUND");
    }
    const receipt = analysisReceipt(analysis, mutation);
    if (receipt) {
      const finding = receipt.resultId
        ? await EngagementFinding.findOne({
            _id: receipt.resultId,
            firmId,
            engagementId: paper.engagementId,
          }).session(session)
        : null;
      await recordDispositionActivity(analysis, paper, finding, session);
      return { analysis, paper, finding };
    }

    assertPaperRevision(paper, expectedPaperRevision);
    assertAnalysisRevision(analysis, expectedAnalysisRevision);
    if (analysis.status !== "SUPPORTED") {
      throw httpError(
        409,
        "Only a supported source-row-cited analysis can receive proposal dispositions",
        "AUDIT_ANALYSIS_HAS_NO_PROPOSALS"
      );
    }
    const proposal = analysis.proposals.id(checkedProposalId);
    if (!proposal) {
      throw httpError(404, "AI finding proposal not found", "AUDIT_PROPOSAL_NOT_FOUND");
    }
    if (proposal.disposition?.decision !== "PENDING") {
      throw httpError(
        409,
        "AI finding proposal already has a persisted user decision",
        "AUDIT_PROPOSAL_ALREADY_DECIDED"
      );
    }

    const engagement = await findEngagement(paper.engagementId, firmId, session);
    assertEngagementWritable(engagement);
    const citedIds = proposal.citedRows.map((citation) => citation.rowId);
    const citedRows = await AuditWorkingPaperRow.find({
      _id: { $in: citedIds },
      firmId,
      workingPaperId: paper._id,
    })
      .session(session)
      .lean();
    const citedById = new Map(citedRows.map((row) => [String(row._id), row]));
    if (
      citedRows.length !== citedIds.length ||
      proposal.citedRows.some(
        (citation) =>
          citedById.get(String(citation.rowId))?.contentHash !== citation.contentHash
      )
    ) {
      throw httpError(
        409,
        "Proposal source-row citations no longer match immutable stored rows",
        "AUDIT_SOURCE_ROW_CHANGED"
      );
    }

    const findingInput = finalFindingFromDisposition(
      engagement,
      proposal,
      decision,
      input.editedFinding
    );
    const decidedAt = new Date();
    await beginWorkingPaperWrite(publication);
    let finding = null;
    if (findingInput) {
      const findingMutationKey = `audit-ai:${analysis._id}:${proposal._id}`;
      const sourceRows = proposal.citedRows.map((citation) => ({
        rowId: citation.rowId,
        contentHash: citation.contentHash,
      }));
      const evidenceReferences = sourceRows.map(
        (citation) =>
          `audit-working-paper:${paper._id}:row:${citation.rowId}:sha256:${citation.contentHash}`
      );
      const decisionSnapshot = auditFindingContentSnapshot(
        findingInput,
        evidenceReferences
      );
      const decisionContentHash = auditFindingContentHash(decisionSnapshot);
      const findingRequestHash = hashText(
        stableJson({ decisionSnapshot, sourceRows, decision })
      );
      finding = await EngagementFinding.findOne({
        firmId,
        engagementId: engagement._id,
        creationMutationKey: findingMutationKey,
      }).session(session);
      if (finding) {
        assertMutationRequestHash(finding.creationRequestHash, findingRequestHash);
      } else {
        [finding] = await EngagementFinding.create(
          [
            {
              firmId,
              engagementId: engagement._id,
              clientId: engagement.clientId,
              ...findingInput,
              status: "OPEN",
              evidenceReferences,
              aiProvenance: {
                source: "AUDIT_WORKING_PAPER",
                workingPaperId: paper._id,
                analysisId: analysis._id,
                proposalId: String(proposal._id),
                sourceRows,
                humanDecision: decision,
                decidedBy: actorUserId,
                decidedAt,
                provenanceVersion: "audit-ai-decision-v1",
                decisionSnapshot,
                decisionContentHash,
                currentContentHash: decisionContentHash,
                humanEditLineage: [],
              },
              creationMutationKey: findingMutationKey,
              creationRequestHash: findingRequestHash,
              createdBy: actorUserId,
              updatedBy: actorUserId,
            },
          ],
          { session }
        );
      }
    }

    proposal.disposition.decision = decision;
    proposal.disposition.note = note;
    proposal.disposition.decidedBy = actorUserId;
    proposal.disposition.decidedAt = decidedAt;
    proposal.disposition.linkedFindingId = finding?._id || null;
    appendAnalysisReceipt(analysis, mutation, finding?._id || "");
    analysis.revision += 1;
    analysis.updatedBy = actorUserId;
    try {
      await analysis.save({ session });
    } catch (error) {
      if (error?.name === "VersionError") {
        throw httpError(
          409,
          "AI analysis changed in another request; reload and retry",
          "AUDIT_ANALYSIS_REVISION_CONFLICT"
        );
      }
      throw error;
    }
    await savePaperContentChange(paper, actorUserId, session);
    await touchEngagementContent({ engagement, actorUserId, session });
    await recordDispositionActivity(analysis, paper, finding, session);
    return { analysis, paper, finding };
  });
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
    .select("-creationRequestHash -mutationReceipts")
    .sort(sort)
    .limit(MAX_EXPORT_RECORDS + 1)
    .session(session)
    .lean();
  if (documents.length > MAX_EXPORT_RECORDS) {
    throw httpError(
      413,
      `${label} exceeds the coherent export limit of ${MAX_EXPORT_RECORDS} records`,
      "AUDIT_WORKING_PAPER_EXPORT_LIMIT"
    );
  }
  return documents.map(exportSafeDocument);
}

function serializeWorkingPaperExport(payload) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    if (buffer.byteLength > MAX_EXPORT_BYTES) {
      throw httpError(
        413,
        `Audit working-paper export exceeds ${MAX_EXPORT_BYTES} serialized bytes`,
        "AUDIT_WORKING_PAPER_EXPORT_LIMIT"
      );
    }
    if (payload.exportCompleteness.serializedBytes === buffer.byteLength) return buffer;
    payload.exportCompleteness.serializedBytes = buffer.byteLength;
  }
  throw httpError(
    500,
    "Audit working-paper export byte metadata could not be stabilized",
    "AUDIT_WORKING_PAPER_EXPORT_SERIALIZATION_ERROR"
  );
}

async function buildAuditWorkingPaperExport({ workingPaperId, firmId }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      readPreference: "primary",
    });
    const paper = await AuditWorkingPaper.findOne({
      _id: objectId(workingPaperId, "workingPaperId"),
      firmId,
    })
      .select("-creationRequestHash")
      .populate("engagementId", "title period status engagementType templateHash")
      .populate("clientId", "name pan gstin email phone")
      .session(session)
      .lean();
    if (!paper) {
      throw httpError(
        404,
        "Audit working paper not found",
        "AUDIT_WORKING_PAPER_NOT_FOUND"
      );
    }
    const [rows, analyses, linkedFindings, activity] = await Promise.all([
      loadBoundedExport(
        AuditWorkingPaperRow,
        { firmId, workingPaperId: paper._id },
        { createdAt: 1, _id: 1 },
        "Source rows",
        session
      ),
      loadBoundedExport(
        AuditWorkingPaperAnalysis,
        { firmId, workingPaperId: paper._id },
        { createdAt: 1, _id: 1 },
        "AI analyses",
        session
      ),
      loadBoundedExport(
        EngagementFinding,
        { firmId, "aiProvenance.workingPaperId": paper._id },
        { createdAt: 1, _id: 1 },
        "Linked findings",
        session
      ),
      loadBoundedExport(
        ActivityEvent,
        {
          firmId,
          $or: [
            { entityType: "AuditWorkingPaper", entityId: String(paper._id) },
            { "metadata.workingPaperId": String(paper._id) },
          ],
        },
        { occurredAt: 1, _id: 1 },
        "Activity",
        session
      ),
    ]);

    let priorWorkingPaper = null;
    let priorRows = [];
    if (paper.priorWorkingPaperId) {
      priorWorkingPaper = await AuditWorkingPaper.findOne({
        _id: paper.priorWorkingPaperId,
        firmId,
        clientId: paper.clientId._id,
      })
        .select("-creationRequestHash")
        .session(session)
        .lean();
      if (!priorWorkingPaper) {
        throw httpError(
          409,
          "Prior-period working paper is unavailable in this firm snapshot",
          "INVALID_PRIOR_WORKING_PAPER"
        );
      }
      priorRows = await loadBoundedExport(
        AuditWorkingPaperRow,
        { firmId, workingPaperId: priorWorkingPaper._id },
        { createdAt: 1, _id: 1 },
        "Prior-period source rows",
        session
      );
    }
    const priorByKey = new Map(priorRows.map((row) => [row.rowKey, row]));
    const payload = {
      schemaVersion: "audit-working-paper-export-v1",
      exportedAt: new Date().toISOString(),
      professionalConclusionGenerated: false,
      privacyReviewPassed: false,
      automaticFindingCreationPerformed: false,
      safetyBoundary: {
        operationalWorkingMaterialOnly: true,
        humanDispositionRequired: true,
        sourceRowCitationsRequired: true,
        sourceRowsAppendOnly: true,
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
      workingPaper: exportSafeDocument(paper),
      rows,
      priorPeriod: {
        workingPaper: priorWorkingPaper
          ? exportSafeDocument(priorWorkingPaper)
          : null,
        rows: priorRows,
        comparison: comparisonForRows(rows, priorByKey),
      },
      analyses,
      linkedFindings,
      activity,
      truncation: {
        rows: false,
        priorRows: false,
        analyses: false,
        linkedFindings: false,
        activity: false,
      },
    };
    const buffer = serializeWorkingPaperExport(payload);
    await session.commitTransaction();
    return buffer;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (error?.statusCode) throw error;
    throw httpError(
      503,
      "A coherent MongoDB snapshot is unavailable; audit working-paper export was not produced",
      "AUDIT_WORKING_PAPER_EXPORT_SNAPSHOT_UNAVAILABLE"
    );
  } finally {
    await session.endSession();
  }
}

export {
  ANALYSIS_PROMPT_VERSION,
  buildAuditAiPrompt,
  buildAuditWorkingPaperExport,
  createAuditWorkingPaper,
  createAuditWorkingPaperRow,
  dispositionAuditFindingProposal,
  generateAuditWorkingPaperAnalysis,
  getAuditWorkingPaperDetail,
  listAuditWorkingPapers,
  normalizeAuditAiResult,
  workingPaperPublicationFromRequest,
};
