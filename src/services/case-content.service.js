import CaseAnalysis from "../models/CaseAnalysis.js";
import CaseDraft from "../models/CaseDraft.js";
import CaseMatter from "../models/CaseMatter.js";
import CaseSubmission from "../models/CaseSubmission.js";
import {
  buildDraftAuthorityBindings,
  confirmedFactsForPrompt,
  generateCaseAnalysis,
  generateCaseDraft,
} from "./case-ai.service.js";
import { syncCaseDeadlineArtifacts } from "./case-deadline.service.js";
import {
  completeCaseProviderOperation,
  failCaseProviderOperation,
  readCaseProviderOperationResult,
  reserveCaseProviderOperation,
  stageCaseProviderOperationResult,
} from "./case-provider-operation.service.js";
import {
  assertCaseReviewer,
  findFirmCase,
  recordCaseEvent,
} from "./case-event.service.js";
import {
  boundedText,
  hashText,
  httpError,
  assertMutationRequestHash,
  mutationKey,
  mutationRequestHash,
  objectId,
  parseDateValue,
  stableJson,
} from "./case-validation.service.js";
import {
  beginNoticePublicationWrite,
} from "./notice-publication.service.js";

const SUBMISSION_METHODS = new Set([
  "PORTAL",
  "EMAIL",
  "PHYSICAL",
  "HAND_DELIVERY",
  "OTHER",
]);
const CASE_STATUSES_AFTER_ANALYSIS = new Set([
  "ANALYSIS",
  "RESPONSE_DRAFT",
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_DRAFT = new Set([
  "RESPONSE_DRAFT",
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_REVIEW_SUBMISSION = new Set([
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "RESPONSE_DRAFT",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_APPROVAL = new Set([
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_REJECTION = new Set([
  "RESPONSE_DRAFT",
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_FINALIZATION = new Set([
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_STATUSES_AFTER_SUBMISSION = new Set([
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);
const CASE_CONTENT_MUTABLE_STATUSES = new Set([
  "INTAKE",
  "EXTRACTION_NEEDS_REVIEW",
  "OPEN",
  "DOCUMENTS_PENDING",
  "ANALYSIS",
  "RESPONSE_DRAFT",
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
]);
const CASE_CONTENT_LOCKED_STATUSES = new Set(["SUBMITTED", "CLOSED", "ARCHIVED"]);
const CASE_SUBMISSION_SOURCE_STATUSES = new Set(["READY_TO_SUBMIT"]);
const CONTENT_TRANSITION_LEASE_MS = 5 * 60 * 1000;

function eventMutationKey(action, key) {
  return `${action}:${key}`;
}

function hasActiveContentTransition(caseMatter, now = new Date()) {
  const transition = caseMatter?.contentTransition;
  if (!transition?.token) return false;
  return !transition.expiresAt || new Date(transition.expiresAt) > now;
}

function availableContentTransitionFilter(now = new Date()) {
  return {
    $or: [
      { "contentTransition.token": { $exists: false } },
      { "contentTransition.token": { $in: ["", null] } },
      { "contentTransition.expiresAt": { $lte: now } },
    ],
  };
}

function clearContentTransitionUpdate() {
  return {
    "contentTransition.token": "",
    "contentTransition.action": "",
    "contentTransition.mutationKey": null,
    "contentTransition.requestHash": null,
    "contentTransition.draftId": null,
    "contentTransition.targetStatus": null,
    "contentTransition.startedAt": null,
    "contentTransition.expiresAt": null,
  };
}

async function claimContentTransition({
  caseMatter,
  action,
  key,
  requestHash,
  draftId = null,
  targetStatus,
  allowedCaseStatuses = CASE_CONTENT_MUTABLE_STATUSES,
}) {
  const token = hashText(stableJson({
    action,
    key,
    requestHash,
    draftId: draftId ? String(draftId) : "",
    targetStatus,
  }));
  const resumed = caseMatter.contentTransition?.token === token;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONTENT_TRANSITION_LEASE_MS);
  const claimed = await CaseMatter.findOneAndUpdate(
    {
      _id: caseMatter._id,
      firmId: caseMatter.firmId,
      revision: caseMatter.revision,
      status: { $in: [...allowedCaseStatuses] },
      $or: [
        { "contentTransition.token": { $exists: false } },
        { "contentTransition.token": { $in: ["", null] } },
        { "contentTransition.expiresAt": { $lte: now } },
        {
          "contentTransition.token": token,
          "contentTransition.requestHash": requestHash,
        },
      ],
    },
    {
      $set: {
        "contentTransition.token": token,
        "contentTransition.action": action,
        "contentTransition.mutationKey": key,
        "contentTransition.requestHash": requestHash,
        "contentTransition.draftId": draftId,
        "contentTransition.targetStatus": targetStatus,
        "contentTransition.startedAt": now,
        "contentTransition.expiresAt": expiresAt,
      },
      $inc: { __v: 1 },
    },
    { new: true, runValidators: true }
  );
  if (claimed) return { caseMatter: claimed, token, resumed };

  const current = await findFirmCase(caseMatter._id, caseMatter.firmId);
  if (current.contentTransition?.token === token) {
    assertMutationRequestHash(
      current.contentTransition.requestHash,
      requestHash
    );
    return { caseMatter: current, token, resumed: true };
  }
  if (
    current.contentTransition?.token &&
    current.contentTransition?.expiresAt &&
    new Date(current.contentTransition.expiresAt) > now
  ) {
    throw httpError(
      409,
      "Another Case content transition is in progress",
      "CASE_CONTENT_TRANSITION_IN_PROGRESS"
    );
  }
  throw httpError(
    409,
    `Case status ${current.status} or revision no longer permits this content transition`,
    "CASE_CONTENT_LIFECYCLE_LOCKED"
  );
}

async function releaseContentTransition(caseMatter, token) {
  if (!token) return;
  await CaseMatter.updateOne(
    {
      _id: caseMatter._id,
      firmId: caseMatter.firmId,
      "contentTransition.token": token,
    },
    {
      $set: clearContentTransitionUpdate(),
      $inc: { __v: 1 },
    }
  );
}

async function createNextVersion(Model, filter, key, requestHash, payloadFactory) {
  const existing = await Model.findOne({ ...filter, mutationKey: key });
  if (existing) {
    assertMutationRequestHash(existing.requestHash, requestHash);
    return { document: existing, created: false };
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = await Model.findOne(filter).sort({ version: -1 }).select("version").lean();
    const version = Number(latest?.version || 0) + 1;
    try {
      const document = await Model.create(payloadFactory(version));
      return { document, created: true };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const duplicate = await Model.findOne({ ...filter, mutationKey: key });
      if (duplicate) {
        assertMutationRequestHash(duplicate.requestHash, requestHash);
        return { document: duplicate, created: false };
      }
      if (attempt === 3) throw error;
    }
  }
  throw new Error("Unable to allocate content version");
}

function selectedReferences(caseMatter, ids) {
  const requested = [
    ...new Set(
      (Array.isArray(ids) ? ids : []).map((id) => objectId(id, "referenceId"))
    ),
  ];
  if (requested.length > 100) throw httpError(400, "A draft may use at most 100 references");
  const available = new Map(
    caseMatter.verifiedReferences.map((reference) => [String(reference._id), reference])
  );
  const references = requested.map((id) => available.get(id)).filter(Boolean);
  if (references.length !== requested.length) {
    throw httpError(
      422,
      "Every draft reference must be explicitly user-verified on this case",
      "UNVERIFIED_CASE_REFERENCE"
    );
  }
  return references;
}

async function reconcileCaseStatus({
  caseMatter,
  targetStatus,
  actorUserId,
  acceptedStatuses,
  sourceStatuses = CASE_CONTENT_MUTABLE_STATUSES,
  transitionToken = null,
  noticePublication,
}) {
  const accepted = new Set([targetStatus, ...(acceptedStatuses || [])]);
  if (accepted.has(caseMatter.status)) {
    let ownedCase = caseMatter;
    let ownedToken = transitionToken;
    if (!ownedToken) {
      const now = new Date();
      const reconciliationToken = hashText(stableJson({
        action: "case-status-reconciliation",
        caseId: String(caseMatter._id),
        targetStatus,
        nonce: new CaseMatter.base.Types.ObjectId().toString(),
      }));
      await beginNoticePublicationWrite(noticePublication);
      const claimed = await CaseMatter.findOneAndUpdate(
        {
          _id: caseMatter._id,
          firmId: caseMatter.firmId,
          revision: caseMatter.revision,
          status: { $in: [...accepted] },
          ...availableContentTransitionFilter(now),
        },
        {
          $set: {
            "contentTransition.token": reconciliationToken,
            "contentTransition.action": "case-status-reconciliation",
            "contentTransition.mutationKey": null,
            "contentTransition.requestHash": null,
            "contentTransition.draftId": null,
            "contentTransition.targetStatus": targetStatus,
            "contentTransition.startedAt": now,
            "contentTransition.expiresAt": new Date(
              now.getTime() + CONTENT_TRANSITION_LEASE_MS
            ),
          },
          $inc: { __v: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!claimed) {
        const current = await findFirmCase(caseMatter._id, caseMatter.firmId);
        if (hasActiveContentTransition(current, now)) {
          throw httpError(
            409,
            "Another Case content transition is in progress",
            "CASE_CONTENT_TRANSITION_IN_PROGRESS"
          );
        }
        throw httpError(
          409,
          "Case changed before content state could be reconciled; retry the request",
          "CASE_CONTENT_RECONCILIATION_CONFLICT"
        );
      }
      ownedCase = claimed;
      ownedToken = reconciliationToken;
    }

    await beginNoticePublicationWrite(noticePublication);
    const released = await CaseMatter.findOneAndUpdate(
      {
        _id: ownedCase._id,
        firmId: ownedCase.firmId,
        status: { $in: [...accepted] },
        "contentTransition.token": ownedToken,
      },
      {
        $set: clearContentTransitionUpdate(),
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    );
    if (released) return released;
    const current = await findFirmCase(ownedCase._id, ownedCase.firmId);
    if (accepted.has(current.status)) {
      if (hasActiveContentTransition(current)) {
        if (current.contentTransition?.token !== ownedToken) {
          throw httpError(
            409,
            "Another Case content transition is in progress",
            "CASE_CONTENT_TRANSITION_IN_PROGRESS"
          );
        }
        throw httpError(
          409,
          "Case content transition could not be released",
          "CASE_CONTENT_RECONCILIATION_CONFLICT"
        );
      }
      return current;
    }
    throw httpError(
      409,
      "Case content transition ownership changed before completion",
      "CASE_CONTENT_RECONCILIATION_CONFLICT"
    );
  }
  if (CASE_CONTENT_LOCKED_STATUSES.has(caseMatter.status)) {
    throw httpError(
      409,
      `Case status ${caseMatter.status} does not permit content workflow changes`,
      "CASE_CONTENT_LIFECYCLE_LOCKED"
    );
  }

  await beginNoticePublicationWrite(noticePublication);
  const updated = await CaseMatter.findOneAndUpdate(
    {
      _id: caseMatter._id,
      firmId: caseMatter.firmId,
      revision: caseMatter.revision,
      status: { $in: [...sourceStatuses] },
      ...(transitionToken
        ? { "contentTransition.token": transitionToken }
        : availableContentTransitionFilter()),
    },
    {
      $set: {
        status: targetStatus,
        updatedBy: actorUserId,
        ...clearContentTransitionUpdate(),
      },
      $inc: { revision: 1, __v: 1 },
    },
    { new: true, runValidators: true }
  );
  if (updated) return updated;

  let current = await findFirmCase(caseMatter._id, caseMatter.firmId);
  if (accepted.has(current.status)) {
    if (
      transitionToken &&
      current.contentTransition?.token === transitionToken
    ) {
      await beginNoticePublicationWrite(noticePublication);
      const released = await CaseMatter.findOneAndUpdate(
        {
          _id: current._id,
          firmId: current.firmId,
          status: { $in: [...accepted] },
          "contentTransition.token": transitionToken,
        },
        {
          $set: clearContentTransitionUpdate(),
          $inc: { __v: 1 },
        },
        { new: true, runValidators: true }
      );
      if (released) return released;
      current = await findFirmCase(caseMatter._id, caseMatter.firmId);
    }
    if (accepted.has(current.status)) {
      if (hasActiveContentTransition(current)) {
        if (
          transitionToken &&
          current.contentTransition?.token === transitionToken
        ) {
          throw httpError(
            409,
            "Case content transition could not be released",
            "CASE_CONTENT_RECONCILIATION_CONFLICT"
          );
        }
        throw httpError(
          409,
          "Another Case content transition is in progress",
          "CASE_CONTENT_TRANSITION_IN_PROGRESS"
        );
      }
      return current;
    }
  }
  throw httpError(
    409,
    CASE_CONTENT_LOCKED_STATUSES.has(current.status)
      ? `Case status ${current.status} does not permit content workflow changes`
      : "Case changed while content state was being reconciled; retry the request",
    CASE_CONTENT_LOCKED_STATUSES.has(current.status)
      ? "CASE_CONTENT_LIFECYCLE_LOCKED"
      : "CASE_CONTENT_RECONCILIATION_CONFLICT"
  );
}

async function reconcileContentProjection(
  caseMatter,
  actorUserId,
  noticePublication
) {
  await beginNoticePublicationWrite(noticePublication);
  await syncCaseDeadlineArtifacts({ caseMatter, actorUserId });
  return caseMatter;
}

function isDraftReplay(draft, mutationField, mutationHashField, key, requestHash, replayStatuses) {
  if (
    draft?.[mutationField] !== key ||
    !new Set(replayStatuses).has(draft?.status)
  ) {
    return false;
  }
  assertMutationRequestHash(draft[mutationHashField], requestHash);
  return true;
}

async function transitionDraft({
  caseMatter,
  draftId,
  expectedStatus,
  mutationField,
  mutationHashField,
  key,
  requestHash,
  update,
  replayStatuses,
  targetCaseStatus,
  noticePublication,
  allowedCaseStatuses = CASE_CONTENT_MUTABLE_STATUSES,
  conflictMessage,
}) {
  const draftObjectId = objectId(draftId, "draftId");
  let claim;
  try {
    await beginNoticePublicationWrite(noticePublication);
    claim = await claimContentTransition({
      caseMatter,
      action: mutationField,
      key,
      requestHash,
      draftId: draftObjectId,
      targetStatus: targetCaseStatus,
      allowedCaseStatuses,
    });
  } catch (error) {
    if (error?.code === "CASE_CONTENT_TRANSITION_IN_PROGRESS") throw error;
    const replay = await CaseDraft.findOne({
      _id: draftObjectId,
      firmId: caseMatter.firmId,
      caseId: caseMatter._id,
    });
    if (isDraftReplay(replay, mutationField, mutationHashField, key, requestHash, replayStatuses)) {
      return {
        draft: replay,
        applied: false,
        caseMatter,
        transitionToken: null,
        transitionResumed: false,
      };
    }
    throw error;
  }

  let draft;
  try {
    await beginNoticePublicationWrite(noticePublication);
    draft = await CaseDraft.findOneAndUpdate(
      {
        _id: draftObjectId,
        firmId: claim.caseMatter.firmId,
        caseId: claim.caseMatter._id,
        status: expectedStatus,
      },
      {
        $set: {
          ...update,
          [mutationField]: key,
          [mutationHashField]: requestHash,
        },
      },
      { new: true, runValidators: true }
    );
  } catch (error) {
    await releaseContentTransition(claim.caseMatter, claim.token);
    if (error?.code === 11000) {
      throw httpError(409, "mutationKey was already used for another draft operation", "MUTATION_KEY_REUSED");
    }
    throw error;
  }
  if (draft) {
    return {
      draft,
      applied: true,
      caseMatter: claim.caseMatter,
      transitionToken: claim.token,
      transitionResumed: claim.resumed,
    };
  }

  draft = await CaseDraft.findOne({
    _id: draftObjectId,
    firmId: claim.caseMatter.firmId,
    caseId: claim.caseMatter._id,
  });
  if (!draft) {
    await releaseContentTransition(claim.caseMatter, claim.token);
    throw httpError(404, "Draft not found");
  }
  if (isDraftReplay(draft, mutationField, mutationHashField, key, requestHash, replayStatuses)) {
    return {
      draft,
      applied: false,
      caseMatter: claim.caseMatter,
      transitionToken: claim.token,
      transitionResumed: claim.resumed,
    };
  }
  await releaseContentTransition(claim.caseMatter, claim.token);
  throw httpError(409, conflictMessage, "CASE_DRAFT_TRANSITION_CONFLICT");
}

async function createAnalysis({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-analysis-create", input);
  const initialCase = await findFirmCase(caseId, firmId);
  let analysis = await CaseAnalysis.findOne({
    firmId,
    caseId: initialCase._id,
    mutationKey: key,
  });
  if (analysis) assertMutationRequestHash(analysis.requestHash, requestHash);
  let transitionCase = initialCase;
  let transitionToken = null;
  let analysisPersisted = Boolean(analysis);

  if (!analysis) {
    if (!CASE_CONTENT_MUTABLE_STATUSES.has(initialCase.status)) {
      throw httpError(
        409,
        `Case status ${initialCase.status} does not permit new analysis`,
        "CASE_CONTENT_LIFECYCLE_LOCKED"
      );
    }
    if (input?.consent !== true) {
      throw httpError(
        400,
        "Explicit DeepSeek processing consent is required",
        "CASE_AI_CONSENT_REQUIRED"
      );
    }
    await beginNoticePublicationWrite(noticePublication);
    let reservation = await reserveCaseProviderOperation({
      firmId,
      caseId: initialCase._id,
      action: "CASE_ANALYSIS",
      mutationKey: key,
      requestHash,
    });
    if (reservation.completed) {
      analysis = await CaseAnalysis.findOne({
        firmId,
        caseId: initialCase._id,
        mutationKey: key,
      });
      if (!analysis) {
        throw httpError(
          409,
          "Completed analysis reservation has no analysis result",
          "CASE_PROVIDER_RESULT_MISSING"
        );
      }
      assertMutationRequestHash(analysis.requestHash, requestHash);
    } else {
      try {
        await beginNoticePublicationWrite(noticePublication);
        let generated = readCaseProviderOperationResult(reservation.operation);
        if (!generated) {
          generated = await generateCaseAnalysis(initialCase);
          reservation = {
            ...reservation,
            operation: await stageCaseProviderOperationResult(
              reservation.operation,
              generated
            ),
          };
        }
        await beginNoticePublicationWrite(noticePublication);
        const transition = await claimContentTransition({
          caseMatter: initialCase,
          action: "case-analysis-create",
          key,
          requestHash,
          targetStatus: "ANALYSIS",
        });
        transitionCase = transition.caseMatter;
        transitionToken = transition.token;
        const result = await createNextVersion(
          CaseAnalysis,
          { firmId, caseId: transitionCase._id },
          key,
          requestHash,
          (version) => ({
            firmId,
            caseId: transitionCase._id,
            version,
            mutationKey: key,
            requestHash,
            sourceTextHash: initialCase.source.textHash,
            confirmedFactsHash: generated.confirmedFactsHash,
            ...generated.output,
            provider: generated.provider,
            model: generated.model,
            createdBy: actorUserId,
          })
        );
        analysis = result.document;
        analysisPersisted = true;
        await completeCaseProviderOperation(reservation.operation, analysis._id);
      } catch (error) {
        if (transitionToken && !analysisPersisted) {
          await releaseContentTransition(transitionCase, transitionToken);
        }
        await failCaseProviderOperation(reservation.operation, error);
        throw error;
      }
    }
  }

  if (
    !transitionToken &&
    !CASE_STATUSES_AFTER_ANALYSIS.has(initialCase.status)
  ) {
    await beginNoticePublicationWrite(noticePublication);
    const transition = await claimContentTransition({
      caseMatter: initialCase,
      action: "case-analysis-create",
      key,
      requestHash,
      targetStatus: "ANALYSIS",
    });
    transitionCase = transition.caseMatter;
    transitionToken = transition.token;
  }

  let caseMatter = await reconcileCaseStatus({
    caseMatter: transitionCase,
    targetStatus: "ANALYSIS",
    actorUserId,
    acceptedStatuses: CASE_STATUSES_AFTER_ANALYSIS,
    transitionToken,
    noticePublication,
  });
  await reconcileContentProjection(caseMatter, actorUserId, noticePublication);
  await beginNoticePublicationWrite(noticePublication);
  await recordCaseEvent({
    caseMatter,
    actorUserId,
    type: "ANALYSIS_CREATED",
    title: `AI-assisted analysis version ${analysis.version} created`,
    detail: "Structured working analysis requires professional review.",
    metadata: {
      analysisId: String(analysis._id),
      version: analysis.version,
      confirmedFactsHash: analysis.confirmedFactsHash,
      provider: analysis.provider,
      model: analysis.model,
    },
    mutationKey: eventMutationKey("analysis", key),
    requestHash,
    requestId,
    activitySource: "AI_ASSISTED",
  });
  return analysis;
}

async function createDraft({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-draft-create", input);
  const initialCase = await findFirmCase(caseId, firmId);
  let draft = await CaseDraft.findOne({
    firmId,
    caseId: initialCase._id,
    mutationKey: key,
  });
  if (draft) assertMutationRequestHash(draft.requestHash, requestHash);
  let transitionCase = initialCase;
  let transitionToken = null;
  let draftPersisted = Boolean(draft);

  if (!draft) {
    if (!CASE_CONTENT_MUTABLE_STATUSES.has(initialCase.status)) {
      throw httpError(
        409,
        `Case status ${initialCase.status} does not permit new drafts`,
        "CASE_CONTENT_LIFECYCLE_LOCKED"
      );
    }
    const origin = String(input.origin || "USER").toUpperCase();
    if (!new Set(["USER", "AI_ASSISTED"]).has(origin)) {
      throw httpError(400, "Draft origin must be USER or AI_ASSISTED");
    }
    const references = selectedReferences(initialCase, input.referenceIds);

    let parentDraftId = null;
    if (input.parentDraftId) {
      const parent = await CaseDraft.findOne({
        _id: objectId(input.parentDraftId, "parentDraftId"),
        firmId,
        caseId: initialCase._id,
      }).lean();
      if (!parent) throw httpError(400, "Parent draft does not belong to this case");
      parentDraftId = parent._id;
    }

    let basedOnAnalysisVersion = null;
    if (input.basedOnAnalysisVersion != null && input.basedOnAnalysisVersion !== "") {
      const version = Number(input.basedOnAnalysisVersion);
      if (!Number.isInteger(version) || version < 1) {
        throw httpError(400, "basedOnAnalysisVersion is invalid");
      }
      const exists = await CaseAnalysis.exists({
        firmId,
        caseId: initialCase._id,
        version,
      });
      if (!exists) throw httpError(400, "Analysis version does not belong to this case");
      basedOnAnalysisVersion = version;
    }

    const title = boundedText(input.title || "Response draft", 500, {
      required: true,
      label: "draft title",
    });
    let content;
    let provider = "";
    let model = "";
    let reservation = null;
    try {
      if (origin === "AI_ASSISTED") {
        if (input.aiConsent !== true) {
          throw httpError(
            400,
            "Explicit DeepSeek processing consent is required",
            "CASE_AI_CONSENT_REQUIRED"
          );
        }
        await beginNoticePublicationWrite(noticePublication);
        reservation = await reserveCaseProviderOperation({
          firmId,
          caseId: initialCase._id,
          action: "CASE_DRAFT",
          mutationKey: key,
          requestHash,
        });
        if (reservation.completed) {
          draft = await CaseDraft.findOne({
            firmId,
            caseId: initialCase._id,
            mutationKey: key,
          });
          if (!draft) {
            throw httpError(
              409,
              "Completed draft reservation has no Draft result",
              "CASE_PROVIDER_RESULT_MISSING"
            );
          }
          assertMutationRequestHash(draft.requestHash, requestHash);
        } else {
          await beginNoticePublicationWrite(noticePublication);
          let generated = readCaseProviderOperationResult(
            reservation.operation
          );
          if (!generated) {
            generated = await generateCaseDraft(
              initialCase,
              references,
              input.instructions || ""
            );
            reservation = {
              ...reservation,
              operation: await stageCaseProviderOperationResult(
                reservation.operation,
                generated
              ),
            };
          }
          await beginNoticePublicationWrite(noticePublication);
          content = generated.content;
          provider = generated.provider;
          model = generated.model;
        }
      } else {
        content = boundedText(input.content, 250000, {
          required: true,
          label: "draft content",
        });
      }

      if (!draft) {
        const { authorityClaims } = buildDraftAuthorityBindings(
          content,
          references
        );
        await beginNoticePublicationWrite(noticePublication);
        const transition = await claimContentTransition({
          caseMatter: initialCase,
          action: "case-draft-create",
          key,
          requestHash,
          targetStatus: "RESPONSE_DRAFT",
        });
        transitionCase = transition.caseMatter;
        transitionToken = transition.token;
        const result = await createNextVersion(
          CaseDraft,
          { firmId, caseId: transitionCase._id },
          key,
          requestHash,
          (version) => ({
            firmId,
            caseId: transitionCase._id,
            version,
            mutationKey: key,
            requestHash,
            parentDraftId,
            origin,
            title,
            content,
            contentHash: hashText(content),
            referenceIds: references.map((reference) => reference._id),
            authorityClaims,
            basedOnAnalysisVersion,
            provider,
            model,
            status: "DRAFT",
            createdBy: actorUserId,
          })
        );
        draft = result.document;
        draftPersisted = true;
        if (reservation) {
          await completeCaseProviderOperation(reservation.operation, draft._id);
        }
      }
    } catch (error) {
      if (transitionToken && !draftPersisted) {
        await releaseContentTransition(transitionCase, transitionToken);
      }
      if (reservation && !reservation.completed) {
        await failCaseProviderOperation(reservation.operation, error);
      }
      throw error;
    }
  }

  if (!transitionToken && !CASE_STATUSES_AFTER_DRAFT.has(initialCase.status)) {
    await beginNoticePublicationWrite(noticePublication);
    const transition = await claimContentTransition({
      caseMatter: initialCase,
      action: "case-draft-create",
      key,
      requestHash,
      targetStatus: "RESPONSE_DRAFT",
    });
    transitionCase = transition.caseMatter;
    transitionToken = transition.token;
  }

  let caseMatter = await reconcileCaseStatus({
    caseMatter: transitionCase,
    targetStatus: "RESPONSE_DRAFT",
    actorUserId,
    acceptedStatuses: CASE_STATUSES_AFTER_DRAFT,
    transitionToken,
    noticePublication,
  });
  await reconcileContentProjection(caseMatter, actorUserId, noticePublication);
  await beginNoticePublicationWrite(noticePublication);
  await recordCaseEvent({
    caseMatter,
    actorUserId,
    type: "DRAFT_CREATED",
    title: `Response draft version ${draft.version} created`,
    detail:
      draft.origin === "AI_ASSISTED"
        ? "AI-assisted content; reviewer approval is required."
        : "User-authored content preserved as a new version.",
    metadata: {
      draftId: String(draft._id),
      version: draft.version,
      origin: draft.origin,
      referenceIds: draft.referenceIds.map(String),
    },
    mutationKey: eventMutationKey("draft-create", key),
    requestHash,
    requestId,
    activitySource: draft.origin === "AI_ASSISTED" ? "AI_ASSISTED" : "USER",
  });
  return draft;
}

async function submitDraftForReview({
  caseId,
  draftId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-draft-submit-review", input);
  const initialCase = await findFirmCase(caseId, firmId);
  if (!initialCase.reviewerUserId) {
    throw httpError(409, "Assign a case reviewer before review submission");
  }
  const transition = await transitionDraft({
    caseMatter: initialCase,
    draftId,
    expectedStatus: "DRAFT",
    mutationField: "reviewSubmissionMutationKey",
    mutationHashField: "reviewSubmissionRequestHash",
    key,
    requestHash,
    update: { status: "IN_REVIEW" },
    replayStatuses: [
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "FINALIZING",
      "FINAL",
      "SUPERSEDED",
    ],
    targetCaseStatus: "INTERNAL_REVIEW",
    noticePublication,
    conflictMessage: "Only a DRAFT version can enter review",
  });
  let caseMatter = await reconcileCaseStatus({
    caseMatter: transition.caseMatter,
    targetStatus: "INTERNAL_REVIEW",
    actorUserId,
    acceptedStatuses: transition.applied || transition.transitionResumed
      ? []
      : CASE_STATUSES_AFTER_REVIEW_SUBMISSION,
    transitionToken: transition.transitionToken,
    noticePublication,
  });
  await reconcileContentProjection(caseMatter, actorUserId, noticePublication);
  await beginNoticePublicationWrite(noticePublication);
  await recordCaseEvent({
    caseMatter,
    actorUserId,
    type: "DRAFT_REVIEWED",
    title: `Draft version ${transition.draft.version} submitted for review`,
    metadata: {
      draftId: String(transition.draft._id),
      version: transition.draft.version,
      action: "SUBMIT_FOR_REVIEW",
    },
    mutationKey: eventMutationKey("draft-submit-review", key),
    requestHash,
    requestId,
  });
  return transition.draft;
}

async function reviewDraft({
  caseId,
  draftId,
  firmId,
  user,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-draft-review", input);
  const initialCase = await findFirmCase(caseId, firmId);
  assertCaseReviewer(initialCase, user);
  const action = String(input.action || "").toUpperCase();
  if (!new Set(["APPROVE", "REJECT"]).has(action)) {
    throw httpError(400, "action must be APPROVE or REJECT");
  }
  const note = boundedText(input.note, 5000, { label: "review note" });
  if (action === "REJECT" && !note) {
    throw httpError(400, "A review note is required when rejecting");
  }
  const targetDraftStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
  const replayStatuses =
    action === "APPROVE"
      ? ["APPROVED", "FINALIZING", "FINAL", "SUPERSEDED"]
      : ["REJECTED"];
  const transition = await transitionDraft({
    caseMatter: initialCase,
    draftId,
    expectedStatus: "IN_REVIEW",
    mutationField: "reviewDecisionMutationKey",
    mutationHashField: "reviewDecisionRequestHash",
    key,
    requestHash,
    update: {
      status: targetDraftStatus,
      reviewNote: note,
      reviewedBy: user.id,
      reviewedAt: new Date(),
    },
    replayStatuses,
    targetCaseStatus: action === "APPROVE" ? "CLIENT_APPROVAL" : "RESPONSE_DRAFT",
    noticePublication,
    conflictMessage: "Only an IN_REVIEW draft can be approved or rejected",
  });
  const targetCaseStatus = action === "APPROVE" ? "CLIENT_APPROVAL" : "RESPONSE_DRAFT";
  let caseMatter = await reconcileCaseStatus({
    caseMatter: transition.caseMatter,
    targetStatus: targetCaseStatus,
    actorUserId: user.id,
    acceptedStatuses: transition.applied || transition.transitionResumed
      ? []
      : action === "APPROVE"
        ? CASE_STATUSES_AFTER_APPROVAL
        : CASE_STATUSES_AFTER_REJECTION,
    transitionToken: transition.transitionToken,
    noticePublication,
  });
  await reconcileContentProjection(caseMatter, user.id, noticePublication);
  await beginNoticePublicationWrite(noticePublication);
  await recordCaseEvent({
    caseMatter,
    actorUserId: user.id,
    type: "DRAFT_REVIEWED",
    title: `Draft version ${transition.draft.version} ${
      action === "APPROVE" ? "approved" : "rejected"
    }`,
    detail: transition.draft.reviewNote,
    metadata: {
      draftId: String(transition.draft._id),
      version: transition.draft.version,
      action,
    },
    mutationKey: eventMutationKey("draft-review", key),
    requestHash,
    requestId,
  });
  return transition.draft;
}

async function finalizeDraft({
  caseId,
  draftId,
  firmId,
  user,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-draft-finalize", input);
  const initialCase = await findFirmCase(caseId, firmId);
  assertCaseReviewer(initialCase, user);
  const transition = await transitionDraft({
    caseMatter: initialCase,
    draftId,
    expectedStatus: "APPROVED",
    mutationField: "finalizationMutationKey",
    mutationHashField: "finalizationRequestHash",
    key,
    requestHash,
    update: {
      status: "FINALIZING",
      finalizedBy: user.id,
      finalizedAt: new Date(),
    },
    replayStatuses: ["FINALIZING", "FINAL", "SUPERSEDED"],
    targetCaseStatus: "READY_TO_SUBMIT",
    noticePublication,
    conflictMessage: "Reviewer approval is required before finalization",
  });

  let draft = transition.draft;
  if (draft.status === "FINALIZING") {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const submittedDraftIds = await CaseSubmission.distinct("draftId", {
        firmId,
        caseId: initialCase._id,
      });
      await beginNoticePublicationWrite(noticePublication);
      await CaseDraft.updateMany(
        {
          firmId,
          caseId: initialCase._id,
          status: "FINAL",
          _id: { $nin: [draft._id, ...submittedDraftIds] },
          submissionMutationKey: null,
        },
        { $set: { status: "SUPERSEDED" } }
      );
      try {
        await beginNoticePublicationWrite(noticePublication);
        const finalized = await CaseDraft.findOneAndUpdate(
          {
            _id: draft._id,
            firmId,
            caseId: initialCase._id,
            status: "FINALIZING",
            finalizationMutationKey: key,
            finalizationRequestHash: requestHash,
          },
          { $set: { status: "FINAL" } },
          { new: true, runValidators: true }
        );
        if (finalized) {
          draft = finalized;
          break;
        }
      } catch (error) {
        if (error?.code !== 11000 || attempt === 3) throw error;
        continue;
      }
      draft = await CaseDraft.findOne({
        _id: draft._id,
        firmId,
        caseId: initialCase._id,
      });
      if (draft?.status === "FINAL" || draft?.status === "SUPERSEDED") break;
      if (attempt === 3) {
        throw httpError(
          409,
          "Draft finalization could not converge; retry the request",
          "CASE_DRAFT_FINALIZATION_CONFLICT"
        );
      }
    }
  }
  if (!draft || !new Set(["FINAL", "SUPERSEDED"]).has(draft.status)) {
    throw httpError(
      409,
      "Draft finalization could not converge; retry the request",
      "CASE_DRAFT_FINALIZATION_CONFLICT"
    );
  }

  let caseMatter = await reconcileCaseStatus({
    caseMatter: transition.caseMatter,
    targetStatus: "READY_TO_SUBMIT",
    actorUserId: user.id,
    acceptedStatuses:
      transition.applied || transition.transitionResumed
        ? []
        : CASE_STATUSES_AFTER_FINALIZATION,
    transitionToken: transition.transitionToken,
    noticePublication,
  });
  await reconcileContentProjection(caseMatter, user.id, noticePublication);
  await beginNoticePublicationWrite(noticePublication);
  await recordCaseEvent({
    caseMatter,
    actorUserId: user.id,
    type: "DRAFT_FINALIZED",
    title: `Draft version ${draft.version} finalized after review`,
    metadata: {
      draftId: String(draft._id),
      version: draft.version,
      finalStatus: draft.status,
    },
    mutationKey: eventMutationKey("draft-finalize", key),
    requestHash,
    requestId,
  });
  return draft;
}

async function recordSubmission({
  caseId,
  firmId,
  actorUserId,
  input,
  requestId,
  noticePublication,
}) {
  const key = mutationKey(input?.mutationKey);
  const requestHash = mutationRequestHash("case-submission-record", input);
  const initialCase = await findFirmCase(caseId, firmId);
  const draftId = objectId(input.draftId, "draftId");
  let submission = await CaseSubmission.findOne({
    firmId,
    caseId: initialCase._id,
    mutationKey: key,
  });
  if (submission) assertMutationRequestHash(submission.requestHash, requestHash);

  let transitionCase = initialCase;
  let transitionToken = null;
  let workflowMutationCommitted = Boolean(submission);
  if (CASE_SUBMISSION_SOURCE_STATUSES.has(initialCase.status)) {
    await beginNoticePublicationWrite(noticePublication);
    const transition = await claimContentTransition({
      caseMatter: initialCase,
      action: "case-submission-record",
      key,
      requestHash,
      draftId,
      targetStatus: "SUBMITTED",
      allowedCaseStatuses: CASE_SUBMISSION_SOURCE_STATUSES,
    });
    transitionCase = transition.caseMatter;
    transitionToken = transition.token;
  }

  try {
    if (!submission) {
      if (!CASE_SUBMISSION_SOURCE_STATUSES.has(transitionCase.status)) {
        throw httpError(
          409,
          `Case status ${transitionCase.status} does not permit submission recording`,
          "CASE_CONTENT_LIFECYCLE_LOCKED"
        );
      }
      const method = String(input.method || "").toUpperCase();
      if (!SUBMISSION_METHODS.has(method)) {
        throw httpError(400, "Unsupported submission method");
      }
      const submittedAt = parseDateValue(input.submittedAt, "submittedAt", {
        required: true,
      });
      const acknowledgmentReference = boundedText(
        input.acknowledgmentReference,
        500,
        { required: true, label: "acknowledgmentReference" }
      );
      const notes = boundedText(input.notes, 5000, { label: "submission notes" });
      const acknowledgmentExists = await CaseSubmission.exists({
        firmId,
        caseId: transitionCase._id,
        acknowledgmentReference,
      });
      if (acknowledgmentExists) {
        throw httpError(409, "This acknowledgment reference is already recorded");
      }

      let draft = await CaseDraft.findOne({
        _id: draftId,
        firmId,
        caseId: transitionCase._id,
        status: "FINAL",
      });
      if (!draft) {
        throw httpError(409, "Submission must reference a reviewer-approved FINAL draft");
      }
      if (draft.submissionMutationKey) {
        if (draft.submissionMutationKey !== key) {
          throw httpError(
            409,
            "This FINAL draft is already bound to an immutable submission attempt",
            "CASE_DRAFT_ALREADY_SUBMITTED"
          );
        }
        assertMutationRequestHash(draft.submissionRequestHash, requestHash);
        workflowMutationCommitted = true;
      } else {
        await beginNoticePublicationWrite(noticePublication);
        draft = await CaseDraft.findOneAndUpdate(
          {
            _id: draftId,
            firmId,
            caseId: transitionCase._id,
            status: "FINAL",
            submissionMutationKey: null,
          },
          {
            $set: {
              submissionMutationKey: key,
              submissionRequestHash: requestHash,
              submittedVersionAt: new Date(),
              submittedVersionBy: actorUserId,
            },
          },
          { new: true, runValidators: true }
        );
        if (!draft) {
          const claimed = await CaseDraft.findOne({
            _id: draftId,
            firmId,
            caseId: transitionCase._id,
            status: "FINAL",
          });
          if (!claimed || claimed.submissionMutationKey !== key) {
            throw httpError(
              409,
              "This FINAL draft was claimed by another submission",
              "CASE_DRAFT_ALREADY_SUBMITTED"
            );
          }
          assertMutationRequestHash(claimed.submissionRequestHash, requestHash);
          draft = claimed;
        }
        workflowMutationCommitted = true;
      }

      try {
        await beginNoticePublicationWrite(noticePublication);
        const result = await createNextVersion(
          CaseSubmission,
          { firmId, caseId: transitionCase._id },
          key,
          requestHash,
          (version) => ({
            firmId,
            caseId: transitionCase._id,
            version,
            mutationKey: key,
            requestHash,
            draftId: draft._id,
            draftVersion: draft.version,
            method,
            submittedAt,
            acknowledgmentReference,
            notes,
            recordedBy: actorUserId,
          })
        );
        submission = result.document;
        workflowMutationCommitted = true;
      } catch (error) {
        if (error?.code === 11000) {
          throw httpError(409, "This acknowledgment reference is already recorded");
        }
        throw error;
      }
    }

    const caseMatter = await reconcileCaseStatus({
      caseMatter: transitionCase,
      targetStatus: "SUBMITTED",
      actorUserId,
      acceptedStatuses: CASE_STATUSES_AFTER_SUBMISSION,
      sourceStatuses: CASE_SUBMISSION_SOURCE_STATUSES,
      transitionToken,
      noticePublication,
    });
    await reconcileContentProjection(
      caseMatter,
      actorUserId,
      noticePublication
    );
    await beginNoticePublicationWrite(noticePublication);
    await recordCaseEvent({
      caseMatter,
      actorUserId,
      type: "SUBMISSION_RECORDED",
      title: `Submission record version ${submission.version} added`,
      detail: `${submission.method}; acknowledgment ${submission.acknowledgmentReference}`,
      metadata: {
        submissionId: String(submission._id),
        version: submission.version,
        draftId: String(submission.draftId),
        automaticSubmissionPerformed: false,
      },
      mutationKey: eventMutationKey("submission", key),
      requestHash,
      requestId,
    });
    return submission;
  } catch (error) {
    if (transitionToken && !workflowMutationCommitted) {
      await releaseContentTransition(transitionCase, transitionToken);
    }
    throw error;
  }
}

export {
  createAnalysis,
  createDraft,
  finalizeDraft,
  recordSubmission,
  reviewDraft,
  submitDraftForReview,
};
