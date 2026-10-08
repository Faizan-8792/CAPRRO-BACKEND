# GST reconciliation API contract

Ledger task **T13**. Verified by reading the server source, not inferred from field names.

Sources read:

| File                                               | What it settles                                           |
| -------------------------------------------------- | --------------------------------------------------------- |
| `src/app.js:23,307`                                | mount path                                                |
| `src/routes/gst-reconciliation.routes.js`          | route table, middleware chain, route ordering             |
| `src/controllers/gst-reconciliation.controller.js` | request field allow-lists, status codes                   |
| `src/services/gst-reconciliation.service.js`       | serializer shapes, pagination, export, CSV escaping       |
| `src/models/ReconciliationRun.js`                  | run statuses, money fields, tolerances, lock/lease fields |
| `src/models/ReconciliationItem.js`                 | item statuses, disposition actions, match rules           |

Mounted at `/api/gst-reconciliation` (`app.js:307`).

---

## 1. Middleware applies to every route, but reads bypass the write gate

`routes/gst-reconciliation.routes.js` applies one `router.use` to all twelve routes:

```
authRequiredWithoutUsageTracking
requireFirmMember
requireFirmWriteAccess
requireFeatureFlag("gstReconciliation")
```

Two consequences the desktop must handle and must not paper over.

**Corrected 2026-08-13. This line previously claimed `requireFirmWriteAccess` guards the GETs too,
and that claim was copied into `docs/tds-health-contract.md` and `docs/engagements-contract.md`,
which have now also been corrected.** `requireFirmWriteAccess`
(`src/middleware/authorization.middleware.js:86`) opens with
`if (!MUTATING_METHODS.has(req.method)) return next();`, so every `GET` on this router bypasses the
function entirely and reaches the handler regardless of the caller's `memberAccess`. **A read-only
firm member can list runs, open a run, and read items.** Only the mutating verbs
(`POST`/`PUT`/`PATCH`/`DELETE`) reach the `READ_ONLY` check. This wrong claim already produced a real
defect: the desktop's navigation had hidden the GST module from read-only members entirely, when the
server would happily serve them the reads — fixed under ledger task T96. Offer a read-only member the
GST navigation entry and the read surfaces; withhold only the write controls.

**These refusals carry distinct meanings** and the wording must distinguish them, because the remedies differ:

| Cause                          | Status  | Honest wording                | Remedy                             |
| ------------------------------ | ------- | ----------------------------- | ---------------------------------- |
| `requireFirmMember` fails      | 403     | not a member of this firm     | be added to the firm               |
| `requireFirmWriteAccess` fails | 403     | your access is read-only      | an administrator changes your role |
| `requireFeatureFlag` fails     | **404** | not switched on for this firm | rollout, nothing the user can fix  |

> **Corrected 2026-08-06 (T24).** This table previously listed all three as `403`. The flag case is
> actually a **`404`**: `requireFeatureFlag` responds
> `{ ok: false, error: "Feature unavailable", featureFlag: "<flag>", requestId }`
> (`src/middleware/rollout.middleware.js:41`). The error was found while reading the same middleware
> for the TDS Health contract. It matters because on `GET /runs/:id` a `404` then means _either_ the
> run does not exist _or_ the feature is off, and the two are distinguishable only by the
> `featureFlag` field being present. A client that reads every `404` as "run not found" will tell a
> chartered accountant their run was deleted when the feature was merely switched off.

The flag is a rollout gate, never an authorization control. Read `GET /api/app-config` for `gstReconciliation` and hide the surface when it is off, rather than letting the user walk into a refusal.

---

## 2. Route table

Twelve routes. `GET /runs/:id` is declared **last**, after the more specific `/runs/:id/...` paths; preserve that order if the file is ever edited.

| Method | Path                       | Handler                 | Success                           |
| ------ | -------------------------- | ----------------------- | --------------------------------- |
| POST   | `/runs`                    | `createRun`             | **202**, or **200** when replayed |
| GET    | `/runs`                    | `listRuns`              | 200                               |
| GET    | `/runs/:id/items`          | `listItems`             | 200                               |
| PATCH  | `/runs/:id/items/:itemId`  | `updateItemDisposition` | 200                               |
| POST   | `/runs/:id/bulk`           | `updateItemsBulk`       | 200                               |
| GET    | `/runs/:id/3b-control`     | `showGstr3bControl`     | 200                               |
| GET    | `/runs/:id/supplier-chase` | `showSupplierChase`     | 200                               |
| GET    | `/runs/:id/activity`       | `listActivity`          | 200                               |
| POST   | `/runs/:id/recover-review` | `recoverRunReview`      | 200                               |
| POST   | `/runs/:id/lock`           | `lockRun`               | 200                               |
| GET    | `/runs/:id/export`         | `exportRun`             | 200, **`text/csv` not JSON**      |
| GET    | `/runs/:id`                | `showRun`               | 200                               |

---

## 3. Request bodies are strict allow-lists

`validateBody` **rejects unknown fields** with `400 Unknown fields: <names>`. This is the opposite of the audit routes, which silently dropped extras. A typo in a client field name fails loudly instead of being ignored, so the desktop must send exactly these names.

It also rejects a non-object body, and an empty body unless `allowEmpty` is set.

| Body                      | Allowed fields                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /runs`              | `clientId` `gstin` `period` `booksBatchId` `portalBatchId` `gstr3bBatchId` `revisionOf` `roundingToleranceMinor` `dateToleranceDays` `priorPeriodAdjustment` `assignedTo` |
| `PATCH .../items/:itemId` | `action` `candidatePortalRowId` `reason` `note` `ownerUserId` `chaseState` `taskId` `expectedDecisionVersion`                                                             |
| `POST .../bulk`           | `mode` `itemIds` `action` `payload` `previewToken` — and `payload` is itself validated against the disposition fields **minus `action`**                                  |
| `POST .../recover-review` | `operationId`, empty body allowed                                                                                                                                         |
| `POST .../lock`           | none; empty body required                                                                                                                                                 |

`period` must be `YYYY-MM`.

---

## 4. Enumerations

Bind to these exactly. Unknown values must render as the raw server string rather than being silently mapped to a default, so a server-side addition shows up instead of hiding.

**Run status** — 6 (`ReconciliationRun.js:3`), default `QUEUED`:
`QUEUED` `PROCESSING` `REVIEW` `LOCKING` `LOCKED` `FAILED`

**Item status** — 15 (`ReconciliationItem.js:3`):
`MATCHED` `MISSING_IN_2B` `MISSING_IN_BOOKS` `TAX_AMOUNT_MISMATCH` `TAXABLE_VALUE_MISMATCH` `DATE_MISMATCH` `GSTIN_MISMATCH` `DUPLICATE_IN_BOOKS` `DUPLICATE_IN_2B` `POSSIBLE_AMENDMENT` `AMBIGUOUS_MATCH` `INELIGIBLE_OR_BLOCKED` `DEFERRED_TO_NEXT_PERIOD` `USER_ACCEPTED_EXCEPTION` `NEEDS_REVIEW`

**Disposition action** — 10 (`ReconciliationItem.js:21`):
`ACCEPT_MATCH` `UNMATCH` `SUPPLIER_FOLLOW_UP` `BOOKS_CORRECTION` `PORTAL_CORRECTION` `MARK_INELIGIBLE` `DEFER` `ACCEPT_EXCEPTION` `ADD_NOTE` `ASSIGN`

The embedded `userDisposition.action` on the run model narrows to `ACCEPT_MATCH` and `UNMATCH` only. Do not mistake that narrower enum for the full action set the PATCH route accepts.

**Match rule** — `EXACT` `TOLERANT` `CANDIDATE` `NONE` `USER`
**Item resolution state** — `OPEN` `RESOLVED`
**Chase state** — `NONE` `MARKED` `OPENED` `COPIED` `REQUESTED`
**Review finalization state** — `CLEAN` `ITEM_PENDING` `BULK_PENDING` `SUMMARY_REPAIR_REQUIRED`

---

## 5. Money is integer minor units everywhere

`moneyField()` is `{ type: Number, default: 0, validate: Number.isSafeInteger }`, message _"must be a safe integer in the smallest currency unit"_.

Every amount ends in `Minor` and is paise: `igstMinor` `cgstMinor` `sgstMinor` `cessMinor` `totalTaxMinor` `taxableValueMinor` `reviewValueMinor`.

Map to a 64-bit integer, never to `double` or `float`. Divide by 100 only at the moment of display. `roundingToleranceMinor` default `100` therefore means one rupee.

`TaxHeadsSchema` = `igstMinor` `cgstMinor` `sgstMinor` `cessMinor` `totalTaxMinor`. It appears as `summary.eligible`, `summary.ineligible`, `summary.deferred`, and `priorPeriodAdjustment`.

---

## 6. `summary` is deliberately `null` while a review is in flight

`serializeRun` line 193:

```js
summary: reviewFinalization.summaryProvisional ? null : run.summary,
```

`summaryProvisional` is true whenever `reviewFinalization.state !== "CLEAN"`, which happens when an item transition is pending, a bulk operation is pending, or `run.summaryDirty` is set.

**This is the single most dangerous field in the contract.** A mapper that treats a missing `summary` as zero will render ₹0.00 of eligible ITC and a matched count of nought, and a reviewer could act on that. The desktop must model `summary` as genuinely absent and say the totals are being recalculated, naming the pending operation. It must never substitute zeros, and must not let the run be locked or exported from a provisional view.

`summary` when present: `totalItems` `matchedCount` `missingIn2bCount` `missingInBooksCount` `mismatchCount` `reviewCount` `reviewedCount` `eligible` `ineligible` `deferred` `reviewValueMinor`.

Note these counts live **inside** `summary`, not on the run root, so they vanish together.

### `reviewFinalization`

Always present on both list and detail:

```
state            CLEAN | ITEM_PENDING | BULK_PENDING | SUMMARY_REPAIR_REQUIRED
summaryProvisional  bool
recoverable      bool   -- summaryProvisional && run.status === "REVIEW"
operationId      string | null
kind             ITEM | BULK | null
action           string | null
itemId           string | null
affectedCount    number
startedAt        date | null
recoveryCommand  only when includeRecoveryCommand && recoverable
```

`recoveryCommand` is `{ method, path, body }` and is emitted **only by `GET /runs/:id`** (`getReconciliationRun` passes `includeRecoveryCommand: true`; the list does not). So the recovery affordance belongs on the run detail surface, and only when `recoverable` is true. When `summaryProvisional` is true but `recoverable` is false, the run is not in `REVIEW` and the user cannot fix it from the client - say so rather than offering a button that will fail.

---

## 7. Response shapes

Every response carries `ok: true` and `requestId`.

**`GET /runs`** → `{ ok, runs: [run], pagination: { page, limit, total, pages }, requestId }`

**`GET /runs/:id`** → `{ ok, run, requestId }`

**Run** (`serializeRun`, L166-206): `id` `clientId` `kind` `gstin` `period` `status` `revision` `reviewVersion` `activeGenerationAttempt` `rootRunId` `parentRunId` `sourceImports{booksBatchId,portalBatchId,gstr3bBatchId}` `matchingConfig` `priorPeriodAdjustment` `summary` `reviewFinalization` `jobId` `assignedTo` `reviewer` `reviewedAt` `lockedBy` `lockedAt` `lastError` `createdBy` `createdAt` `updatedAt`.

All ids are strings. `gstr3bBatchId`, `rootRunId`, `parentRunId`, `jobId`, `assignedTo`, `reviewer`, `lockedBy` are nullable. `lastError` defaults to `""`, not null.

`matchingConfig` carries `version` (default `"gst-match-v1"`), `roundingToleranceMinor`, `dateToleranceDays`. Display these as the settings the server actually applied.

**Item** (`serializeItem`, L208-252): `id` `runId` `generationAttempt` `booksRowId` `portalRowId` `candidatePortalRowIds[]` `candidateHistoryPortalRowIds[]` `booksSourceRow` `portalSourceRow` `supplierGstin` `invoiceNumberOriginal` `invoiceNumberNormalized` `documentType` `documentDate` `booksAmounts` `portalAmounts` `differences` `dateDifferenceDays` `status` `originalStatus` `matchRule` `autoAccepted` `resolutionState` `decisionVersion` `pendingTransition` `userDisposition` `chase` `taskId` `reviewedAt` `updatedAt`.

`pendingTransition` is `null` unless an operation is mid-flight, in which case it is `{ operationId, action, candidatePortalRowId, expectedDecisionVersion, startedAt }`. An item with a non-null `pendingTransition` must be shown as busy and must not accept a second disposition.

`documentDate` is a date. Deadlines and document dates are UTC days on the server; compare and render as UTC days.

---

## 8. Pagination, and the absence of a truncation flag

| List                  | `page`             | `limit` default | `limit` max |
| --------------------- | ------------------ | --------------- | ----------- |
| `GET /runs`           | 1, range 1..100000 | **25**          | **50**      |
| `GET /runs/:id/items` | 1                  | **50**          | see service |

Runs sort by `updatedAt: -1, _id: -1`.

There is **no `isTruncated` and no `hasMore` field** anywhere in this service - both greps return zero. The desktop must derive truncation itself from `pagination.total` against the page window, and render `N+` from `total` rather than waiting for a flag that does not exist.

`GET /runs/:id/items` filters on `status`, `supplierGstin`, `search`. Items are already scoped server-side by `activeItemScope`: current generation plus `isActive != false`, so superseded rows never reach the client and the desktop must not attempt to filter them again.

An unknown `status` value on either list is rejected with a domain error, so validate against the enums above before sending.

---

## 9. Concurrency, leases and locking

**Optimistic concurrency on items.** Each item carries `decisionVersion`. A disposition may send `expectedDecisionVersion`. A mismatch is a conflict and must be reported to the user as _someone else changed this row_, then the row refetched. Never retry silently and never overwrite.

**Run-level mutation lease.** `reviewMutationActive` and `reviewMutationExpiresAt` mark a run as being mutated. `pendingReviewTransition` and `bulkReviewOperation` hold the in-flight operation, keyed by a 64-hex `operationId`.

**Recovery.** `POST /runs/:id/recover-review` finishes or rolls back a stuck operation, but only while `recoverable` is true.

**Locking.** `POST /runs/:id/lock` moves the run through `LOCKING` to `LOCKED`, using `lockToken` (a UUID), `lockStartedAt`, `lockExpiresAt`, `lockedBy`, `lockedAt`.

Locking is a professional conclusion. It must stay behind an explicit human confirmation and must never be triggered as a side effect of navigation, refresh, or a bulk action.

**Bulk preview then commit.** `POST /runs/:id/bulk` takes `mode` and a `previewToken`. Treat the preview as required: show the affected count, then commit with the token. Do not commit a bulk change the user has not seen counted.

---

## 10. Export is CSV, and only from a locked run

`exportReconciliationRun` (L3062):

```js
if (run.status !== "LOCKED") {
  throw serviceError("Run must be locked before authoritative export", 409);
}
```

So a `409` here is expected and must be worded as _lock the run first_, not as a failure.

The response is **not JSON**: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<name>"`, and a header `X-Reconciliation-Item-Count` carrying the row count. The desktop HTTP layer must therefore treat this route as a byte/stream response, and should cross-check the written row count against that header.

**Formula injection is already handled server-side** (L3056):

```js
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
```

Leading `=`, `+`, `@`, `-` are prefixed with an apostrophe and quotes are doubled. The desktop must not re-escape this payload; writing the bytes through unchanged is correct. Any desktop-side CSV that the desktop itself generates still needs its own guard.

---

## 11. Consequences for the desktop, and a correction to ledger T14

**T14 as written is wrong and is rewritten in the ledger.** It assumed the desktop owns invoice-key normalization and tolerance comparison. The server owns both:

- `src/services/gst-normalization.service.js` exists, and `invoiceNumberNormalized` is a **stored, uppercased field on the item**.
- `src/services/gst-matching.service.js` exists, and `matchingConfig.version` defaults to `"gst-match-v1"`.
- `roundingToleranceMinor` (default 100, max 10000) and `dateToleranceDays` (default 3, max 31) are **run fields validated by the server**, sent at creation.
- The server publishes its verdict per item as `matchRule` and `dateDifferenceDays`.

Building a client-side matcher would duplicate a versioned server algorithm and drift from it, and two disagreeing verdicts on statutory ITC is a correctness failure, not a cosmetic one. The desktop's job is to **send tolerances, display the ones the server applied, and render the server's `matchRule` and `differences`** - not to recompute them.

**Checklist for the client work in T15-T21:**

1. Model money as 64-bit integer minor units.
2. Model `summary` as nullable and never substitute zeros.
3. Distinguish the three causes of `403`.
4. Read the `gstReconciliation` flag before showing the surface.
5. Send only allow-listed field names; a `400 Unknown fields` is a client bug.
6. Derive `N+` from `pagination.total`; no truncation flag exists.
7. Treat `/export` as a byte stream, expect `409` unless `LOCKED`, do not re-escape.
8. Keep `lock` and bulk commit behind explicit human confirmation.
9. Surface conflicts from `decisionVersion` rather than overwriting.
10. Render unknown enum values verbatim.
