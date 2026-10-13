import { CURRENT_TERMS } from "../config/current-terms.js";
import TermsAcceptance from "../models/TermsAcceptance.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function validateCurrentTermsAcceptance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: 400,
      code: "TERMS_ACCEPTANCE_REQUIRED",
      error: "Accept the current Terms & Conditions before signing in.",
    };
  }

  const version = typeof value.version === "string" ? value.version.trim() : "";
  const documentHash =
    typeof value.documentHash === "string"
      ? value.documentHash.trim().toLowerCase()
      : "";

  if (
    value.accepted !== true ||
    !version ||
    version.length > 64 ||
    !HASH_PATTERN.test(documentHash)
  ) {
    return {
      status: 400,
      code: "TERMS_ACCEPTANCE_REQUIRED",
      error: "Accept the current Terms & Conditions before signing in.",
    };
  }

  if (
    version !== CURRENT_TERMS.version ||
    documentHash !== CURRENT_TERMS.documentHash
  ) {
    return {
      status: 409,
      code: "TERMS_VERSION_MISMATCH",
      error: "Terms & Conditions changed. Review the current version before signing in.",
      details: {
        currentVersion: CURRENT_TERMS.version,
        currentDocumentHash: CURRENT_TERMS.documentHash,
      },
    };
  }

  return null;
}

export async function recordCurrentTermsAcceptance({ userId, email }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const filter = {
    userId,
    termsVersion: CURRENT_TERMS.version,
  };

  let acceptance;
  try {
    acceptance = await TermsAcceptance.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          userId,
          email: normalizedEmail,
          termsVersion: CURRENT_TERMS.version,
          documentHash: CURRENT_TERMS.documentHash,
          source: "DESKTOP",
          acceptedAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    acceptance = await TermsAcceptance.findOne(filter).lean();
  }

  if (!acceptance) {
    throw new Error("Terms acceptance could not be recorded");
  }

  if (acceptance.documentHash !== CURRENT_TERMS.documentHash) {
    throw new Error(
      "Current terms content changed without a corresponding version change"
    );
  }

  return {
    acceptanceId: String(acceptance._id),
    version: acceptance.termsVersion,
    documentHash: acceptance.documentHash,
    acceptedAt: new Date(acceptance.acceptedAt).toISOString(),
    source: acceptance.source,
  };
}
