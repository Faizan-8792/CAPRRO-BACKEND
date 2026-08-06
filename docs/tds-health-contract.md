# TDS Health API contract

Ledger task **T24**, board item **B3**. Verified by reading the server source, not inferred from
field names.

Sources read:

| File                                               | What it settles                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/app.js:24,417`                                | mount path                                                                |
| `src/routes/tds-health.routes.js`                  | route table, middleware chain, route ordering, per-route admin gates      |
| `src/controllers/tds-health.controller.js`         | request field allow-lists, status codes, response envelopes               |
| `src/services/tds-health.service.js`               | serializer shapes, pagination, action-plan tokens, export, CSV escaping   |
| `src/models/TdsHealthRun.js`                       | run statuses, statement types, quarters, money fields, calculation policy |
| `src/models/TdsHealthCheck.js`                     | check statuses, dimensions, states, severities, resolution and PAN enums  |
| `src/models/TdsHealthEvidenceLink.js`              | evidence pagination identity                                              |
| `src/models/TdsImportRow.js`                       | import kinds, filing/correction/certificate enums, date and money types   |
| `src/middleware/rollout.middleware.js:41`          | what a disabled flag actually returns                                     |
| `src/middleware/authorization.middleware.js:40,72` | the distinct authorization refusals                                       |

Mounted at `/api/tds-health` (`app.js:417`).

---

## 1. Corrections to what the ledger and the GST doc claim

**The ledger heading says 13 routes. There are 16.** Counted from `tds-health.routes.js`, which
declares 16 `router.<method>` calls and imports exactly 16 handlers. The full table is in §3.

**A disabled feature flag returns `404`, not `403`.** `requireFeatureFlag` responds
(`rollout.middleware.js:41`):

```json
{
  "ok": false,
  "error": "Feature unavailable",
  "featureFlag": "tdsHealth",
  "requestId": "..."
}
```

**This also means `docs/gst-reconciliation-contract.md` §1 is wrong**, where it lists
`requireFeatureFlag` as one of three causes of `403`. Both surfaces share this middleware, so the
same correction applies to GST. Anyone mapping GST from that table will mis-handle the flag case.

The practical consequence is sharper than it looks: on `GET /runs/:id` a `404` means _either_ the run
does not exist _or_ the whole feature is switched off. **The two are distinguishable only by the
`featureFlag` field**, which is present only in the flag case. A client that treats every `404` as
"run not found" will tell a chartered accountant their run was deleted when in fact the feature was
turned off for the firm.

`tdsHealth` is read **uncached** on every request (`rollout.middleware.js:12`, `fresh: true`), so a
rollout change takes effect immediately with no restart.

---

## 2. Middleware, and a fourth authorization refusal GST does not have

`tds-health.routes.js` applies one `router.use` to all 16 routes:

```
authRequiredWithoutUsageTracking
requireFirmMember
requireFirmWriteAccess
requireFeatureFlag("tdsHealth")
```

**`requireFirmWriteAccess` guards the GETs too**, exactly as in GST. A read-only firm member cannot
list runs or open one. Do not offer them a TDS navigation entry.

**Two routes carry an additional gate that GST has no equivalent of:**

```
router.post("/runs/:id/lock",   requireFirmAdmin, lockRun);
router.get("/runs/:id/export",  requireFirmAdmin, exportRun);
```

So there are **four** distinct refusals on this surface, and they need four different sentences:

| Cause                    | Status  | Server message             | Honest wording                               | Remedy                             |
| ------------------------ | ------- | -------------------------- | -------------------------------------------- | ---------------------------------- |
| `requireFirmMember`      | 403     | `Firm membership required` | not a member of this firm                    | be added to the firm               |
| `requireFirmWriteAccess` | 403     | `Firm membership required` | your access is read-only                     | an administrator changes your role |
| `requireFirmAdmin`       | 403     | `Firm admin only`          | only a firm administrator can lock or export | ask an administrator               |
| `requireFeatureFlag`     | **404** | `Feature unavailable`      | not switched on for this firm                | rollout, nothing the user can fix  |

Note the first two return the **same message string**, so the client cannot distinguish member from
read-only by the message. Decide from the caller's own known role, not by parsing the error.

**Consequence for the desktop: lock and export must be hidden, not merely disabled, for a
non-admin.** A member with write access can review and plan but can never lock or export, so
offering those two actions to them produces a `403` they can do nothing about.

---

## 3. Route table

16 routes. `GET /runs/:id` is declared **last**, after every more specific `/runs/:id/...` path.
Preserve that order if the file is edited.

| #   | Method | Path                                         | Handler                    | Success                      | Extra gate             |
| --- | ------ | -------------------------------------------- | -------------------------- | ---------------------------- | ---------------------- |
| 1   | POST   | `/runs`                                      | `createRun`                | **202**, or **200** replayed |                        |
| 2   | GET    | `/runs`                                      | `listRuns`                 | 200                          |                        |
| 3   | POST   | `/pan-verifications`                         | `verifyPanCompatibility`   | 200                          | legacy, see §7         |
| 4   | GET    | `/runs/:id/checks`                           | `listChecks`               | 200                          |                        |
| 5   | GET    | `/runs/:id/checks/:checkId/evidence`         | `listEvidence`             | 200                          |                        |
| 6   | PATCH  | `/runs/:id/checks/:checkId`                  | `resolveCheck`             | 200                          |                        |
| 7   | POST   | `/runs/:id/checks/:checkId/pan-verification` | `verifyPan`                | 200                          |                        |
| 8   | GET    | `/runs/:id/rows`                             | `listRows`                 | 200                          |                        |
| 9   | GET    | `/runs/:id/action-plan`                      | `showActionPlan`           | 200                          |                        |
| 10  | POST   | `/runs/:id/action-plan/preview`              | `previewActionPlan`        | 200                          |                        |
| 11  | POST   | `/runs/:id/action-plan/commit`               | `commitActionPlan`         | **201**, or **200** replayed |                        |
| 12  | POST   | `/runs/:id/create-tasks`                     | `createTasksCompatibility` | 200 preview / **201** commit | legacy, see §7         |
| 13  | GET    | `/runs/:id/history`                          | `listHistory`              | 200                          |                        |
| 14  | POST   | `/runs/:id/lock`                             | `lockRun`                  | 200                          | **`requireFirmAdmin`** |
| 15  | GET    | `/runs/:id/export`                           | `exportRun`                | 200, **`text/csv`**          | **`requireFirmAdmin`** |
| 16  | GET    | `/runs/:id`                                  | `showRun`                  | 200                          |                        |

Note the commit is **201**, where the equivalent GST bulk commit is 200. Do not assume 200 means
success on route 11.

---

## 4. Request bodies are strict allow-lists

`validateBody` (`controller:63`) **rejects unknown fields** with `400 Unknown fields: <names>`, and
rejects a non-object body and an empty body unless `allowEmpty` is set. Same discipline as GST.

| Body                           | Allowed fields                                                                                                                                                                    | Source                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `POST /runs`                   | `clientId` `tan` `financialYear` `quarter` `statementType` `deductionsBatchId` `challansBatchId` `statementsBatchId` `creditBatchId` `revisionOf` `correctionReason` `assignedTo` | `controller:18`        |
| `PATCH .../checks/:checkId`    | `action` `note` `expectedResolutionVersion`                                                                                                                                       | `controller:32`        |
| `POST .../pan-verification`    | `status` `sourceReference` `note` `expectedResolutionVersion`                                                                                                                     | `controller:37`        |
| `POST /pan-verifications`      | the four above **plus** `runId` `checkId`                                                                                                                                         | `controller:43`        |
| `POST .../action-plan/preview` | `checkIds` `ownerUserId` `dueDateISO` `priority` `reviewerNote` — **`previewToken` rejected**                                                                                     | `controller:48,231`    |
| `POST .../action-plan/commit`  | `checkIds` `ownerUserId` `dueDateISO` `priority` `reviewerNote` `previewToken`                                                                                                    | `controller:48`        |
| `POST .../create-tasks`        | same six as commit                                                                                                                                                                | `controller:48`        |
| `POST .../lock`                | none; empty body allowed                                                                                                                                                          | `controller` `lockRun` |

**Preview and commit share one allow-list but do not accept the same fields.** `previewActionPlan`
explicitly rejects `previewToken` with `400 previewToken is only accepted by action-plan commit`
(`controller:231`). Sending the token to preview is a client bug, not a retryable error.

Format constraints from the model, all enforced server-side:

- `tan` — `/^[A-Z]{4}[0-9]{5}[A-Z]$/`, uppercased (`TdsHealthRun.js:52`)
- `financialYear` — `/^\d{4}-\d{2}$/`, e.g. `2025-26` (`TdsHealthRun.js:53`). **Not `YYYY-MM`** like the GST `period`; do not reuse that validator.
- `quarter` — `Q1` `Q2` `Q3` `Q4`
- `statementType` — `24Q` `26Q` `27Q` `27EQ`
- `deductionsBatchId`, `challansBatchId`, `statementsBatchId` are **required**; `creditBatchId` is optional and defaults to `null` (`TdsHealthRun.js:14-19`)

---

## 5. Enumerations

Bind to these exactly, and render an unknown value **verbatim** rather than mapping it to a default,
so a server-side addition surfaces instead of hiding.

**Run status — 5** (`TdsHealthRun.js:3`), default `QUEUED`:
`QUEUED` `PROCESSING` `REVIEW` `LOCKED` `FAILED`

**There is no `LOCKING` state.** GST has a six-value set with a `LOCKING` lease phase; TDS does not.
Do not port a two-phase lock UI here — the run goes from `REVIEW` straight to `LOCKED`.

**Check status — 15** (`TdsHealthCheck.js:3`):
`RETURN_NOT_FILED` `RETURN_DUE_SOON` `DEPOSIT_MISSING` `SHORT_DEPOSIT_ESTIMATE`
`EXCESS_DEPOSIT_REVIEW` `CHALLAN_UNMAPPED` `DEDUCTION_NOT_REPORTED` `REPORTED_NOT_IN_REGISTER`
`PAN_MISSING` `PAN_FORMAT_INVALID` `PAN_PORTAL_VERIFICATION_PENDING`
`CREDIT_MISSING_IN_IMPORTED_26AS` `CORRECTION_REQUIRED` `CERTIFICATE_PENDING`
`NEEDS_PROFESSIONAL_REVIEW`

**Check dimension — 6** (`TdsHealthCheck.js:18`):
`DEDUCTION` `DEPOSIT` `STATEMENT` `PAN` `CREDIT` `CERTIFICATE`

**Check state — 4** (`TdsHealthCheck.js:26`), default `OPEN`:
`OPEN` `ACTION_PLANNED` `RESOLVED` `ACCEPTED`

**Severity — 3**, default `WARNING`: `INFO` `WARNING` `ERROR`

**Resolution action — 3 plus null** (`TdsHealthCheck.js:48`): `RESOLVE` `ACCEPT_REVIEW` `REOPEN`

**PAN verification method — 1 plus null** (`TdsHealthCheck.js:57`):
`MANUAL_OFFICIAL_PORTAL_RECORD`

That single value is the contract's statement that **the product does not scrape the portal**. It
records that a human read an official portal and what they read. Wording must not imply the server
verified a PAN with the department.

**PAN verification status — 2 plus null**: `VERIFIED` `FAILED`

**Action-plan priority — 4 plus empty string** (`TdsHealthCheck.js:71`): `LOW` `MEDIUM` `HIGH`
`URGENT`. **The default is `""`, not null.** Treat empty as "no priority set" and do not render it as
a priority.

**Import row kinds — 4** (`TdsImportRow.js:3`):
`TDS_DEDUCTIONS` `TDS_CHALLANS` `TDS_STATEMENTS` `TDS_26AS`

**Filing status — 4** (`TdsImportRow.js:10`): `NOT_FILED` `FILED` `CORRECTION_PENDING` `CORRECTED`
**Correction status — 3** (`TdsImportRow.js:16`): `NONE` `PENDING` `COMPLETED`
**Certificate status — 3** (`TdsImportRow.js:17`): `NOT_TRACKED` `PENDING` `ISSUED`
**Certificate type — 2 plus empty**: `FORM_16` `FORM_16A`

An invalid `status` on `GET /runs` is rejected with `400 Invalid TDS run status`
(`service:1036`), so validate before sending.

---

## 6. Money, dates, and the fields that must not be read as numbers

**Money is integer minor units — paise.** Validator is
`{ validator: Number.isSafeInteger, message: "{PATH} must be a safe integer in the smallest currency unit" }`
(`TdsHealthRun.js:8`, `TdsHealthCheck.js:29`).

Run summary: `deductedMinor` `depositedMinor` `reportedMinor` `importedCreditMinor`
`estimatedGapMinor`.
Check: `expectedMinor` `actualMinor` `differenceMinor`.
Import row: `amountPaidMinor` `deductedMinor` `surchargeMinor` `cessMinor` `depositedMinor`
`reportedMinor` `creditedMinor`.

**Map every one to a 64-bit integer.** A TDS deduction total for a mid-sized firm passes
₹2.14 crore routinely, and a 32-bit read returns null and then a model default of zero.

**`differenceMinor` is signed.** It is a difference, so it is negative for an excess deposit —
`EXCESS_DEPOSIT_REVIEW` exists precisely for that case. Do not map it to an unsigned type and do not
render it with an assumed sign.

**Import-row money is nullable, run and check money is not.** `TdsImportRow.js:20` uses
`value == null || Number.isSafeInteger(value)`, so a row amount can legitimately be `null`, meaning
_the source did not state it_. The run summary and check amounts default to `0`. So a `null` row
amount must render as unknown, never as ₹0.00.

**Dates on import rows are ISO calendar-day strings, not timestamps.** `transactionDate`,
`challanDate`, `filedDate`, `creditDate` are `String` with validator
`/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/` and default `""` (`TdsImportRow.js:24,45`).

This differs from GST, where `documentDate` is a `Date`. **Parse these as calendar days and do not
convert a timezone** — there is no instant to convert, and converting would move a statutory date
across a day boundary. `actionPlan.dueDateISO` is likewise a string with default `""`.

By contrast `reviewedAt`, `lockedAt`, `plannedAt`, `resolvedAt`, `verifiedAt`, `createdAt`,
`updatedAt` and `occurredAt` are real timestamps.

---

## 7. The two legacy compatibility routes, and why the desktop should not use them

**`POST /pan-verifications`** (route 3) is `verifyPanCompatibility`. It takes `runId` and `checkId`
**in the body** and forwards to the same `recordPanVerification` service as route 7, which takes them
in the path. Identical behaviour, older shape.

**`POST /runs/:id/create-tasks`** (route 12) is `createTasksCompatibility`, and it is
**mode-switching on the presence of `previewToken`**:

- `previewToken` absent → runs the **preview** and returns `200` with `{ ok, mode: "PREVIEW", result, requestId }`
- `previewToken` present → runs the **commit** and returns `201` (or `200` replayed) with `{ ok, mode: "COMMIT", result, requestId }`

So one route, two verbs, distinguished by a field being present. It also adds a `mode` field that the
canonical routes do not return.

**Use routes 7, 10 and 11.** The compatibility pair exists for the extension's older calls; building
the desktop on them would bind it to a shape the backend intends to retire, and the mode-switch is
easy to get wrong — omit the token by accident on a commit and you silently get a preview with a
`200`, which looks like success.

---

## 8. The action-plan preview/commit handshake, and a field-name trap

`previewTdsActionPlan` (`service:1525`) returns:

```js
{
  (plan, planFingerprint, commitToken, expiresInSeconds);
} // expiresInSeconds === 900
```

The commit's allow-list accepts **`previewToken`** (`controller:48`), and `commitTdsActionPlan` reads
`previewToken` (`service:1580`).

**The server returns the token as `commitToken` and requires it back as `previewToken`.** Echoing it
under the name it arrived with fails with `400 Unknown fields: commitToken`. This is the single
easiest mistake to make on this surface, and the error names a field the client never chose to send,
so it reads like a server fault.

The token is HMAC-SHA256 over the plan fingerprint, compared with `timingSafeEqual`
(`service:141,153,157`), and lives **15 minutes** (`ACTION_TOKEN_TTL_MS`, `service:38`).

The fingerprint covers `checkVersion` and, per check, `checkId` `itemKey` `checkVersion`
`resolutionVersion` `ownerUserId` `dueDateISO` `priority` `reviewerNote` (`service:1516`). So
**changing any planned field after previewing invalidates the token**, and so does anyone else
resolving one of the checks. On mismatch:

```
409 Action-plan inputs or checks changed after preview; preview again
```

That must be worded as _the plan moved on, preview again_ — not as a failure and not as a retry. The
commit re-derives the fingerprint inside its transaction and raises
`409 Action-plan checks changed during commit` if it shifted mid-flight (`service:1614`).

`checkIds` must be **1 to 100** (`ACTION_PLAN_MAX_CHECKS`, `service:37`); outside that range is
`400 Action plan requires 1 to 100 check IDs`.

**If the signing secret is unset the route returns `503 TDS action-plan signing is unavailable`**
(`service:136`). That is an operational fault, not user error, and there is no client-side remedy —
word it as temporarily unavailable.

**Committing creates Task records.** The commit returns `{ taskIds, plannedCount, replayed }` and
writes an activity event `TDS_ACTION_PLAN_COMMITTED`. So a TDS action plan materialises rows in the
task surface; the desktop should say so before committing, because the user is creating work items
for colleagues.

---

## 9. Response envelopes are not uniform — model them per route

Every response carries `ok: true` and `requestId`. What surrounds the payload does not.

| Route                                                           | Wire shape                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /runs`                                                     | `{ ok, runs, pagination, requestId }`                                     |
| `GET /runs/:id`                                                 | `{ ok, run, requestId }`                                                  |
| `GET .../checks`, `.../evidence`, `.../rows`                    | `{ ok, <collection>, pagination, requestId }`                             |
| `GET .../action-plan`                                           | `{ ok, run, items, pagination, requestId }` — **spread**                  |
| `POST .../action-plan/preview`                                  | `{ ok, result, requestId }` — **nested**                                  |
| `POST .../action-plan/commit`                                   | `{ ok, result, requestId }` — **nested**                                  |
| `POST .../create-tasks`                                         | `{ ok, mode, result, requestId }` — nested, plus `mode`                   |
| `GET .../history`                                               | `{ ok, history, requestId }` where `history` is `{ revisions, activity }` |
| `PATCH .../checks/:checkId`, `.../pan-verification`, `.../lock` | spread                                                                    |

**`GET .../action-plan` spreads while `POST .../preview` and `POST .../commit` nest under `result`.**
Three routes on the same noun, two envelope shapes. Read `result.commitToken` on preview but
`items` at the top level on the read.

`GET .../rows` additionally returns **`sourceAvailable: false`** with an empty page when the run has
no batch for the requested `kind` (`service:1170`). That is a distinct state from "no rows matched"
and must be worded as _this source was not imported_, not as an empty result.

---

## 10. `summary` is never null here, but the list and the detail can disagree

**Unlike GST, `summary` is never `null`.** `SummarySchema` defaults every field to `0` and the run
defaults `summary` to `{}` (`TdsHealthRun.js:68`), and `serializeRun` emits
`summaryOverride || run.summary` (`service:247`). So there is no provisional-null case to model.

But the two read routes do not produce the same numbers:

- **`GET /runs`** (`service:1049`) serialises the **stored** `run.summary` for every row.
- **`GET /runs/:id`** (`service:1054`) recomputes when status is `REVIEW` or `LOCKED`: it calls
  `stateCounts` and merges `{ ...run.summary, ...counts }`, so the **money totals are stored** while
  the **four check counts are live**.

`stateCounts` (`service:978`) aggregates checks by `state`, so the recomputed fields are
`openChecks`, `actionPlannedChecks`, `resolvedChecks` and `totalChecks`.

**Treat the detail route as authoritative for counts and never show a list count beside a detail
count as though they agree.** A list badge saying 12 open checks next to a detail view saying 9 is a
stale-list artefact, and to a reviewer it looks like the product cannot count.

`GET /runs/:id` can also fail for a run that exists: if the status is `REVIEW` or `LOCKED` but no
attempt is published, `requirePublishedAttempt` raises
`409 TDS health checks are not published for this run` (`service:190`).

---

## 11. Checks do not exist until the run reaches REVIEW

`publishedAttempt` returns `null` unless status is `REVIEW` or `LOCKED` (`service:185`). Every
check-bearing route calls `requirePublishedAttempt`, so `checks`, `evidence`, `rows`, `action-plan`,
`export` and `history` all raise **409** on a run that is `QUEUED`, `PROCESSING` or `FAILED`.

`serializeRun` exposes exactly the flag needed to avoid walking into that:

```js
checksPublished: Boolean(publishedAttempt(run) && run.checkVersion > 0);
```

**Gate the checks UI on `checksPublished`** rather than calling and handling a `409`. A `409` on
first navigation reads as a fault; an honest "the run is still processing" does not.

Two serialiser details that will mislead if taken at face value:

- **`generationAttempt` on the wire is `run.activeGenerationAttempt`**, not the model's
  `generationAttempt` field (`service:244`). The model has both. Do not assume the wire name maps to
  the same-named column.
- **`rootRunId` is never null.** It falls back to the run's own id (`service:237`). So it cannot be
  used to test whether a run is a correction revision — use `parentRunId`, which is genuinely
  nullable.

---

## 12. Pagination, and there is still no truncation flag

`MAX_PAGE_SIZE = 100` for every list (`service:35`), unlike GST where runs capped at 50.

| List                  | `page`             | `limit` default | `limit` max | Sort                                        |
| --------------------- | ------------------ | --------------- | ----------- | ------------------------------------------- |
| `GET /runs`           | 1, range 1..100000 | **50**          | 100         | `createdAt: -1, _id: -1`                    |
| `GET .../checks`      | 1                  | **100**         | 100         | see service                                 |
| `GET .../evidence`    | 1                  | **100**         | 100         | `ordinal, _id`                              |
| `GET .../rows`        | 1                  | **100**         | 100         |                                             |
| `GET .../action-plan` | 1                  | **100**         | 100         | `severity, dimension, status, _id`          |
| `GET .../history`     | —                  | **100**         | 100         | `occurredAt: -1` — **no pagination object** |

Runs sort by **`createdAt`**, where GST sorts by `updatedAt`. A TDS list is creation-ordered and will
not reshuffle when a run is edited.

**`boundedInteger` silently falls back** (`service:53`): a non-integer, negative or over-max `limit`
is not rejected, it is replaced by the default and clamped. So the client cannot detect a rejected
page size — **always read `pagination.limit` back** rather than assuming the requested value applied.

**No truncation flag exists**, same as GST. Derive `N+` from `pagination.total`.

`GET .../history` returns a plain `activity` array with **no pagination object at all** — only a
`limit`. So the client cannot tell whether history was truncated. Render the list as _most recent N_
rather than implying completeness.

**`sourceRows` on a check is itself a capped preview.** The model allows 1 to 100 entries
(`TdsHealthCheck.js:106-109`) while `sourceEvidenceCount` carries the true total. When
`sourceEvidenceCount > sourceRows.length`, show `sourceRows.length` of `sourceEvidenceCount` and
page the remainder through `GET .../checks/:checkId/evidence`. Do not present the capped array as the
full evidence set. Note `listEvidence` raises
`409 TDS source evidence manifest count no longer matches` if the stored count and the links
disagree (`service:1138`).

---

## 13. Concurrency and conflict semantics

**Optimistic concurrency on checks.** `resolution.version` is the token
(`TdsHealthCheck.js:47`), exposed as `resolution.version` and sent back as
`expectedResolutionVersion` on both `PATCH .../checks/:checkId` and `.../pan-verification`. On
mismatch:

```
409 TDS check changed; reload before saving          (service:1275)
409 PAN check changed or is not pending; reload...   (service:1374)
```

Report these as _someone else changed this check_, refetch, and never retry silently or overwrite.

**State-machine refusals are distinct from concurrency refusals** and need different words:

| `409` message                                                                    | Meaning                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------- |
| `Check state does not allow this transition`                                     | the action is invalid from the current state |
| `A check with a linked action task cannot be reopened here`                      | REOPEN is blocked while a task exists        |
| `Action plans can only be created during review`                                 | run is not in `REVIEW`                       |
| `An existing action plan uses different owner, date, priority, or reviewer note` | re-planning with different inputs            |
| `Only a review-state run can be locked`                                          | lock attempted outside `REVIEW`              |
| `Authoritative export requires a locked reviewed revision`                       | export before lock                           |
| `Only a locked run can create a correction revision`                             | `revisionOf` pointing at an unlocked run     |
| `Selected TAN does not match the client's governed profile`                      | TAN/client mismatch at creation              |

Two `422`s that are **not** conflicts and must not be worded as such: `<label> is not an active
member of this firm` for `assignedTo`/`ownerUserId` (`service:357`), and
`<kind> batch is not a completed import for this TDS context` (`service:388`).

**Locking is a professional conclusion.** `lockTdsHealthRun` (`service:1739`) requires `REVIEW` and
is admin-only. It must stay behind explicit human confirmation and must never fire as a side effect
of navigation or refresh. It is idempotent — a second lock returns `replayed: true`, so a retry after
an unknown timeout is safe.

**Correction revisions** are a lineage, not an edit: `revisionOf` on a **locked** run creates a child
with `parentRunId` set and `revision` incremented, guarded by three unique indexes
(`TdsHealthRun.js:82,90,94`). One child per parent — a second attempt hits
`unique_tds_run_child`.

---

## 14. Export is CSV, admin-only, and carries a BOM

`exportTdsHealthRun` (`service:1836`) requires `status === "LOCKED"`, else
`409 Authoritative export requires a locked reviewed revision`. Expected, and worded _lock the run
first_.

Response is **not JSON**:

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="tds-health-<FY>-<Q>-<type>-r<revision>.csv"`
- `X-TDS-Health-Check-Count` and `X-TDS-Health-Evidence-Count` — **two** count headers, where GST has one

**The payload begins with a UTF-8 BOM and uses CRLF line endings** (`service:1923`):

```js
content: `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
```

Read the body as **bytes**. Decoding to a string strips the BOM, and Excel then reads a UTF-8 CSV
without one as the local ANSI code page and mangles deductee names. This is the same trap the GST
export has, and it is worse here because deductee names are the primary identifier.

**Formula injection is already handled server-side** (`service:1829`):

```js
if (isText && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
```

Note this is **stricter than the GST guard**: it allows leading whitespace before the dangerous
character, so `" =cmd"` is caught too. Pass the bytes through unchanged; re-escaping doubles the
apostrophes.

**The CSV is two row types in one file**, distinguished by the first column `row_type`: `SUMMARY`
rows then `CHECK` rows, over a 31-column header. A reader that assumes one record shape per file will
misparse it.

**And the export refuses to assert a figure it does not have.** When no credit batch was imported,
the row is labelled `IMPORTED_CREDIT_NOT_PROVIDED` with an **empty** amount and the note:

> `Optional 26AS/TRACES source was not provided; no imported-credit amount is asserted`

Every `SUMMARY` row also carries `estimate=true`, `professional_confirmed=false` and the note
`Estimate; professional confirmation not recorded`. The server is deliberately declining to state a
number it cannot support, and the desktop must not fill that gap with a zero.

---

## 15. Everything here is an estimate until a human says otherwise

`calculationPolicy` is **required** on every run (`TdsHealthRun.js:69`) and carries:

| Field                   | Default     | Meaning                                    |
| ----------------------- | ----------- | ------------------------------------------ |
| `version`               | —           | the rule version that produced the figures |
| `sourceLabel`           | —           | what the numbers were derived from         |
| `sourceReference`       | —           | the citation for that source               |
| `estimate`              | **`true`**  | the figures are estimates                  |
| `professionalConfirmed` | **`false`** | no professional has confirmed them         |
| `ratesApplied`          | **`false`** | statutory rates were **not** applied       |

Each check repeats it in `calculation` with the same defaults (`TdsHealthCheck.js:115`).

**This is the most consequential thing in the contract for user-facing copy.** A short-deposit figure
here is an arithmetic gap between imported sources, not a computed statutory liability —
`ratesApplied` is false, so no TDS rate was applied to derive it. The check status
`SHORT_DEPOSIT_ESTIMATE` says so in its own name.

So the desktop must:

- label these figures as **estimates**, sourced from `calculationPolicy.sourceLabel`, and never as a liability, a demand, or an amount payable;
- show `professionalConfirmed: false` as _not yet reviewed by a professional_, never omit it;
- never imply rates were applied while `ratesApplied` is false;
- cite `sourceReference` rather than synthesising a section or circular. Where a standard or section is absent, render `No standard cited`.

`NEEDS_PROFESSIONAL_REVIEW` exists as a check status precisely because the server refuses to
conclude. Present it as the server's request for judgement, not as a defect.

---

## 16. Checklist for the desktop work this unblocks

1. Model money as 64-bit integer minor units; treat `differenceMinor` as **signed**.
2. Treat import-row amounts as nullable — `null` means the source did not state it, never ₹0.00.
3. Parse `transactionDate` / `challanDate` / `filedDate` / `creditDate` / `dueDateISO` as calendar-day **strings**; convert no timezone.
4. Distinguish four refusals: member, read-only, **admin-only**, and flag-off, and remember flag-off is a **404** carrying `featureFlag`.
5. Hide lock and export from non-admins rather than disabling them.
6. Gate the checks UI on `checksPublished`; do not discover unreadiness through a `409`.
7. Prefer `GET /runs/:id` counts over list counts, and never display both as if they agree.
8. Send the preview token back as **`previewToken`**, not as the `commitToken` you received.
9. Re-preview on `409 ...preview again`; do not retry the commit.
10. Say that committing an action plan **creates tasks** before committing.
11. Read the export as bytes to preserve the BOM; do not re-escape; parse two `row_type`s.
12. Read `pagination.limit` back; derive `N+` from `total`; render `sourceRows.length` of `sourceEvidenceCount`.
13. Handle `sourceAvailable: false` as _not imported_, distinct from empty.
14. Label every figure an estimate, surface `professionalConfirmed: false`, never imply rates were applied.
15. Render unknown enum values verbatim.
16. Use the canonical routes, not `POST /pan-verifications` or `POST .../create-tasks`.
