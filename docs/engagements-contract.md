# Engagements and Working Papers — backend contract

Read from source for ledger task **T37** (board item **B5**). Every claim names a file and line, and
every citation was machine-checked with `node tools/verify-doc-citations.mjs
docs/engagements-contract.md`.

Third in the series after `docs/gst-reconciliation-contract.md` (T13),
`docs/tds-health-contract.md` (T24) and `docs/notices-cases-contract.md` (T31).

**The route count is wrong again.** The ledger and the coordination board both say 12. The router
declares **16**. That is three phase headings in a row with a wrong count, so treat every remaining
one as unverified.

**The headline finding is not a defect, it is a shape.** `/api/engagements` is one mount point over
**two surfaces built to different rules** — engagements use cursor pagination with a version-guarded
snapshot, working papers use classic page/skip. A client that models one and reuses it for the other
will be wrong on half the routes. §6 and §7.

---

## 1. Route table

Mounted at `/api/engagements` (`src/app.js:456`). Sixteen handlers in
`src/routes/engagement.routes.js`.

Working-paper routes are declared **first** (`src/routes/engagement.routes.js:39-52`) so
`/working-papers` cannot be swallowed by `/:id`, and `GET /templates` is declared **before**
`GET /:id` (`src/routes/engagement.routes.js:57-59`) for the same reason. **Both orderings are
load-bearing. Do not reorder.**

| #   | Method  | Path                                                                         | Handler                           | Line | Success         |
| --- | ------- | ---------------------------------------------------------------------------- | --------------------------------- | ---- | --------------- |
| 1   | `POST`  | `/working-papers`                                                            | `createWorkingPaper`              | 39   | `201`           |
| 2   | `GET`   | `/working-papers`                                                            | `listWorkingPapers`               | 40   | `200`           |
| 3   | `GET`   | `/working-papers/:id/export`                                                 | `exportWorkingPaper`              | 41   | `200`           |
| 4   | `GET`   | `/working-papers/:id`                                                        | `showWorkingPaper`                | 42   | `200`           |
| 5   | `POST`  | `/working-papers/:id/rows`                                                   | `addWorkingPaperRow`              | 43   | `201`           |
| 6   | `POST`  | `/working-papers/:id/analyses`                                               | `generateWorkingPaperAnalysis`    | 44   | **`201`/`202`** |
| 7   | `POST`  | `/working-papers/:id/analyses/:analysisId/proposals/:proposalId/disposition` | `dispositionWorkingPaperProposal` | 49   | `200`           |
| 8   | `POST`  | `/`                                                                          | `createEngagementRecord`          | 55   | `201`           |
| 9   | `GET`   | `/`                                                                          | `listEngagementRecords`           | 56   | `200`           |
| 10  | `GET`   | `/templates`                                                                 | `listTemplates`                   | 57   | `200`           |
| 11  | `GET`   | `/:id/export`                                                                | `exportEngagement`                | 58   | `200`           |
| 12  | `GET`   | `/:id`                                                                       | `showEngagement`                  | 59   | `200`           |
| 13  | `PATCH` | `/:id`                                                                       | `patchEngagement`                 | 60   | `200`           |
| 14  | `POST`  | `/:id/findings`                                                              | `createFinding`                   | 61   | `201`           |
| 15  | `PATCH` | `/:id/findings/:findingId`                                                   | `patchFinding`                    | 62   | `200`           |
| 16  | `POST`  | `/:id/review`                                                                | `reviewEngagementRecord`          | 63   | `200`           |

### 1.1 The 202 that is not a success

Route 6 is the only route on any surface documented so far that returns **two different success
codes**:

```js
const status = result.providerCallState === "PROCESSING_UNKNOWN" ? 202 : 201;
```

`src/controllers/audit-working-paper.controller.js:78`.

**A `202` means the provider call outcome is genuinely unknown** — the analysis record exists and is
in `PROCESSING`, but whether the external model ever answered is not established. A client that
treats `2xx` as "analysis ready" will present an empty or partial analysis as complete. Word a `202`
as _in progress, outcome not yet known_, and re-read the detail route rather than trusting the body.

`providerCallState` is `"PROCESSING_UNKNOWN"` or `"COMPLETED"`
(`src/services/audit-working-paper.service.js:1269-1270`).

---

## 2. Authorization — one flag, then a second one

Every one of the sixteen routes carries, via `router.use`
(`src/routes/engagement.routes.js:32-37`):

`authRequired` → `requireFirmMember` → `requireFirmWriteAccess` →
`requireFeatureFlag("assuranceEngagements")`

The seven working-paper routes carry **an additional** `requireFeatureFlag("auditWorkingPapers")`
(`src/routes/engagement.routes.js:30`), applied per route.

Two consequences the client must handle:

1. **`requireFirmWriteAccess` guards the GETs too.** A read-only firm member cannot even list
   engagements. Unlike the cases surface, there is no read-only escape hatch anywhere here.
2. **A working-paper route needs both flags.** The two rejections must read differently: one says
   assurance engagements are not switched on for this firm, the other says AI working papers are
   not. `WORKING_PAPER_FLAGS` names both (`src/services/audit-working-paper.service.js:29`).

### 2.1 A disabled flag is `404`, not `403`

> **Corrected 2026-08-06.** This section previously listed both feature flags among the causes of
> `403`. **A disabled flag is a `404`**, and the body names which flag:
> `{ ok: false, error: "Feature unavailable", featureFlag: "<flag>", requestId }`
> (`src/middleware/rollout.middleware.js:41`). Executed and confirmed for the shared middleware by
> `tests/case-ocr-route-behaviour.mjs`.
>
> `docs/tds-health-contract.md` already recorded this correction under T24, which also corrected
> `docs/gst-reconciliation-contract.md`. I reintroduced the error here and in
> `docs/notices-cases-contract.md`. Citation checking verifies line numbers, not status codes, which
> is why this needed executing rather than reviewing.

**So this surface returns `404` for two different reasons**, and a client must tell them apart from
the body rather than the status: a disabled module (`featureFlag` present) versus a genuinely missing
record (`featureFlag` absent). Wording a disabled module as "no longer exists" tells a whole firm
their data is gone.

Because the working-paper routes carry **both** flags, a `404` there can mean either module is off —
read `featureFlag` to know which, and word it accordingly.

### 2.2 `403` has two distinct causes

| Cause                              | Where                                    |
| ---------------------------------- | ---------------------------------------- |
| Member lacks firm write access     | `src/routes/engagement.routes.js:35`     |
| Actor is not the assigned reviewer | `src/services/engagement.service.js:348` |

The second is the only `403` thrown from a service rather than middleware, and it **is** public
(`ENGAGEMENT_REVIEWER_REQUIRED`), so the server's own sentence reaches the user. The write-access
refusal is generic. Do not collapse them into one message.

Underneath the write-access check, `src/middleware/authorization.middleware.js` distinguishes a
non-member (`"Firm membership required"`) from a removed member
(`"You are no longer a member of this workspace"`), so in practice a client may see either string.

Note the neighbouring `ENGAGEMENT_REVIEWER_ROLE_REQUIRED` is a **`400`, not a `403`**
(`src/services/engagement.service.js:335`) — naming a reviewer who is not a `FIRM_ADMIN` is a bad
request, not a denial. It is also public.

---

## 3. Unknown fields are rejected, and the rejection is genericised

Every write body is a **strict allow-list**. An unknown field is **rejected**, not dropped
(`src/services/engagement.service.js:154`, `src/services/audit-working-paper.service.js:90`).

| Body                             | Allowed fields | Source                                           |
| -------------------------------- | -------------- | ------------------------------------------------ |
| `POST /`                         | 14             | `src/services/engagement.service.js:46`          |
| `PATCH /:id`                     | 23             | `src/services/engagement.service.js:62`          |
| `POST /:id/findings`             | 6              | `src/services/engagement.service.js:87`          |
| `PATCH /:id/findings/:findingId` | 19             | `src/services/engagement.service.js:95`          |
| `POST /:id/review`               | 7              | `src/services/engagement.service.js:115`         |
| `POST /working-papers`           | 6              | `src/services/audit-working-paper.service.js:43` |
| `POST .../rows`                  | 9              | `src/services/audit-working-paper.service.js:51` |
| `POST .../analyses`              | 4              | `src/services/audit-working-paper.service.js:62` |
| `.../disposition`                | 6              | `src/services/audit-working-paper.service.js:68` |
| `editedFinding` object           | 4              | `src/services/audit-working-paper.service.js:76` |

**But `UNSUPPORTED_ENGAGEMENT_FIELD` and `UNSUPPORTED_AUDIT_WORKING_PAPER_FIELD` are not public**
(`src/services/engagement.service.js:158`,
`src/services/audit-working-paper.service.js:94`), so the message naming the offending field is
replaced in production by "Some submitted information could not be accepted. Review the form and try
again." The client gets no indication which field was wrong.

That is survivable — the audience for that message is a client developer, and the allow-lists are
right here — but it is worth knowing that you will debug this against a dev server, not production.
Contrast `IMPORT_MAPPING_UNSUPPORTED_FIELDS`, which **is** public and ships a fixed message plus a
`details.fields` array (`src/app.js:104`), showing the pattern exists when someone wants it.

---

## 4. Error codes

This surface has by far the largest share of the server's public allow-list: **20 of the 38 public
codes** are thrown here. That is the opposite of the notices surface, where none were. The coverage
looks deliberate, and I found no message on it that breaks the user-facing copy rules — see §14 for
the check that now enforces that.

### 4.1 Public — the server's own wording reaches the user

| Code                                        | Status | Where                                              |
| ------------------------------------------- | ------ | -------------------------------------------------- |
| `ENGAGEMENT_REVIEWER_REQUIRED`              | `403`  | `src/services/engagement.service.js:348`           |
| `ENGAGEMENT_REVIEWER_ROLE_REQUIRED`         | `400`  | `src/services/engagement.service.js:335`           |
| `INVALID_ENGAGEMENT_TRANSITION`             | `409`  | `src/services/engagement.service.js:594`           |
| `INVALID_FINDING_TRANSITION`                | `409`  | `src/services/engagement.service.js:601`           |
| `ENGAGEMENT_REVISION_CONFLICT`              | `409`  | `src/services/engagement.service.js:496`           |
| `ENGAGEMENT_SNAPSHOT_CHANGED`               | `409`  | `src/services/engagement.service.js:1133`          |
| `ENGAGEMENT_COMPLETE_READ_ONLY`             | `409`  | `src/services/engagement.service.js:1368`          |
| `ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED`       | `409`  | `src/services/engagement.service.js:528`           |
| `ENGAGEMENT_TEMPLATE_REVIEW_DRAFT_ONLY`     | `409`  | `src/services/engagement.service.js:2074`          |
| `ENGAGEMENT_REVIEWER_REASSIGNMENT_CONFLICT` | `409`  | `src/services/engagement.service.js:1395`          |
| `ENGAGEMENT_FINDING_REVIEW_CONFLICT`        | `409`  | `src/services/engagement.service.js:1863`          |
| `ENGAGEMENT_CLOSURE_INCOMPLETE`             | `409`  | `src/services/engagement.service.js:945`           |
| `MUTATION_RECEIPT_LIMIT`                    | `409`  | `src/services/engagement.service.js:262`           |
| `AUDIT_AI_CONSENT_REQUIRED`                 | `400`  | `src/services/audit-working-paper.service.js:1090` |
| `AUDIT_WORKING_PAPER_REVISION_CONFLICT`     | `409`  | `src/services/audit-working-paper.service.js:294`  |
| `AUDIT_ANALYSIS_REVISION_CONFLICT`          | `409`  | `src/services/audit-working-paper.service.js:304`  |
| `AUDIT_WORKING_PAPER_ROW_KEY_EXISTS`        | `409`  | `src/services/audit-working-paper.service.js:824`  |
| `AUDIT_PROPOSAL_ALREADY_DECIDED`            | `409`  | `src/services/audit-working-paper.service.js:1524` |
| `AUDIT_SOURCE_ROW_CHANGED`                  | `409`  | `src/services/audit-working-paper.service.js:1346` |

### 4.2 Not public — genericised in production

Engagements: `INVALID_ENGAGEMENT_INPUT` `400` (`:149`), `INVALID_ENGAGEMENT_REVISION` `400`
(`:169`), `INVALID_PAGINATION` `400` (`:177`), `UNSUPPORTED_ENGAGEMENT_FIELD` `400` (`:158`),
`INVALID_ENGAGEMENT_CURSOR` `400` (`:226`), `ENGAGEMENT_NOT_FOUND` `404` (`:464`),
`ENGAGEMENT_FINDING_NOT_FOUND` `404` (`:1702`), `ENGAGEMENT_ACTIVITY_CONFLICT` `409` (`:441`),
`ENGAGEMENT_FINGERPRINT_LIMIT` `409` (`:887`), `ENGAGEMENT_FINDING_AI_PROVENANCE_CONFLICT` `409`
(`:1768`), `ENGAGEMENT_FINDING_AI_LINEAGE_LIMIT` `409` (`:1775`), `ENGAGEMENT_EXPORT_LIMIT` `413`
(`:2178`), `ENGAGEMENT_EXPORT_SERIALIZATION_ERROR` `500` (`:2200`),
`ENGAGEMENT_PUBLICATION_CONTEXT_REQUIRED` `500` (`:284`),
`ENGAGEMENT_EXPORT_SNAPSHOT_UNAVAILABLE` `503` (`:2276`).

Working papers: `INVALID_AUDIT_WORKING_PAPER_INPUT` `400` (`:85`),
`INVALID_AUDIT_WORKING_PAPER_REVISION` `400` (`:105`), `INVALID_PAGINATION` `400` (`:118`),
`UNSUPPORTED_AUDIT_WORKING_PAPER_FIELD` `400` (`:94`), `INVALID_AUDIT_SOURCE_ROW` `400` (`:1208`),
`INCOMPATIBLE_PRIOR_WORKING_PAPER` `400` (`:598`), `AUDIT_WORKING_PAPER_NOT_FOUND` `404` (`:266`),
`AUDIT_ANALYSIS_NOT_FOUND` `404` (`:1495`), `AUDIT_PROPOSAL_NOT_FOUND` `404` (`:1521`),
`AUDIT_WORKING_PAPER_READ_ONLY` `409` (`:277`), `AUDIT_AI_RESERVATION_LOST` `409` (`:1318`),
`AUDIT_ANALYSIS_HAS_NO_PROPOSALS` `409` (`:1513`), `AUDIT_ANALYSIS_MUTATION_RECEIPT_LIMIT` `409`
(`:170`), `AUDIT_WORKING_PAPER_ACTIVITY_CONFLICT` `409` (`:387`),
`AUDIT_WORKING_PAPER_EXPORT_LIMIT` `413` (`:1669`),
`AUDIT_WORKING_PAPER_EXPORT_SERIALIZATION_ERROR` `500` (`:1691`),
`AUDIT_WORKING_PAPER_PUBLICATION_CONTEXT_REQUIRED` `500` (`:206`),
`AUDIT_WORKING_PAPER_EXPORT_SNAPSHOT_UNAVAILABLE` `503` (`:1834`).

**`INVALID_ENGAGEMENT_CURSOR` has the same functional problem as `INVALID_CASE_CURSOR`.** It is the
signal to drop the cursor and restart pagination, and without the code on the wire the client cannot
distinguish it from user input error. That is now the same gap on two surfaces; §15.

### 4.3 One code, two statuses

`INVALID_PRIOR_WORKING_PAPER` is thrown as **`400`** at
`src/services/audit-working-paper.service.js:566` and `:573`, and as **`409`** at
`src/services/audit-working-paper.service.js:1770`.

A client keying off the code alone cannot tell a bad request from a conflict. Key off the **status**
and treat the code as a category. This is the only code in the whole server with two statuses,
verified by a check that now runs in the gate (§14), so it will not silently become two.

### 4.4 Three different error helpers exist

Worth recording because it defeats naive analysis. This surface uses `httpError(status, message,
code)`. Elsewhere the server uses `serviceError(message, status, { code })`
(`src/services/gst-import.service.js:145`) and `importRequestError(message, code, { fields })`
(`src/services/import-preview.service.js:166`).

A scan that matches only the first pattern reports seven public codes as dead when they are all
live. I made exactly that mistake while writing this and caught it before it reached the page; the
check in §14 covers all three.

---

## 5. Distinct causes of each refusal

**`404`** — four: engagement (`engagement.service.js:464`), finding (`:1702`), working paper
(`audit-working-paper.service.js:266`), analysis (`:1495`), proposal (`:1521`). All firm-scoped, so
another firm's record is indistinguishable from a missing one. Correct; do not explain it away.

**`409`** — this surface is dominated by conflicts, and they fall into four kinds that need
different words:

| Kind                          | Retryable?                         | Examples                                                                                          |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Optimistic revision conflict  | Yes, after re-reading              | `ENGAGEMENT_REVISION_CONFLICT`, `AUDIT_WORKING_PAPER_REVISION_CONFLICT`                           |
| Snapshot moved under a cursor | Yes, restart pagination            | `ENGAGEMENT_SNAPSHOT_CHANGED`                                                                     |
| State rule violation          | **No** — refreshing will not help  | `INVALID_ENGAGEMENT_TRANSITION`, `ENGAGEMENT_COMPLETE_READ_ONLY`, `AUDIT_WORKING_PAPER_READ_ONLY` |
| Missing prerequisite          | **No** — do the prerequisite first | `ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED`, `ENGAGEMENT_CLOSURE_INCOMPLETE`                            |

"This information changed while you were working. Refresh and try again." is right for the first two
and **wrong** for the last two. All four are public here, so the server's own sentence is used and
this is handled — but only because the codes are public. Do not fall back to the generic wording.

**`413`** — export overflow only: more than **10,000** records in one collection or more than
**10 MiB** serialized (`src/services/engagement.service.js:43-44`).

---

## 6. `GET /` — cursor pagination with a version-guarded snapshot

`listEngagements` (`src/services/engagement.service.js:1088`). Cursor kind
**`engagement-list-v2`**.

`limit` maximum **100** (`src/services/engagement.service.js:40`); detail sub-lists cap at **50**
(`:41`). Filters: `status`, `engagementType`, `clientId`, `search`, plus `snapshotAt` and `cursor`.

Response (`src/services/engagement.service.js:1180-1204`):

```
{ ok: true, engagements: [...], templates: [...], pagination: {
    limit, total, hasMore, nextCursor,
    snapshotAt, snapshotVersion,
    sort: "createdAt_desc_id_desc",
    membershipConsistency: "version_guarded_snapshot_rejects_mutation",
    filterHash } }
```

**Two things differ from the cases surface and both matter.**

1. **`membershipConsistency` is `version_guarded_snapshot_rejects_mutation`**
   (`src/services/engagement.service.js:1201`), where cases say
   `created_at_snapshot_with_live_filter_membership`. Engagements carry a `snapshotVersion` and
   **reject** the request with `409 ENGAGEMENT_SNAPSHOT_CHANGED`
   (`src/services/engagement.service.js:1133`, `:1171`) if the underlying set moved. Cases silently
   allow live filter membership instead. So on this surface a mid-pagination change is an error you
   must handle; on that one it is a drift you must not hide. **Two different models, one client.**
2. **`GET /` also returns the full `templates` array** (`src/services/engagement.service.js:1182`),
   the same payload as `GET /templates`. Listing engagements therefore does not require a second
   call, and a client that fetches both is doing redundant work.

Three cursor invalidations, all `400 INVALID_ENGAGEMENT_CURSOR`: `snapshotAt` mismatch
(`:1093`), filter mismatch (`:1129`), and an undecodable cursor (`:226`).

---

## 7. `GET /working-papers` — page and skip, not cursors

`listAuditWorkingPapers` (`src/services/audit-working-paper.service.js:649`). **Completely
different model from §6**, on the same router.

- **`engagementId` is a required query parameter** (`src/services/audit-working-paper.service.js:650`).
  There is no way to list a firm's working papers across engagements.
- Classic `page` / `limit` / `skip` with `totalPages`
  (`src/services/audit-working-paper.service.js:666-671`). Default 25, max **100** (`:37`).
- **No cursor, no snapshot, no `filterHash`, no `hasMore`.** So this list is subject to the ordinary
  skip-pagination drift: a paper created during paging can shift rows between pages. Nothing in the
  response says so, unlike §6 which is explicit about its consistency model.

`GET /working-papers/:id` (`:680`) paginates rows and analyses **independently**, also by page:
rows default 100 max **200** (`:38`), analyses default 25 max **50** (`:39`)
(`src/services/audit-working-paper.service.js:742-753`).

**Rows sort ascending, analyses sort descending** (`src/services/audit-working-paper.service.js:709`
and `:716`) in the same response. Do not assume one direction.

Detail also returns `comparison` against the prior period, with `priorWorkingPaper` **nullable**
(`src/services/audit-working-paper.service.js:739`). A null there means no prior paper was linked,
not that nothing changed.

---

## 8. The honesty flags — read them, do not invent them

This surface carries the strongest "never overstate" implementation in the codebase, and the flags
are **not the same set on every endpoint**. A client must read them per response rather than
modelling one shape.

| Endpoint                  | Flags                                                                                                                                               | Source                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `GET /templates`          | `professionalConclusionGenerated`, `automaticPortalSubmissionPerformed`, `templateQualificationVerifiedByPlatform` — all `false`                    | `src/controllers/engagement.controller.js:23`      |
| `GET /:id`                | the same three, plus `closureReadiness`                                                                                                             | `src/services/engagement.service.js:1297-1299`     |
| `GET /working-papers`     | `safetyBoundary`: `professionalConclusionGenerated`, `privacyReviewPassed`, `automaticFindingCreation`                                              | `src/services/audit-working-paper.service.js:672`  |
| `GET /working-papers/:id` | `safetyBoundary`: `professionalConclusionGenerated`, `privacyReviewPassed`, `aiProposalRequiresHumanDisposition`, `sourceRowsAreAppendOnly`         | `src/services/audit-working-paper.service.js:754`  |
| engagement export         | three top-level flags plus `safetyBoundary`: `operationalSupportOnly`, `humanReviewRequired`, `binaryEvidenceIncluded`, `automaticOpinionGenerated` | `src/services/engagement.service.js:2248-2255`     |
| working-paper export      | `professionalConclusionGenerated`, `privacyReviewPassed`, `automaticFindingCreationPerformed`, plus a six-flag `safetyBoundary`                     | `src/services/audit-working-paper.service.js:1786` |

**`privacyReviewPassed: false` is a standing statement that no privacy review was performed.** Never
render anything that implies one was.

**The naming is inconsistent across endpoints and you must not normalise it away.**
`automaticFindingCreation` in the list versus `automaticFindingCreationPerformed` in the export; and
`sourceRowsAreAppendOnly` in the detail versus `sourceRowsAppendOnly` in the export
(`src/services/audit-working-paper.service.js:675`, `:1789`, `:758`, `:1795`). Read each key by the
name that endpoint actually uses; a shared model with one spelling will silently read `undefined`,
and `undefined` on a safety flag must never be treated as `false`-meaning-safe.

---

## 9. Enumerations, counted from source

| Enum                         | Count | Values                                                                                                                                                               | Source                                           |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ENGAGEMENT_STATUSES`        | 9     | DRAFT, PLANNING, IN_PROGRESS, CLIENT_INPUT_PENDING, INTERNAL_REVIEW, CLIENT_REVIEW, FINALIZATION, COMPLETE, ARCHIVED                                                 | `src/config/engagement-templates.js:1`           |
| `ENGAGEMENT_TYPES`           | 11    | STATUTORY_AUDIT, INTERNAL_AUDIT, STOCK_AUDIT, BANK_AUDIT, TAX_ADVISORY, DUE_DILIGENCE, SECRETARIAL_COMPLIANCE, FORENSIC_AUDIT, GST_ASSESSMENT, GST_REFUND, GST_AUDIT | `src/config/engagement-templates.js:13`          |
| `FINDING_STATUSES`           | 7     | OPEN, MANAGEMENT_RESPONSE_PENDING, ACTION_IN_PROGRESS, FOLLOW_UP_PENDING, READY_FOR_REVIEW, CLOSED, ACCEPTED_RISK                                                    | `src/models/EngagementFinding.js:3`              |
| `FINDING_RISKS`              | 5     | UNASSESSED, LOW, MEDIUM, HIGH, CRITICAL                                                                                                                              | `src/models/EngagementFinding.js:12`             |
| `FOLLOW_UP_RESULTS`          | 5     | NOT_STARTED, EFFECTIVE, PARTIAL, INEFFECTIVE, NOT_APPLICABLE                                                                                                         | `src/models/EngagementFinding.js:13`             |
| checklist item status        | 5     | OPEN, IN_PROGRESS, BLOCKED, COMPLETE, NOT_APPLICABLE                                                                                                                 | `src/models/Engagement.js:27`                    |
| milestone status             | 5     | PENDING, IN_PROGRESS, BLOCKED, COMPLETE, NOT_APPLICABLE                                                                                                              | `src/models/Engagement.js:48`                    |
| client request status        | 5     | NOT_REQUESTED, REQUESTED, PARTIAL, RECEIVED, WAIVED                                                                                                                  | `src/models/Engagement.js:68`                    |
| deliverable status           | 6     | NOT_STARTED, DRAFT, IN_REVIEW, APPROVED, ISSUED, NOT_APPLICABLE                                                                                                      | `src/models/Engagement.js:89`                    |
| review point status          | 3     | OPEN, RESOLVED, WAIVED                                                                                                                                               | `src/models/Engagement.js:107`                   |
| `templateReview.status`      | 3     | PENDING, ATTESTED, CHANGES_REQUESTED                                                                                                                                 | `src/models/Engagement.js:119`                   |
| `finalReview.status`         | 3     | PENDING, APPROVED, CHANGES_REQUESTED                                                                                                                                 | `src/models/Engagement.js:132`                   |
| finding `review.decision`    | 3     | PENDING, APPROVED, CHANGES_REQUESTED                                                                                                                                 | `src/models/EngagementFinding.js:251`            |
| `ANALYSIS_STATUSES`          | 5     | PROCESSING, SUPPORTED, INSUFFICIENT_EVIDENCE, PROVIDER_UNAVAILABLE, PROVIDER_RESULT_INVALID                                                                          | `src/models/AuditWorkingPaperAnalysis.js:3`      |
| `PROPOSAL_DECISIONS` (model) | 4     | PENDING, ACCEPTED, REJECTED, EDITED                                                                                                                                  | `src/models/AuditWorkingPaperAnalysis.js:10`     |
| `PROPOSAL_DECISIONS` (input) | **3** | ACCEPTED, REJECTED, EDITED — `PENDING` is not an accepted input                                                                                                      | `src/services/audit-working-paper.service.js:35` |
| AI provenance `source`       | **1** | AUDIT_WORKING_PAPER                                                                                                                                                  | `src/models/EngagementFinding.js:56`             |
| AI provenance `decision`     | 2     | ACCEPTED, EDITED — a rejected proposal never becomes a finding                                                                                                       | `src/models/EngagementFinding.js:115`            |
| edited-field names           | 5     | title, description, category, risk, evidenceReferences                                                                                                               | `src/models/EngagementFinding.js:187`            |
| review actions               | 4     | ATTEST_TEMPLATE, REQUEST_TEMPLATE_CHANGES, APPROVE_FINAL, REQUEST_FINAL_CHANGES                                                                                      | `src/services/engagement.service.js:2027-2030`   |
| `OUTBOUND_DATA_CLASSES`      | 14    | see §11                                                                                                                                                              | `src/models/AuditWorkingPaperAnalysis.js:17`     |

**Pass an unknown enum value through verbatim.** A tenth engagement status must surface as itself.

`ANALYSIS_STATUSES` deserves care: only **`SUPPORTED`** carries usable proposals. `PROCESSING`,
`INSUFFICIENT_EVIDENCE`, `PROVIDER_UNAVAILABLE` and `PROVIDER_RESULT_INVALID` are all
"no findings to act on", and they mean different things. Disposition is refused unless the analysis
is `SUPPORTED` (`src/services/audit-working-paper.service.js:1512`).

---

## 10. Two state machines

Both are explicit adjacency maps; a move outside them is a public `409`.

### 10.1 Engagement status — `src/services/engagement.service.js:125`

| From                 | May move to                                               |
| -------------------- | --------------------------------------------------------- |
| DRAFT                | PLANNING, ARCHIVED                                        |
| PLANNING             | DRAFT, IN_PROGRESS, ARCHIVED                              |
| IN_PROGRESS          | PLANNING, CLIENT_INPUT_PENDING, INTERNAL_REVIEW, ARCHIVED |
| CLIENT_INPUT_PENDING | IN_PROGRESS, INTERNAL_REVIEW, ARCHIVED                    |
| INTERNAL_REVIEW      | IN_PROGRESS, CLIENT_REVIEW, FINALIZATION, ARCHIVED        |
| CLIENT_REVIEW        | INTERNAL_REVIEW, FINALIZATION, ARCHIVED                   |
| FINALIZATION         | INTERNAL_REVIEW, CLIENT_REVIEW, COMPLETE, ARCHIVED        |
| COMPLETE             | ARCHIVED                                                  |
| ARCHIVED             | **nothing**                                               |

`COMPLETE` is reachable **only from `FINALIZATION`**, and `ARCHIVED` is terminal.

### 10.2 Finding status — `src/services/engagement.service.js:137`

| From                        | May move to                                                  |
| --------------------------- | ------------------------------------------------------------ |
| OPEN                        | MANAGEMENT_RESPONSE_PENDING                                  |
| MANAGEMENT_RESPONSE_PENDING | ACTION_IN_PROGRESS                                           |
| ACTION_IN_PROGRESS          | FOLLOW_UP_PENDING                                            |
| FOLLOW_UP_PENDING           | ACTION_IN_PROGRESS, READY_FOR_REVIEW                         |
| READY_FOR_REVIEW            | ACTION_IN_PROGRESS, FOLLOW_UP_PENDING, CLOSED, ACCEPTED_RISK |
| CLOSED                      | ACTION_IN_PROGRESS                                           |
| ACCEPTED_RISK               | ACTION_IN_PROGRESS                                           |

**A closed finding can be reopened**, to `ACTION_IN_PROGRESS` only. And the early path is a strict
chain — no skipping from `OPEN` to `READY_FOR_REVIEW`.

Closure carries seven additional preconditions beyond the transition
(`src/services/engagement.service.js:1653-1677`): reviewer approval, a management response, an
action plan with active owner and due date, evidence references, action completion evidence, an
effective-or-not-applicable follow-up result for `CLOSED` (not-applicable only for
`ACCEPTED_RISK`), and a follow-up note. Every one is human-entered.

---

## 11. AI working papers — the boundary is the point

`POST /working-papers/:id/analyses` sends source rows to an external model. What leaves is
**enumerated**, not implied: `OUTBOUND_DATA_CLASSES` lists exactly 14 classes
(`src/models/AuditWorkingPaperAnalysis.js:17`) — allowed finding categories, the working paper's
id/title/purpose/period, and per row its id, key, description, observed value, current amount,
reference, assertion tags, note and content hash.

That list is stored **immutably on the analysis record** (`:197-199`), so what was sent is auditable
after the fact. **Surface it.** It is the honest answer to "what did you send about my client?"

Consent is required and recorded: `externalProcessingConsentAt` is **required and immutable**
(`src/models/AuditWorkingPaperAnalysis.js:214`), gated by `AUDIT_AI_CONSENT_REQUIRED`
(`src/services/audit-working-paper.service.js:1090`), whose message names the provider — "…sent to
DeepSeek". `PROVIDER_ADMISSION_VERSION` is `durable-consent-v1`
(`src/models/AuditWorkingPaperAnalysis.js:16`).

At most **50 rows per analysis** (`src/services/audit-working-paper.service.js:36`).

### 11.1 A proposal is not a finding

Disposition (`src/services/audit-working-paper.service.js:1429`) takes `ACCEPTED`, `REJECTED` or
`EDITED`. `REJECTED` and `EDITED` **require a note** (`:1451`), and `editedFinding` is allowed only
with `EDITED` (`:1455`). A proposal can be dispositioned once — a second attempt is
`409 AUDIT_PROPOSAL_ALREADY_DECIDED` (`:1524`).

Only `ACCEPTED` or `EDITED` produces a finding, and the resulting finding carries **immutable AI
lineage**: which analysis, which proposal, the decision, who decided and when, and for an edit the
exact list of changed fields (`src/models/EngagementFinding.js:115-189`). None of it can be
rewritten later.

**So the product can never claim a finding was machine-generated and accepted without a human.** The
schema makes the human decision a required, immutable part of every AI-derived finding. Say so.

### 11.2 Source rows are append-only

Nearly every field on `AuditWorkingPaperRow` is `immutable: true`
(`src/models/AuditWorkingPaperRow.js:14-108`), with a unique index on the row key
(`:120`) producing `409 AUDIT_WORKING_PAPER_ROW_KEY_EXISTS`. There is **no route to edit or delete a
row**. A correction is a new row.

If a row an analysis relied on changes underneath it, the server refuses with
`409 AUDIT_SOURCE_ROW_CHANGED` (`src/services/audit-working-paper.service.js:1346`) rather than
letting a stale proposal be accepted.

---

## 12. Human gates — `PLAN.md` §2.6 in practice

`POST /:id/review` (`src/services/engagement.service.js:2015`) is the only route that records a
professional judgement, and every path through it is explicitly human:

- **`ATTEST_TEMPLATE`** requires `input.confirmed` to be truthy
  (`src/services/engagement.service.js:2082`) — an explicit confirmation, not a side effect. Only
  from `DRAFT` (`:2073`).
- **`REQUEST_TEMPLATE_CHANGES`** requires a note (`:2098`).
- **`APPROVE_FINAL`** requires status `FINALIZATION` (`:2105`).
- **`REQUEST_FINAL_CHANGES`** requires an active review or finalization status (`:2118`) and a note
  (`:2121`).

`REVIEW_FIELDS` includes `reviewerName` and `credentialReference`
(`src/services/engagement.service.js:115`) — the reviewer identifies themselves.

**Findings cannot be created until the template is attested** (`ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED`,
`src/services/engagement.service.js:528`), and neither can working papers
(`src/services/audit-working-paper.service.js:283`). Attestation is the gate that opens the
engagement for work.

**A final approval is invalidated by later content change.** `finalReview` stores
`reviewedRevision`, `reviewedContentRevision` and a `contentFingerprint` sha256
(`src/models/Engagement.js:136-138`), and `clearFinalReview`
(`src/services/engagement.service.js:516`) resets it to `PENDING`. So an approval is bound to the
exact content approved. **Never present a stale approval as current** — read `finalReview.status`
after any edit.

Closure readiness is computed, not asserted: `closureReadiness`
(`src/services/engagement.service.js:901`) reports template attestation, checklist, client
requests, milestones, deliverables, review points and open findings. `ENGAGEMENT_CLOSURE_INCOMPLETE`
(`:945`) is public and names what is missing. Render the server's list; do not compute your own.

---

## 13. Money, dates, concurrency

**Money.** One field on this surface: `currentAmountMinor` on a working-paper row
(`src/models/AuditWorkingPaperRow.js:56`), default **`null`**, immutable, parsed by
`parseSignedMinor` (`src/services/audit-working-paper.service.js:140`) as a **safe integer** —
and, unlike the cases surface, **signed**. A negative value is legal, so do not clamp at zero.
`null` means not recorded, never zero. Read as 64-bit; render with Indian grouping.

**Dates.** All engagement and finding dates default `null` and are stored as `Date`.
`targetDate` cannot precede `startDate` (`src/services/engagement.service.js:993`, `:1445`).
Statutory-flavoured dates (`dueAt`, `actionDueAt`) are day-precision commitments — compare as UTC
days. `occurredAt` on an activity event is a wall-clock moment somebody acted, so it is local. Do
not unify them.

**Concurrency — three mechanisms, and this surface uses all three at once.**

1. **`mutationKey`** on every write, with a unique partial index per record type
   (`src/models/Engagement.js:266`, `src/models/EngagementFinding.js:292`,
   `src/models/AuditWorkingPaper.js:78`). Receipts capped at 1,000 per record
   (`MUTATION_RECEIPT_LIMIT`, `src/services/engagement.service.js:262`).
2. **`expectedRevision`**, sent by the client and checked server-side
   (`src/services/engagement.service.js:506`). `revision` starts at 1 and
   `optimisticConcurrency: true` is set on all four schemas (`src/models/Engagement.js:261`).
   Disposition sends **two** revisions — `expectedPaperRevision` and `expectedAnalysisRevision`
   (`src/services/audit-working-paper.service.js:68`) — because it can conflict on either.
3. **Content fingerprints**, sha256 over canonical content
   (`src/services/engagement.service.js:875`), which is what lets a final approval be invalidated
   by an edit. Capped at 5,000 findings (`ENGAGEMENT_FINGERPRINT_LIMIT`, `:887`).

---

## 14. Already handled server-side — do not redo

- **Export filenames sanitised** (`src/controllers/engagement.controller.js:136`,
  `src/controllers/audit-working-paper.controller.js:105`). Both exports are
  `application/json; charset=utf-8` — **not CSV**, so no formula-injection guard, no BOM.
- **Search regex escaping** (`src/services/engagement.service.js:207`).
- **Both exports run in a MongoDB transaction and refuse rather than truncate**: `503` and no file
  if a coherent snapshot is unavailable (`src/services/engagement.service.js:2276`,
  `src/services/audit-working-paper.service.js:1834`). `exactSnapshotTimeAvailable: false` — do not
  synthesise a snapshot time.
- **Transition legality, closure preconditions and reviewer role** all server-side. Mirror them to
  grey out impossible actions; the server decides.
- **Client and linked-record firm scoping** (`src/services/engagement.service.js:312`, `:327`,
  `:380-393`), including that linked Tasks, Tax Work sessions and Cases must belong to the
  engagement's client.
- **Team size capped at 50 active users** (`src/services/engagement.service.js:196`).

### 14.1 A new invariant test now guards the error contract

`tests/error-contract-invariants.mjs` was added with this task. It reads
`PUBLIC_ERROR_CODES` from `src/app.js` and every thrown code across **all three** error helpers, and
asserts:

- no public code's message contains `HTTP`, `null`, `exception` or a bare status number;
- every public code is actually thrown somewhere, so the allow-list cannot rot;
- no code is thrown with two different statuses, with `INVALID_PRIOR_WORKING_PAPER` pinned as the
  single known exception (§4.3).

It would have caught the OCR defect closed under T31, which is why it exists.

---

## 15. Open items this discovery raised

1. **`INVALID_PRIOR_WORKING_PAPER` carries two statuses** (§4.3). Pinned by test. Splitting it into
   two codes is a contract change; worth doing before a client depends on it.
2. **Cursor-invalidation codes are still not public on any surface.** `INVALID_ENGAGEMENT_CURSOR`
   here, `INVALID_CASE_CURSOR` on notices. Both are "restart pagination" signals that a client
   cannot see. Same decision, now blocking two surfaces.
3. **Safety-flag key names differ between endpoints** for the same concept (§8). Harmless if read
   per endpoint, a silent `undefined` if normalised. Worth aligning.
4. **`UNSUPPORTED_*_FIELD` messages are genericised** (§3), so the offending field name never
   reaches the caller in production. The `IMPORT_MAPPING_*` family shows the pattern for doing this
   properly, including `details.fields`.
5. **`GET /working-papers` has no consistency marker** while `GET /` has an explicit one (§7). The
   working-paper list is plain skip pagination and can drift silently.
6. **`GET /` returns the whole `templates` array on every page** (§6). Fine, but a client should not
   also call `GET /templates`.

---

## 16. What was not verified

- **No route was called against a running server.** Every status and body here is read from source.
- **Neither feature flag's production state was checked**, so whether any firm can reach these
  sixteen routes is unknown. Both `assuranceEngagements` and `auditWorkingPapers` must be on for the
  working-paper half.
- **No engagement, finding, working paper, row or analysis was created**; no template was attested;
  no final review approved; no proposal dispositioned.
- **The external model was never called**, so the `PROCESSING_UNKNOWN`/`202` path, the
  `PROVIDER_RESULT_INVALID` path and the reservation-loss path are code readings, not reproductions.
  These are the paths I would most want exercised before building on them.
- **Neither export was executed.** Both need a replica set for their transaction.
- `listEngagementTemplates()` was confirmed to exist and to be returned by two endpoints, but the
  **content** of the eleven templates was not audited — only that they are frozen at creation by an
  immutable `templateSnapshot` and `templateHash` (`src/models/Engagement.js:185-186`).
- Line numbers were machine-checked at the commit that adds this file. They will drift.
