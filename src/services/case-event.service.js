import CaseMatter from "../models/CaseMatter.js";
import CaseTimelineEvent from "../models/CaseTimelineEvent.js";
import { safeRecordActivity } from "./activity.service.js";
import {
  assertMutationRequestHash,
  httpError,
  objectId,
} from "./case-validation.service.js";

async function findFirmCase(caseId, firmId, { lean = false } = {}) {
  const query = CaseMatter.findOne({
    _id: objectId(caseId, "caseId"),
    firmId,
  });
  const caseMatter = lean ? await query.lean() : await query;
  if (!caseMatter) throw httpError(404, "Case not found", "CASE_NOT_FOUND");
  return caseMatter;
}

function canReviewCase(caseMatter, user) {
  return Boolean(
    user?.role === "FIRM_ADMIN" ||
    (caseMatter?.reviewerUserId && String(caseMatter.reviewerUserId) === String(user?.id))
  );
}

function assertCaseReviewer(caseMatter, user) {
  if (!canReviewCase(caseMatter, user)) {
    throw httpError(403, "Assigned case reviewer or firm admin required", "CASE_REVIEWER_REQUIRED");
  }
}

async function recordCaseEvent({
  caseMatter,
  actorUserId,
  type,
  title,
  detail = "",
  metadata = {},
  mutationKey = null,
  requestHash = null,
  requestId = "",
  activitySource = "USER",
}) {
  let event;
  let created = false;
  try {
    event = await CaseTimelineEvent.create({
      firmId: caseMatter.firmId,
      caseId: caseMatter._id,
      type,
      title,
      detail,
      actorUserId,
      mutationKey,
      requestHash,
      metadata,
    });
    created = true;
  } catch (error) {
    if (error?.code !== 11000 || !mutationKey) throw error;
    event = await CaseTimelineEvent.findOne({
      firmId: caseMatter.firmId,
      caseId: caseMatter._id,
      mutationKey,
    });
    if (!event) throw error;
    assertMutationRequestHash(event.requestHash, requestHash);
  }
  if (!created) return event;

  await safeRecordActivity({
    firmId: caseMatter.firmId,
    actorUserId,
    source: activitySource,
    action: type,
    entityType: "CASE_MATTER",
    entityId: caseMatter._id,
    requestId,
    afterSummary: {
      status: caseMatter.status,
      priority: caseMatter.priority,
      risk: caseMatter.risk,
      revision: caseMatter.revision,
    },
    metadata: {
      timelineEventId: String(event._id),
      ...metadata,
    },
  });
  return event;
}

export {
  assertCaseReviewer,
  canReviewCase,
  findFirmCase,
  recordCaseEvent,
};
