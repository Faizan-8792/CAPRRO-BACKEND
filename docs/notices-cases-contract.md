# Notices and Cases — backend contract

Read from source for ledger task **T31** (board item **B4**). Every claim below names a file and
line, and every citation was machine-checked with `node tools/verify-doc-citations.mjs
docs/notices-cases-contract.md`.

Companion to `docs/gst-reconciliation-contract.md` (T13) and `docs/tds-health-contract.md` (T24).
Where this surface differs from those, the difference is called out, because three of the four
defects found while writing the TDS doc came from assuming the surfaces matched.

**The route count in the ledger and on the coordination board is wrong.** Both say 12. The router
declares **16** handlers.

---

## 1. Route table

Mounted at `/api/cases` (`src/app.js:455`). Sixteen handlers in `src/routes/case.routes.js`.

`POST /ocr` is declared **before** the shared guard (`src/routes/case.routes.js:57`) and therefore
does not inherit it. Everything after `router.use(...)` (`src/routes/case.routes.js:66`) does.

| #   | Method  | Path                                 | Handler                  | Line | Success |
| --- | ------- | ------------------------------------ | ------------------------ | ---- | ------- |
| 1   | `POST`  | `/ocr`                               | `previewCaseOcr`         | 57   | `200`   |
| 2   | `POST`  | `/`                                  | `createCase`             | 72   | `201`   |
| 3   | `GET`   | `/`                                  | `listCases`              | 73   | `200`   |
| 4   | `GET`   | `/:id/export`                        | `exportCase`             | 74   | `200`   |
| 5   | `GET`   | `/:id`                               | `showCase`               | 75   | `200`   |
| 6   | `PATCH` | `/:id`                               | `patchCase`              | 76   | `200`   |
| 7   | `POST`  | `/:id/extraction`                    | `proposeCaseFields`      | 77   | `200`   |
| 8   | `PATCH` | `/:id/confirmations`                 | `confirmFields`          | 78   | `200`   |
| 9   | `POST`  | `/:id/timeline`                      | `createTimelineEntry`    | 79   | `201`   |
| 10  | `POST`  | `/:id/references`                    | `verifyReference`        | 80   | `201`   |
| 11  | `POST`  | `/:id/analyses`                      | `generateAnalysis`       | 81   | `201`   |
| 12  | `POST`  | `/:id/drafts`                        | `createResponseDraft`    | 82   | `201`   |
| 13  | `POST`  | `/:id/drafts/:draftId/submit-review` | `sendDraftForReview`     | 83   | `200`   |
| 14  | `POST`  | `/:id/drafts/:draftId/review`        | `decideDraftReview`      | 84   | `200`   |
| 15  | `POST`  | `/:id/drafts/:draftId/finalize`      | `finalizeResponseDraft`  | 85   | `200`   |
| 16  | `POST`  | `/:id/submissions`                   | `createSubmissionRecord` | 86   | `201`   |

**`GET /:id/export` is declared before `GET /:id`** (`src/routes/case.routes.js:74-75`). Order
matters in Express; do not reorder them.

### 1.1 Middleware chains, and the one asymmetry

Fifteen routes: `authRequired` → `requireFirmMember` → `requireFirmWriteAccess` →
`requireFeatureFlag("noticeCases")` (`src/routes/case.routes.js:66`).

`POST /ocr`: `authRequiredWithoutUsageTracking` → `requireFirmMember` →
`requireFeatureFlag("noticeCases")` → `upload.single("file")`
(`src/routes/case.routes.js:57-64`).

Two deliberate differences, both of which the client must know about:

1. **No `requireFirmWriteAccess`.** A **read-only firm member can run OCR**. Defensible, because
   the route writes nothing (`zeroWrite: true`, `src/controllers/case.controller.js:50`), but it
   does send a client's notice to a third party. This is pinned by a test rather than changed,
   because changing a server authorization rule is a decision for the human, not for whoever is
   next in this file. See §14.
2. **`authRequiredWithoutUsageTracking`**, so an OCR preview is not counted as usage.

---

## 2. Feature flag, and the second freshness check

Every route is behind `requireFeatureFlag("noticeCases")`. A firm without the flag gets `403`.

Four handlers additionally re-assert the flag **version** mid-request through
`assertNoticeRequestCurrent` (`src/controllers/case.controller.js:33`), which calls
`AppConfig.assertFeatureFlagVersion` with the version and publication fence captured at
authentication:

- `previewCaseOcr`, `proposeCaseFields`, `generateAnalysis`;
- `createResponseDraft` **only when `origin` is `AI_ASSISTED`**
  (`src/controllers/case.controller.js:186`).

That last one is worth restating: a user-authored draft skips the version check and an AI-assisted
draft does not. The four checked handlers are exactly the ones that spend money with an external
provider.

Failure raises `FEATURE_ROLLOUT_CHANGED`, which the error handler treats specially: it is public
whenever the named flag exists in `DEFAULT_FEATURE_FLAGS`, and it adds a `featureFlag` field to the
response body (`src/app.js:552`). The desktop already reads `featureFlag` as of T25a.

---

## 3. OCR and file intake — the part a client cannot infer

### 3.1 The request

`POST /api/cases/ocr`, `multipart/form-data`, file field named **`file`**
(`src/routes/case.routes.js:62`), plus a text field **`consent`**.

**Multipart is allowed on this one exact path and nowhere else.** The global Content-Type guard
(`src/app.js:324`) rejects any non-JSON `POST`/`PATCH`/`PUT` under `/api/` unless
`req.path === "/api/cases/ocr"` (`src/app.js:333`). The comparison is exact, so
**`/api/cases/ocr/` with a trailing slash is refused by the guard** even though the Express router
would have matched it.

That refusal is emitted **directly, not through the error handler** (`src/app.js:335-339`), so its
body is `{ ok: false, error: "Unsupported Media Type — Content-Type must be application/json" }`
with **no `category` and no `requestId`**. Every other error on this surface has both. A client
error reader must tolerate their absence.

A zero-length body skips the guard entirely (`src/app.js:331`).

### 3.2 Consent is a data-egress gate, not a form field

`consent` must arrive as the string `"true"`, case-insensitively
(`src/controllers/case.controller.js:48`), and it is checked **before anything else**
(`src/services/ocr-space.service.js:8`). Because the controller stringifies, JSON `true` also
satisfies it.

**`POST /:id/extraction` uses a different rule.** `runCaseExtraction` requires a strict boolean
`input.consent !== true` (`src/services/case-record.service.js:624`) with no coercion. So the two
consent gates on this surface disagree: OCR accepts `"true"`, extraction demands `true`. Send a
real boolean in JSON bodies and the string `"true"` in the multipart form.

The gate exists because the file leaves Hostinger for `api.ocr.space`
(`src/services/ocr-space.service.js:3`) and the extraction text goes to DeepSeek. Wording must say
so; a generic validation message would be a lie about where the client's notice went.

### 3.3 Bounds, and which check actually fires

| Bound          | Value                                        | Enforced at                                 |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| Size           | **8 MiB** (`8 * 1024 * 1024`)                | `src/services/ocr-space.service.js:4`       |
| Types          | `application/pdf`, `image/png`, `image/jpeg` | `src/services/ocr-space.service.js:5`       |
| Files          | 1                                            | `src/routes/case.routes.js:38`              |
| Text fields    | 5                                            | `src/routes/case.routes.js:38`              |
| Extracted text | 250,000 characters                           | `src/services/case-validation.service.js:4` |
| Provider wait  | 45 s, `AbortController`                      | `src/services/ocr-space.service.js:34`      |

multer runs before the controller, so **multer wins every race**. The identical size and type
checks inside `ocr-space.service.js:15` and `:18` are defence in depth and are **unreachable over
HTTP** on this route.

Effective order: multer type → multer size → multer file/field counts → consent → empty buffer →
provider key.

### 3.4 Filenames, and why the client is safe here

The upload filename is bounded and defaulted before it reaches the provider:
`String(fileName || "notice-file").slice(0, 240)` (`src/services/ocr-space.service.js:26`).

**The export route sanitises its own `Content-Disposition` filename server-side**:
`case-${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json` (`src/controllers/case.controller.js:274`). A
hostile filename cannot reach the client from this surface. The client should still discard the
header and build its own local name — the rule stands — but on this surface it is not load-bearing.

### 3.5 Nothing is stored

`binaryStored: false` in the OCR result (`src/services/ocr-space.service.js:65`) and on the model,
where a validator **refuses any other value** (`src/models/CaseMatter.js:212`). The export repeats
it as `binaryFilesIncluded: false` (`src/services/case-record.service.js:1140`).

Consequence for copy: never imply the uploaded file was saved. Only the extracted text is kept,
in `source.extractedText`.

### 3.6 Response

`200 { ok: true, zeroWrite: true, result }` (`src/controllers/case.controller.js:50`), where
`result` is `{ text, textHash, provider: "OCR_SPACE", providerEngine: "2", processedAt,
binaryStored: false }`.

`zeroWrite: true` is an explicit promise that no case was created. Preview only.

---

## 4. Error codes — a defect found and fixed while writing this

`src/app.js` keeps a `PUBLIC_ERROR_CODES` allow-list (`src/app.js:36`). A code in it returns the
service's own message; a code outside it is replaced in production by a generic message chosen from
the status alone (`src/app.js:475`).

**Not one `OCR_*` code was on that list, and no test anywhere referenced `PUBLIC_ERROR_CODES`.**
Production therefore answered a missing consent with _"Some submitted information could not be
accepted. Review the form and try again."_ — misleading, because there is no form field to correct.
An unsupported file type fell through to the catch-all _"The request could not be completed."_ and
never told the user which types are accepted.

`AUDIT_AI_CONSENT_REQUIRED` was already public
(`src/services/audit-working-paper.service.js:1092`), which is what makes this an oversight rather
than a policy.

**Fixed in this change:** nine `OCR_*` codes and `CASE_AI_CONSENT_REQUIRED` added
(`src/app.js:84-85`), the multer `fileFilter` rejection given a code
(`src/routes/case.routes.js:50`), and `tests/notice-case-contract.mjs` added so a new OCR code
cannot be introduced silently.

### 4.1 The multer rejection had no code at all

multer 2.2.0 passes a `fileFilter` error through **unwrapped** — `abortWithError(err)` calls
`done(err)` calls `next(err)` in `node_modules/multer/lib/make-middleware.js`. So the 415 arrived
as a plain `Error` with `name: "Error"` and **no `code`**, which meant the handler could not treat
its message as public no matter what was on the allow-list. The code has to be set at the filter
(`src/routes/case.routes.js:50`).

Only `LIMIT_FILE_SIZE` maps to `413`; every other `MulterError` maps to `400`
(`src/app.js:526-530`).

### 4.2 OCR codes

| Code                       | Status | Public | Message                                             | Line |
| -------------------------- | ------ | ------ | --------------------------------------------------- | ---- |
| `OCR_CONSENT_REQUIRED`     | `400`  | yes    | Explicit consent is required before sending a file… | 9    |
| `OCR_FILE_REQUIRED`        | `400`  | yes    | OCR file is required                                | 12   |
| `OCR_FILE_TOO_LARGE`       | `413`  | yes    | OCR file exceeds the 8 MiB limit                    | 15   |
| `OCR_TYPE_UNSUPPORTED`     | `415`  | yes    | OCR accepts PDF, PNG, or JPEG files only            | 18   |
| `OCR_PROVIDER_UNAVAILABLE` | `503`  | yes    | OCR provider is not configured                      | 22   |
| `OCR_PROVIDER_ERROR`       | `502`  | **no** | OCR provider returned HTTP `<status>`               | 44   |
| `OCR_PROCESSING_FAILED`    | `502`  | yes    | OCR provider could not process this file            | 48   |
| `OCR_NO_TEXT`              | `422`  | yes    | OCR returned no readable text                       | 55   |
| `OCR_TEXT_TOO_LARGE`       | `422`  | yes    | OCR text exceeds the 250,000 character case limit   | 57   |
| `OCR_TIMEOUT`              | `504`  | yes    | OCR provider timed out                              | 70   |

Lines are in `src/services/ocr-space.service.js`.

**`OCR_PROVIDER_ERROR` is deliberately excluded.** Its message interpolates the provider status
(`src/services/ocr-space.service.js:44`) and no user-facing string may contain `HTTP`. It stays
generic until that message is rewritten. A second throw of the same code carries a safe message
(`src/services/ocr-space.service.js:72`), but a code is public or not as a whole, so the unsafe one
governs.

### 4.3 `CASE_*` codes still deferred

These are thrown but intentionally **not** public, because their wording is engineer-facing and
putting it in front of a chartered accountant would be worse than a generic message. Each needs new
copy first, which is a product decision.

| Code                                  | Status | Where                                      | Generic message the user sees today             |
| ------------------------------------- | ------ | ------------------------------------------ | ----------------------------------------------- |
| `CASE_NOT_FOUND`                      | `404`  | `src/services/case-record.service.js:554`  | "The requested item could not be found." — fine |
| `INVALID_CASE_CURSOR`                 | `400`  | `src/services/case-record.service.js:490`  | "Some submitted information…" — **wrong**       |
| `INVALID_CASE_SNAPSHOT`               | `400`  | `src/services/case-record.service.js:192`  | "Some submitted information…" — **wrong**       |
| `CASE_REPLAY_TARGET_MISSING`          | `409`  | `src/services/case-record.service.js:1025` | "This information changed…" — acceptable        |
| `CASE_STATUS_TRANSITION_NOT_ALLOWED`  | `409`  | `src/services/case-record.service.js:96`   | "This information changed…" — **wrong**         |
| `CASE_CONTENT_TRANSITION_IN_PROGRESS` | `409`  | `src/services/case-record.service.js:111`  | "This information changed…" — near enough       |
| `CASE_EXPORT_TOO_LARGE`               | `413`  | `src/services/case-record.service.js:285`  | "The selected file exceeds…" — **wrong**        |
| `CASE_EXPORT_SNAPSHOT_UNAVAILABLE`    | `503`  | `src/services/case-record.service.js:1172` | "We could not complete your request…" — fine    |

Three of these matter functionally, not just cosmetically:

- **`INVALID_CASE_CURSOR`** is the signal to **drop the cursor and restart pagination**. Without
  the code on the wire the client cannot tell it apart from a user input error and will show a
  validation message for a condition the user cannot fix. See §6.
- **`CASE_STATUS_TRANSITION_NOT_ALLOWED`** is a rule violation, not a concurrent edit. "Refresh and
  try again" is wrong advice: refreshing will not help.
- **`CASE_EXPORT_TOO_LARGE`** speaks of a _selected file_ when the real cause is too much case
  history. There is no file.

`CASE_VALIDATION_ERROR` is the default code on `httpError`
(`src/services/case-validation.service.js:16`) and is also not public, so **most validation
failures on this surface are genericised**. That is largely acceptable — the generic 400 wording is
reasonable — but it means the client cannot discriminate causes and must not try.

### 4.4 Response envelope

From `src/app.js:554-566`: `ok: false`, `error`, `category`, `requestId`, plus `code` only when
public, `details` only for two families, `featureFlag` only for a rollout change, and `stack` only
outside production.

`category` comes from status alone (`src/app.js:463`): `401` AUTHENTICATION_REQUIRED, `403`
ACCESS_DENIED, `404` NOT_FOUND, `409` CONFLICT, `413` FILE_TOO_LARGE, `429` RATE_LIMITED, `>=500`
SERVICE_ERROR, `400`/`422` INPUT_ERROR, everything else REQUEST_ERROR. **`415` and `504` are not
enumerated**, so a `415` reads REQUEST_ERROR and a `504` reads SERVICE_ERROR.

---

## 5. Distinct causes of each refusal

The client needs different wording per cause, so these are listed separately.

**`403`** — one cause on this surface: the `noticeCases` flag is off for the firm, or the member
lacks write access on the fifteen guarded routes. Word it as the server's decision, and for the
flag case as "not switched on for this firm".

**`404`** — `CASE_NOT_FOUND` only (`src/services/case-record.service.js:554`, `:1102`). Scoped by
`firmId`, so a case in another firm is indistinguishable from a case that never existed. That is
correct and must not be explained away.

**`409`** — seven distinct causes, and they need different words:

| Cause                                     | Where                                         |
| ----------------------------------------- | --------------------------------------------- |
| `mutationKey` reused with another payload | `src/services/case-validation.service.js:64`  |
| `mutationKey` reused for another action   | `src/services/case-record.service.js:132`     |
| Status transition not allowed             | `src/services/case-record.service.js:96`      |
| A content transition is mid-flight        | `src/services/case-record.service.js:111`     |
| Confirmation history at its 500 limit     | `src/services/case-record.service.js:775`     |
| Already at 100 verified references        | `src/services/case-record.service.js:1030`    |
| Missing prerequisite for a status         | `src/services/case-record.service.js:915-931` |

That last row is four separate refusals with distinct text: an in-review draft is required before
`INTERNAL_REVIEW`, an approved draft before `CLIENT_APPROVAL`, a reviewer-approved final draft
before `READY_TO_SUBMIT`, and a recorded submission before `SUBMITTED`. Each is a human-gated step
and none may be satisfied automatically.

**`413`** — two unrelated causes: an upload over 8 MiB, and an export with more than 2,000 records
in any one collection (`src/services/case-record.service.js:285`).

---

## 6. `GET /` — snapshot cursor pagination, not page numbers

`listCaseMatters` (`src/services/case-record.service.js:439`) is **not** the GST or TDS shape. It
is cursor-based with a pinned snapshot.

`parsePagination` supplies only `limit` — **`page` is parsed but ignored** on this route.
Default **25**, maximum **100** (`src/services/case-validation.service.js:164`). The TDS surface
clamps at 100 too; GST clamps at 50.

Query: `limit`, `cursor`, `snapshotAt`, `status`, `caseType`, `clientId`, `search`.

`snapshotAt` pins the result set with `createdAt: { $lte: snapshotAt }`, so cases created during
pagination do not appear and do not shift pages.

The cursor is opaque, kind `case-list-v1`, and carries `filterHash`, `snapshotAt`, `createdAt` and
`id`. Three things invalidate it, all `400 INVALID_CASE_CURSOR`:

1. `snapshotAt` disagrees with the cursor (`src/services/case-record.service.js:447`);
2. the active filters disagree with `filterHash` (`src/services/case-record.service.js:483`);
3. the cursor predates `filterHash` entirely (`src/services/case-record.service.js:490`).

**So changing any filter mid-pagination is an error, not a silent reset.** The client must drop the
cursor itself when the user changes a filter.

### 6.1 Response

```
{ ok: true, cases: [...], pagination: {
    limit, total, hasMore, nextCursor,
    snapshotAt, sort: "createdAt_desc_id_desc",
    membershipConsistency: "created_at_snapshot_with_live_filter_membership",
    filterHash } }
```

`total` is a real count (`countDocuments`), unlike the GST `summary`, which is deliberately null in
some states. There is **no truncation flag** on this route; `hasMore` plus `nextCursor` is the
whole story.

**`membershipConsistency` is an honesty marker and must not be smoothed over**
(`src/services/case-record.service.js:543`). The snapshot bounds _creation time_ only; filter
membership is evaluated **live**. A case whose status changes after the snapshot can therefore
enter or leave a status-filtered result set mid-pagination. `total` can move between pages. Do not
present it as a fixed figure.

### 6.2 Two things the list response does not contain

`src/services/case-record.service.js:514` excludes `source.extractedText`,
`extractionProposals` and `confirmationEvidence`. They exist only on the detail route. A list view
must not expect them.

**Search silently misses matches.** A `search` term is matched against client names, and the
matching client IDs are capped at 100 (`src/services/case-record.service.js:467`). A term matching
more than 100 clients drops the rest, and **nothing in the response says so**. Treat search results
as best-effort; do not word them as complete.

`search` is bounded to 120 characters and regex-escaped before use, so it is not an injection
vector.

---

## 7. `GET /:id` — four independently paginated histories

`getCaseDetail` (`src/services/case-record.service.js:549`) returns `case`, then `timeline`,
`analyses`, `drafts` and `submissions`, each paginated separately with its own cursor
(`timelineCursor`, `analysisCursor`, `draftCursor`, `submissionCursor`).

One shared `historyLimit`: default **100**, maximum **200**
(`src/services/case-record.service.js:199-203`).

`historyPagination` (`src/services/case-record.service.js:587`) carries `limit` plus per-collection
`{ hasMore, nextCursor }`. A parallel `truncation` block repeats each `hasMore`.

**A truncated collection must render as `N+`, never a bare count** — and a truncated response that
returned zero rows renders `0+`, because a clean `0` would tell a firm it has no outstanding
submissions on a response that never said that.

---

## 8. `GET /:id/export` — transactional JSON, not CSV

`buildCaseExport` (`src/services/case-record.service.js:1138`) returns
`application/json; charset=utf-8` (`src/controllers/case.controller.js:271`), **not** CSV.

So on this surface: **no CSV formula-injection concern, no BOM, no Indian-grouping question.** The
GST export rules do not transfer. Read the bytes rather than the string anyway, out of habit and
because the header handling is shared.

Payload (`src/services/case-record.service.js:1138-1157`):

- `schemaVersion: "case-export-v4"`
- `exportedAt`, ISO
- `binaryFilesIncluded: false`
- `automaticSubmissionPerformed: false`
- `exportCompleteness`: `complete`, `consistency: "mongodb_transaction_snapshot"`,
  `snapshotBoundary`, **`exactSnapshotTimeAvailable: false`**, `maximumRecordsPerCollection`
  (2000), `maximumSerializedBytes` (25 MiB), `serializedBytes`
- `case`, `timeline`, `analyses`, `drafts`, `submissions`
- `truncation`: four booleans, all `false` — the export refuses rather than truncates

`exactSnapshotTimeAvailable: false` is deliberate honesty: the export is coherent but cannot state
the instant it describes. **Do not synthesise a timestamp for it.** `exportedAt` is when the file
was produced, not the snapshot instant.

The export runs inside a **MongoDB transaction**, so it needs a replica set. If a coherent snapshot
cannot be obtained the route answers `503 CASE_EXPORT_SNAPSHOT_UNAVAILABLE`
(`src/services/case-record.service.js:1172`) and produces nothing. It never returns a partial
export, which is the right trade for statutory evidence.

Over 2,000 records in any one collection is `413 CASE_EXPORT_TOO_LARGE`
(`src/services/case-record.service.js:285`), whose current public wording talks about a selected
file and is wrong — see §4.3.

---

## 9. Enumerations, counted from source

| Enum                 | Count | Values                                                                                                                                                                                                                                  | Source                                    |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `CASE_TYPES`         | 12    | INCOME_TAX_NOTICE_INTIMATION, ASSESSMENT, REASSESSMENT, APPEAL, RECTIFICATION, PENALTY_PROCEEDING, TDS_PROCEEDING, GST_NOTICE_ASSESSMENT, GST_REFUND_MATTER, GST_AUDIT_QUERY, ROC_SECRETARIAL_MATTER, GENERAL_LITIGATION_REPRESENTATION | `src/models/CaseMatter.js:3`              |
| `CASE_STATUSES`      | 15    | INTAKE, EXTRACTION_NEEDS_REVIEW, OPEN, DOCUMENTS_PENDING, ANALYSIS, RESPONSE_DRAFT, INTERNAL_REVIEW, CLIENT_APPROVAL, READY_TO_SUBMIT, SUBMITTED, HEARING_SCHEDULED, ORDER_RECEIVED, APPEAL_REVIEW, CLOSED, ARCHIVED                    | `src/models/CaseMatter.js:18`             |
| `CASE_FIELD_NAMES`   | 17    | see §11                                                                                                                                                                                                                                 | `src/models/CaseMatter.js:36`             |
| priority             | 4     | LOW, NORMAL, HIGH, URGENT — default NORMAL                                                                                                                                                                                              | `src/models/CaseMatter.js:183`            |
| risk                 | 5     | UNASSESSED, LOW, MEDIUM, HIGH, CRITICAL — default UNASSESSED                                                                                                                                                                            | `src/models/CaseMatter.js:188`            |
| `source.method`      | 5     | DIGITAL_PDF_LOCAL, OCR_SPACE, SCREENSHOT_OCR, PASTED_TEXT, MANUAL                                                                                                                                                                       | `src/models/CaseMatter.js:197`            |
| `extractionProvider` | 3     | LOCAL, OCR_SPACE, MANUAL                                                                                                                                                                                                                | `src/models/CaseMatter.js:207`            |
| `extractionStatus`   | 4     | NOT_REQUESTED, EXTRACTION_NEEDS_REVIEW, CONFIRMED, FAILED                                                                                                                                                                               | `src/models/CaseMatter.js:223`            |
| confirmation source  | 3     | AI_PROPOSAL, SOURCE_TEXT, MANUAL                                                                                                                                                                                                        | `src/models/CaseMatter.js:84`             |
| reference sourceType | **1** | USER_VERIFIED                                                                                                                                                                                                                           | `src/models/CaseMatter.js:124`            |
| `DRAFT_STATUSES`     | 7     | DRAFT, IN_REVIEW, APPROVED, REJECTED, FINALIZING, FINAL, SUPERSEDED                                                                                                                                                                     | `src/models/CaseDraft.js:3`               |
| draft `origin`       | 2     | USER, AI_ASSISTED                                                                                                                                                                                                                       | `src/models/CaseDraft.js:51`              |
| `SUBMISSION_METHODS` | 5     | PORTAL, EMAIL, PHYSICAL, HAND_DELIVERY, OTHER                                                                                                                                                                                           | `src/services/case-content.service.js:39` |
| timeline type        | 3     | NOTE_ADDED, HEARING_RECORDED, OUTCOME_RECORDED                                                                                                                                                                                          | `src/services/case-record.service.js:979` |

**`sourceType` has exactly one legal value.** A verified reference is always `USER_VERIFIED`;
there is no AI-sourced authority. Never render a citation as machine-verified, and where a standard
is absent render "No standard cited" rather than synthesising one.

**Pass an unknown enum value through verbatim.** A sixteenth status must surface as itself, not
collapse to a default.

---

## 10. Status transitions are a graph, not a free choice

`CASE_STATUS_TRANSITIONS` (`src/services/case-record.service.js:59`) is an explicit adjacency map.
A move outside it is `409 CASE_STATUS_TRANSITION_NOT_ALLOWED`
(`src/services/case-record.service.js:96`). Same-status is a no-op.

| From                    | May move to                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| INTAKE                  | EXTRACTION_NEEDS_REVIEW, OPEN, DOCUMENTS_PENDING, ANALYSIS, RESPONSE_DRAFT, CLOSED, ARCHIVED |
| EXTRACTION_NEEDS_REVIEW | OPEN, DOCUMENTS_PENDING, ANALYSIS, RESPONSE_DRAFT, CLOSED, ARCHIVED                          |
| OPEN                    | DOCUMENTS_PENDING, ANALYSIS, RESPONSE_DRAFT, CLOSED, ARCHIVED                                |
| DOCUMENTS_PENDING       | OPEN, ANALYSIS, RESPONSE_DRAFT, CLOSED, ARCHIVED                                             |
| ANALYSIS                | DOCUMENTS_PENDING, RESPONSE_DRAFT, CLOSED, ARCHIVED                                          |
| RESPONSE_DRAFT          | DOCUMENTS_PENDING, INTERNAL_REVIEW, CLOSED, ARCHIVED                                         |
| INTERNAL_REVIEW         | RESPONSE_DRAFT, CLIENT_APPROVAL, CLOSED, ARCHIVED                                            |
| CLIENT_APPROVAL         | RESPONSE_DRAFT, INTERNAL_REVIEW, READY_TO_SUBMIT, CLOSED, ARCHIVED                           |
| READY_TO_SUBMIT         | SUBMITTED, CLOSED, ARCHIVED                                                                  |
| SUBMITTED               | HEARING_SCHEDULED, ORDER_RECEIVED, APPEAL_REVIEW, CLOSED, ARCHIVED                           |
| HEARING_SCHEDULED       | ORDER_RECEIVED, APPEAL_REVIEW, CLOSED, ARCHIVED                                              |
| ORDER_RECEIVED          | APPEAL_REVIEW, CLOSED, ARCHIVED                                                              |
| APPEAL_REVIEW           | HEARING_SCHEDULED, ORDER_RECEIVED, CLOSED, ARCHIVED                                          |
| CLOSED                  | ARCHIVED                                                                                     |
| ARCHIVED                | **nothing**                                                                                  |

Four of these also require evidence to exist first, listed in §5. The client should offer only
reachable targets, and must not treat the graph as the whole rule.

---

## 11. Confirmable fields, money, and dates

`PATCH /:id/confirmations` accepts **1 to 17** confirmations
(`src/services/case-record.service.js:770`); duplicates are refused
(`src/services/case-record.service.js:780`).

Per-field normalisation is in `normalizeConfirmedValue`
(`src/services/case-validation.service.js:132`). Text limits
(`src/services/case-validation.service.js:149-160`): `authority` 300, `noticeType` 300,
`sectionReference` 160, `assessmentYear` 20, `financialYear` 20, `period` 80, `din` 200,
`assessingAuthority` 300, `statedReason` 4000, anything else 500. All are **required and non-empty**
once confirmed.

### 11.1 Money

Two fields, `demandMinor` and `disputedMinor` (`src/services/case-validation.service.js:12`).

Validated by `parseSafeMinor` (`src/services/case-validation.service.js:87`) as a **non-negative
safe integer** in paise, and again on the model by `safeMinorUnit`
(`src/models/CaseMatter.js:56`).

**`Number.isSafeInteger`, not int32.** The ceiling is 9,007,199,254,740,991 paise, so a demand far
above ₹2.14 crore is legal and ordinary — a crore-scale tax demand is the normal case here, not an
edge case. **Read both as 64-bit.** A 32-bit read returns null above 2,147,483,647 and a null read
falls back to zero, which would show a ₹0.00 demand on a live notice.

Both default to **`null`** on the model (`src/models/CaseMatter.js:104-105`, inside
`ConfirmedFactsSchema`). **`null` means not confirmed, not zero.** Never substitute `₹0.00`.

Render with Indian digit grouping.

### 11.2 Dates

Five date fields (`src/services/case-validation.service.js:5`): `issueDate`, `receivedDate`,
`responseDueDate`, `hearingDate`, `limitationDate`. All default `null`.

`parseDateValue` accepts anything `new Date()` accepts and stores a `Date`, so they serialise as
ISO instants. **`responseDueDate` and `limitationDate` are statutory deadlines: compare and render
them as UTC days.** Converting to local time can move a due date across a day boundary and into a
different return period.

By contrast a timeline event's `occurredAt` is a wall-clock moment somebody acted, and is local.
Do not unify the two.

### 11.3 Arrays

`requestedDocuments` is the only array field (`src/services/case-validation.service.js:13`): at
most 100 items of at most 500 characters, de-duplicated. A string input is parsed as JSON, and
failing that split on newlines or semicolons.

---

## 12. Idempotency and concurrency — three separate mechanisms

**1. `mutationKey`, required on writes.** 8–120 characters matching
`/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/` (`src/services/case-validation.service.js:14`). Invalid is
`400 INVALID_MUTATION_KEY`; both that and `MUTATION_KEY_REUSED` **are** public
(`src/app.js:37-38`).

The key is bound to a hash of the request payload with `mutationKey` removed
(`src/services/case-validation.service.js:50-57`). Reusing a key with a different body is
`409 MUTATION_KEY_REUSED` (`src/services/case-validation.service.js:64`). **A retry must resend a
byte-identical body**, or it reads as a conflicting new request. Reusing a key for a different
action is a separate `409` (`src/services/case-record.service.js:132`).

Receipts are capped at 1,000 per case with unique keys
(`src/services/case-record.service.js:58`, `src/models/CaseMatter.js:254`);
`MUTATION_RECEIPT_LIMIT` is public.

**2. `revision` plus mongoose optimistic concurrency.** `revision` starts at 1
(`src/models/CaseMatter.js:269`) and the schema sets `optimisticConcurrency: true`
(`src/models/CaseMatter.js:274`), so a stale write fails on `__v`.

**3. `contentTransition`, a short-lived lease.** While a token is present and unexpired, document
writes are refused with `409 CASE_CONTENT_TRANSITION_IN_PROGRESS`
(`src/services/case-record.service.js:111`). An expired lease is cleared and the write proceeds. So
this `409` is genuinely retryable after a moment — unlike the other six, which are not.

---

## 13. Drafts are immutable versions

`CaseDraft` content is **immutable after creation**: fifteen fields are frozen by a pre-save hook
that refuses with "Draft content versions are immutable"
(`src/models/CaseDraft.js:131`, `:152`). A revised response is a **new version**, not an edit.
`content` is capped at 250,000 characters (`src/models/CaseDraft.js:53`).

**Exactly one `FINAL` draft per case**, enforced by a partial unique index named
`one_final_draft_per_case` (`src/models/CaseDraft.js:127`). Not a convention — the database refuses
a second.

Each of the four lifecycle steps carries its **own** mutation key and request hash, each with its
own unique partial index (`src/models/CaseDraft.js:107-125`): review submission, review decision,
finalization, submission. Do not reuse one key across steps.

`authorityClaims` (`src/models/CaseDraft.js:64`) binds a hash of the claim text to **1–10**
reference ids (`src/models/CaseDraft.js:25`), at most 100 bindings. This is the mechanism that stops
an unsupported authority claim reaching a client. Surface a claim's bound references; never present
an unbound claim as authoritative.

Model output is a draft. Label it `DRAFT FOR REVIEW`, and never state that anything was filed —
`createSubmissionRecord` returns `automaticSubmissionPerformed: false`
(`src/controllers/case.controller.js:258`) precisely so the client can say so.

---

## 14. Already handled server-side — do not redo

- **Export filename sanitisation** (`src/controllers/case.controller.js:274`). Do not re-escape.
- **Search regex escaping** by `escapeRegex` (`src/services/case-record.service.js:291`, applied at
  `src/services/case-record.service.js:464`), with `search` bounded to 120 characters first
  (`src/services/case-record.service.js:462`).
- **Upload filename bounding** (`src/services/ocr-space.service.js:26`).
- **Size, type, count limits** at multer (`src/routes/case.routes.js:38-39`).
- **Status transition legality** (`src/services/case-record.service.js:59`). Mirror it to grey out
  impossible choices, but the server decides.
- **The 1 MB JSON body cap** (`src/app.js:344`) applies to every route except the multipart OCR one.
- **`clientId` must be an active client of the firm**
  (`src/services/case-record.service.js:303`); assigned users must be active in the firm
  (`src/services/case-record.service.js:318`).

---

## 15. Open items this discovery raised

1. **`POST /ocr` lacks `requireFirmWriteAccess`** while the other fifteen routes have it, so a
   read-only member can spend the firm's OCR budget and send a client file to a third party. Pinned
   by `tests/notice-case-contract.mjs`, not changed. **Needs a human decision.**
2. **Five `CASE_*` codes carry wrong public wording** (§4.3). `INVALID_CASE_CURSOR`,
   `CASE_STATUS_TRANSITION_NOT_ALLOWED` and `CASE_EXPORT_TOO_LARGE` are the three that matter.
   Needs new copy, then the codes can be made public.
3. **The two consent gates disagree** on whether `consent` may be a string (§3.2). Harmless today
   because each has one caller, but it will bite.
4. **`/api/cases/ocr/` with a trailing slash is rejected** by the Content-Type guard while the
   router would accept it (§3.1). Either normalise the path in the guard or document it forever.
5. **Search silently truncates at 100 matching clients** with no flag in the response (§6.2).
6. `OCR_PROVIDER_ERROR`'s message must lose its `HTTP <status>` before the code can be public
   (§4.2).

---

## 16. What was not verified

- **No route was exercised against a running server.** Every statement here is read from source.
  Statuses and bodies are what the code constructs, not what was observed on the wire.
- **The `noticeCases` flag state in production was not checked**, so whether any firm can currently
  reach these routes is unknown.
- **The export transaction was not executed**, so `CASE_EXPORT_SNAPSHOT_UNAVAILABLE` is a
  code-reading, not a reproduction. It does mean the export needs a replica set.
- **`ocr.space` was not called.** The provider's own failure modes, and whether it returns partial
  text for a damaged PDF, are unknown.
- **No claim is made about `case-ai.service.js` prompt content or DeepSeek behaviour**; only the
  consent gate in front of it was read.
- Line numbers were machine-checked with `tools/verify-doc-citations.mjs` at the commit that adds
  this file. They will drift.
