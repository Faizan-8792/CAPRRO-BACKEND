import AppConfig from "../models/AppConfig.js";
import { httpError } from "./case-validation.service.js";

function noticePublicationFromRequest(req) {
  return {
    version: req.featureFlagVersions?.noticeCases,
    publicationFence:
      req.featureFlagPublicationFences?.noticeCases ?? null,
    writeStarted: false,
  };
}

async function assertNoticePublicationCurrent(publication) {
  if (!Number.isSafeInteger(publication?.version)) {
    throw httpError(
      500,
      "Notice publication context is unavailable",
      "NOTICE_PUBLICATION_CONTEXT_REQUIRED"
    );
  }
  if (publication.writeStarted === true) return null;
  return AppConfig.assertFeatureFlagVersion(
    "noticeCases",
    publication.version,
    publication.publicationFence ?? null
  );
}

async function beginNoticePublicationWrite(publication) {
  if (publication?.writeStarted === true) return null;
  const state = await assertNoticePublicationCurrent(publication);
  // Admission policy: after the first write boundary, this admitted request
  // completes under its captured rollout identity. Revocation applies to later
  // requests and cannot turn already-committed state into a rollout 409.
  publication.writeStarted = true;
  return state;
}

export {
  assertNoticePublicationCurrent,
  beginNoticePublicationWrite,
  noticePublicationFromRequest,
};
