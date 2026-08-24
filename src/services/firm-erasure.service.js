import mongoose from "mongoose";

import ErasureReceipt from "../models/ErasureReceipt.js";
import {
  STRATEGY,
  PINNED_FIRM_SCOPED,
  classify,
  userTombstone,
  userNeedsTombstone,
  ACTIVITY_EVENT_IDENTITY_FIELD,
} from "./erasure-classification.js";

/**
 * The firm erasure cascade (L12 steps 3-5).
 *
 * DESIGN, AND WHAT IT DOES NOT CLAIM
 * ----------------------------------
 * This is NOT wrapped in a single transaction, and it does not pretend to be atomic. Transactions
 * are available here — `withTransaction` is used in seven other services — but MongoDB caps one at
 * 16MB of oplog and 60 seconds by default, and this spans 33 collections with unbounded per-firm
 * volume. A cascade that succeeds for a small firm and aborts halfway through a large one is worse
 * than one that is honestly resumable.
 *
 * What it provides instead:
 *   idempotent  every step is a filtered write that is a no-op the second time
 *   resumable   each step is marked COMPLETED on the receipt as it lands; a re-run skips those
 *   auditable   the receipt is the same document the cascade steers by, so it cannot over-report
 *
 * WHY NOT A LOOP OVER mongoose.models
 * -----------------------------------
 * Three reasons, each of which has already caused a defect in this repository:
 *   1. Five models carry `rejectMutation` pre-hooks. `Model.deleteMany()` on them throws by design,
 *      so a naive loop fails on exactly the append-only collections that matter most.
 *   2. `DigestDelivery.js` registers two models, so anything counting files miscounts.
 *   3. A model added later would be swept into whatever the loop does by default. Here it is not in
 *      PINNED_FIRM_SCOPED, so the coverage gate fails and a human classifies it first.
 *
 * ORDERING
 * --------
 * PURGE runs before PSEUDONYMISE. If the process dies midway, a firm with its work product gone but
 * its User rows still intact is recoverable by re-running; the reverse leaves rows referencing an
 * account whose identity is already gone and no obvious signal that anything is unfinished.
 */

/** Resolve the registered model for a collection name, or null if it is not registered. */
function modelFor(name) {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
}

/**
 * Build the ordered plan for a firm. Derived from the pinned surface every time rather than stored,
 * so a resumed run cannot execute a stale plan from a previous deploy.
 */
export function buildErasurePlan() {
  const rows = [];
  for (const name of PINNED_FIRM_SCOPED) {
    const model = modelFor(name);
    // `hasFirmId` is true for everything in the pinned list by construction — it is the pinned
    // FIRM-SCOPED surface — so classify() returns the reasoned or derived strategy.
    const { strategy, reason } = classify(name, { hasFirmId: true });
    rows.push({ collectionName: name, strategy, reason, registered: Boolean(model) });
  }
  const order = { [STRATEGY.PURGE]: 0, [STRATEGY.PSEUDONYMISE]: 1, [STRATEGY.RETAIN]: 2 };
  return rows.sort(
    (a, b) => order[a.strategy] - order[b.strategy] || a.collectionName.localeCompare(b.collectionName),
  );
}

/** PURGE: delete the firm's documents. Naturally idempotent — a second run deletes nothing. */
async function purge(model, firmId) {
  const res = await model.deleteMany({ firmId });
  return res?.deletedCount ?? 0;
}

/**
 * PSEUDONYMISE ActivityEvent.
 *
 * The schema installs `rejectMutation` on updateMany, so the Mongoose path throws by design. That
 * guard exists to stop ordinary application code rewriting an append-only audit trail; it is not
 * meant to stop an authorised erasure, and L9 point 6 requires this identity link to be erasable.
 * So this goes through the native driver, deliberately, narrowly, and only here.
 *
 * WHY THE PAYLOAD GOES TOO, NOT JUST actorUserId
 * ----------------------------------------------
 * Clearing only `actorUserId` was the first implementation, and the end-to-end literal scan proved
 * it insufficient: `beforeSummary`, `afterSummary` and `metadata` are `Mixed`, and
 * `activity.service.js:sanitizeSummary` redacts credential-shaped KEYS only — password, token,
 * secret, authorization, cookie, otp. It has no notion of identity, so an entity snapshot keeps
 * whatever the entity held.
 *
 * That leaves two holes, both real:
 *   - the erased user's own name and email survive inside a snapshot of a User-shaped entity;
 *   - a PURGED Client's name, PAN and GSTIN survive inside a snapshot on a retained event, which
 *     would make the Client purge cosmetic — the row deleted, the identifiers still readable.
 *
 * Because the fields are unbounded, no key-level scrub can be trusted to be exhaustive. The payload
 * is therefore cleared wholesale and the event skeleton kept: action, entityType, entityId, source
 * and occurredAt. That preserves what an audit trail is for — that something happened, of what kind
 * and when — while removing the free-form content an erasure is supposed to remove.
 *
 * `metadata.payloadErased` marks the event as deliberately emptied rather than never populated, and
 * doubles as the idempotency filter: once set, a repeat run matches nothing.
 */
async function pseudonymiseActivityEvents(model, firmId) {
  const res = await model.collection.updateMany(
    { firmId, "metadata.payloadErased": { $ne: true } },
    {
      $set: {
        [ACTIVITY_EVENT_IDENTITY_FIELD]: null,
        beforeSummary: null,
        afterSummary: null,
        metadata: { payloadErased: true },
      },
    },
  );
  return res?.modifiedCount ?? 0;
}

/**
 * PSEUDONYMISE User.
 *
 * NOT every account whose active workspace is this firm. An account can belong to several firms,
 * and erasing firm A must not destroy someone's access to firm B — that would erase a person who
 * never asked to be erased, which is a worse failure than not erasing at all.
 *
 * So each candidate is split:
 *   no remaining membership   -> the account existed only inside this firm  -> TOMBSTONE
 *   still a member elsewhere  -> the account outlives this firm             -> DETACH only
 *
 * This depends on ordering: FirmMembership is PURGE and runs before this step, so by the time we
 * look, this firm's membership rows are already gone and any row still present is another firm's.
 * `buildErasurePlan` guarantees that ordering, and the PLAN-order assertion in the contract test
 * pins it. Only ACTIVE memberships spare an account: a REMOVED row is retained history, not
 * continuing participation.
 *
 * SCOPE BOUNDARY: this erases a FIRM. An account that still participates in another firm is
 * deliberately left intact, so erasing one firm can never erase a person who is still working
 * elsewhere. Erasing that person outright is a different operation and needs its own authorisation
 * — silently doing it here would be an erasure nobody requested.
 *
 * Done one account at a time because the tombstone embeds the account's own id to satisfy the
 * unique email index — a single updateMany cannot produce a distinct value per document.
 */
async function pseudonymiseUsers(model, firmId) {
  const FirmMembership = modelFor("FirmMembership");
  const candidates = await model
    .find({ firmId, ...userNeedsTombstone() })
    .select("_id")
    .lean();

  let changed = 0;
  for (const { _id } of candidates) {
    const elsewhere = FirmMembership
      ? await FirmMembership.countDocuments({ userId: _id, status: "ACTIVE" })
      : 0;

    if (elsewhere > 0) {
      // Belongs to another firm. Detach from the erased one and leave the person intact.
      const res = await model.updateOne(
        { _id, firmId },
        { $set: { firmId: null, role: "USER", accountType: "INDIVIDUAL" } },
      );
      changed += res?.modifiedCount ?? 0;
      continue;
    }

    const res = await model.updateOne({ _id, ...userNeedsTombstone() }, userTombstone(_id));
    changed += res?.modifiedCount ?? 0;
  }
  return changed;
}

/** RETAIN: touch nothing. The count is recorded so the receipt states what was kept. */
async function countRetained(model, firmId) {
  return model.countDocuments({ firmId });
}

async function runStep(row, firmId) {
  const model = modelFor(row.collectionName);
  if (!model) {
    // A pinned collection with no registered model means the surface and the code have diverged.
    // Failing loudly is correct: silently skipping is how a collection stops being erased.
    const err = new Error(`Model not registered: ${row.collectionName}`);
    err.code = "ERASURE_MODEL_NOT_REGISTERED";
    throw err;
  }

  if (row.strategy === STRATEGY.PURGE) return purge(model, firmId);
  if (row.strategy === STRATEGY.RETAIN) return countRetained(model, firmId);
  if (row.strategy === STRATEGY.PSEUDONYMISE) {
    if (row.collectionName === "ActivityEvent") return pseudonymiseActivityEvents(model, firmId);
    if (row.collectionName === "User") return pseudonymiseUsers(model, firmId);
    const err = new Error(`No pseudonymisation defined for ${row.collectionName}`);
    err.code = "ERASURE_PSEUDONYMISE_UNDEFINED";
    throw err;
  }

  const err = new Error(`Unknown strategy for ${row.collectionName}`);
  err.code = "ERASURE_STRATEGY_UNKNOWN";
  throw err;
}

/**
 * Erase one firm, or resume an erasure already begun under the same operationId.
 *
 * @param {object}  args
 * @param {string}  args.operationId       Stable id. Re-invoking with the same id RESUMES.
 * @param {object}  args.firmId            ObjectId of the target firm.
 * @param {string} [args.firmDisplayName]  Recorded for provenance; the firm row will be gone.
 * @param {object} [args.authorisedByUserId]
 * @param {string} [args.requestReference] Reference to the written request L9 requires.
 * @param {Function} [args.onStepComplete] Test seam: called after each step is durably recorded.
 * @returns {Promise<object>} the receipt
 */
export async function eraseFirm({
  operationId,
  firmId,
  firmDisplayName = "",
  authorisedByUserId = null,
  requestReference = "",
  onStepComplete = null,
}) {
  if (!operationId || typeof operationId !== "string") {
    const err = new Error("operationId is required and must be a string");
    err.code = "ERASURE_OPERATION_ID_REQUIRED";
    throw err;
  }
  if (!firmId) {
    const err = new Error("firmId is required");
    err.code = "ERASURE_FIRM_ID_REQUIRED";
    throw err;
  }

  const plan = buildErasurePlan();

  // Create-or-resume. The unique index on operationId is what makes a concurrent second call
  // converge on one receipt rather than start a parallel cascade.
  let receipt = await ErasureReceipt.findOne({ operationId });
  if (!receipt) {
    receipt = await ErasureReceipt.create({
      operationId,
      firmId,
      firmDisplayName,
      authorisedByUserId,
      requestReference,
      status: "IN_PROGRESS",
      attempts: 0,
      steps: plan.map((row) => ({
        collectionName: row.collectionName,
        strategy: row.strategy,
        status: "PENDING",
        affected: 0,
      })),
    });
  } else if (String(receipt.firmId) !== String(firmId)) {
    // Reusing an operationId against a different firm would corrupt the audit record and could
    // erase the wrong firm. Refuse.
    const err = new Error("operationId already used for a different firm");
    err.code = "ERASURE_OPERATION_ID_CONFLICT";
    throw err;
  }

  receipt.attempts += 1;
  receipt.status = "IN_PROGRESS";
  await receipt.save();

  for (const row of plan) {
    const step = receipt.steps.find((s) => s.collectionName === row.collectionName);
    if (step && step.status === "COMPLETED") continue; // resumed run: already done

    try {
      const affected = await runStep(row, firmId);
      step.status = "COMPLETED";
      step.affected = affected;
      step.errorCode = null;
      step.completedAt = new Date();
      // Persist after EVERY step. This is what makes a process kill recoverable: whatever is marked
      // COMPLETED really is done, and everything else will be retried.
      await receipt.save();
      if (onStepComplete) await onStepComplete(row, affected, receipt);
    } catch (error) {
      step.status = "FAILED";
      // A code, never a driver message — those can carry connection detail.
      step.errorCode = typeof error?.code === "string" ? error.code : "ERASURE_STEP_FAILED";
      receipt.status = "FAILED";
      await receipt.save();
      throw error;
    }
  }

  receipt.status = receipt.isComplete() ? "COMPLETED" : "FAILED";
  receipt.completedAt = new Date();
  await receipt.save();
  return receipt.toReceipt();
}

/** Read a receipt back without re-running anything. */
export async function getErasureReceipt(operationId) {
  const receipt = await ErasureReceipt.findOne({ operationId });
  return receipt ? receipt.toReceipt() : null;
}
