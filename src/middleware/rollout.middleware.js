import AppConfig, { DEFAULT_FEATURE_FLAGS } from "../models/AppConfig.js";

function assertKnownFeatureFlag(flagName, middlewareName) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, flagName)) {
    throw new Error(`Unknown feature flag ${middlewareName}: ${flagName}`);
  }
}

async function featureState(flagName) {
  return AppConfig.getFeatureFlagState(flagName, {
    fresh:
      flagName === "tdsHealth" ||
      flagName === "noticeCases" ||
      flagName === "assuranceEngagements" ||
      flagName === "auditWorkingPapers",
  });
}

function captureFeatureState(req, flagName, state) {
  req.featureFlagStates = {
    ...(req.featureFlagStates || {}),
    [flagName]: state,
  };
  req.featureFlagVersions = {
    ...(req.featureFlagVersions || {}),
    [flagName]: state.version,
  };
  req.featureFlagPublicationFences = {
    ...(req.featureFlagPublicationFences || {}),
    [flagName]: state.publicationFence,
  };
}

export function requireFeatureFlag(flagName) {
  assertKnownFeatureFlag(flagName, "middleware");

  return async function featureFlagGate(req, res, next) {
    try {
      const state = await featureState(flagName);
      if (!state.enabled) {
        return res.status(404).json({
          ok: false,
          error: "Feature unavailable",
          featureFlag: flagName,
          requestId: req.id || "",
        });
      }
      captureFeatureState(req, flagName, state);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function captureOptionalFeatureFlag(flagName) {
  assertKnownFeatureFlag(flagName, "capture middleware");

  return async function optionalFeatureFlagCapture(req, res, next) {
    try {
      captureFeatureState(req, flagName, await featureState(flagName));
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
