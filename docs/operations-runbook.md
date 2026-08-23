# Operations runbook

**Last reviewed:** 2026-08-23

Seeded by `.kiro/finalreleasefix.md` **O9** (deploy, rollback, fix-under-pressure). Extended to
O5's full section list on 2026-08-23. Four sections below — Database, Credential custody, Backup
and restore, and Observability — are **deliberately incomplete**, because their content is facts
only the owner holds (O3, O4, O7). Each states exactly what is missing and who must supply it,
rather than being omitted, so a reader can tell the difference between "not written down" and
"not decided". Do not create a second runbook file; add to this one.

**Re-run and re-date at every release:** O4's restore drill and O9's rollback rehearsal. A runbook
whose last drill is a year old is a document, not a capability.

---

## What this is

CA PRO runs as four surfaces. `api.caprotoolkit.in` is a Node/Express app on Hostinger, executed
under Phusion Passenger — `src/server.js` calls `app.listen` synchronously and defers the database
connection, rollout readiness and schedulers into an async `bootstrap()`, specifically because
Passenger does not reliably support top-level `await` in the entry module; health stays *degraded*
rather than *ready* until both the database and background readiness checks complete. It is
deployed **from an uploaded archive, not from git** — `tools/make-deploy-archive.ps1` builds it.
`caprotoolkit.in` is a static site served from `ca-pro-website/`. The admin panel lives at
`/admin` (`super.html` + `super.js`) and is gated by `assertSuper` in
`src/controllers/appconfig.controller.js`, which requires BOTH `role === "SUPER_ADMIN"` AND
`email === saifullahfaizan786@gmail.com` — both, not either, so the panel cannot be reached by
granting the role alone. The fourth surface is the Windows desktop app, which talks only to
`api.caprotoolkit.in`.

## Database

**Partially supplied 2026-08-23 (PLAN.md section 39).**

| Field | Value |
|---|---|
| Provider | MongoDB Atlas |
| Tier | **M0 (free)** |
| Region | Mumbai, India |
| Backup | **none** |
| Cluster name | *not recorded — ask the owner* |
| Database name | *not recorded — ask the owner* |
| RPO / RTO | *not agreed* |

Connection string comes from `MONGODB_URI`; pool sizing from `MONGO_POOL_MIN` / `MONGO_POOL_MAX`.

**Read this before you assume there is a way back.** An Atlas **M0 free tier has no backup facility
at all** — no snapshots, no point-in-time restore, no restore-to-scratch-cluster — and a 512 MB
storage cap. There is currently **no copy of the production database anywhere**. If a collection is
dropped or a migration truncates one, the data is gone. That is the single largest operational risk
in this document, it is why O4 exists, and it must be resolved before a public download.

**The desktop's `EncryptedCache` is not a replica and is not a backup.** It is a per-machine local
cache of what one signed-in user last saw. It cannot reconstruct the database and no recovery plan
may treat it as a copy.

## Credential custody

**INCOMPLETE — blocked on O3.** This section names *custodians and vault locations, never values*.
Required: who holds each credential, in which vault, and the succession path if that person is
unreachable. The credentials in scope are the ones named under "Provider accounts and cost" below,
plus `MONGODB_URI`, `JWT_SECRET`, `DIGEST_UNSUBSCRIBE_SECRET`, `TDS_ACTION_PLAN_SECRET` and
`TDS_IMPORT_PREVIEW_SECRET`.

Standing rule, already load-bearing: two provider keys leaked once through a `capro-backend.zip`
committed at the repo root (O1). Both were rotated. No credential value belongs in this file, in
the repository, or in a deploy archive.

## Backup and restore

**INCOMPLETE — blocked on O4, which has not been built or drilled.** When it exists this section
carries the exact `backup-database.ps1` and `restore-drill.ps1` invocations, the schedule line, and
**the date and pasted output of the most recent drill**. A restore procedure that has never been
executed is an assumption; the pasted drill output is what makes it a fact.

Until then the honest statement is: there is no verified restore path. This is the single largest
operational gap in this document, and it is why the cold-read gate on O5 cannot pass yet.

## Deploy

Hostinger deploys from an uploaded archive, not from git (`tools/make-deploy-archive.ps1:3`) — a
`git push` alone never changes the live API. The pre-deploy gate already exists
(`tools/run-gates.ps1`); this section makes running it non-optional, not a new pipeline.

1. **Commit everything.** `make-deploy-archive.ps1`'s archive validation is commit-pinned: it
   resolves the current `HEAD` commit, then requires `git status --porcelain=v1
   --untracked-files=no` inside `capro-backend/` to be empty, and refuses with `"tracked backend
   files differ from HEAD; commit or restore them first"` if it is not (re-checked again after
   validation, refusing with `"backend HEAD changed during archive validation"` if the worktree
   moved mid-run). A dirty tracked worktree cannot produce an archive at all.
2. **Run the full gate, without skipping the archive check.**
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-gates.ps1
   ```
   This runs `node --check` over all of `src/` and `public/`, then the named test suites, then
   `npm audit --omit=dev --audit-level=high`, then `make-deploy-archive.ps1 -ValidateOnly`. It
   prints a `===== SUMMARY =====` block ending in one of three literal lines:
   `ALL RELEASE GATES GREEN`, `GATES FAILED - DO NOT DEPLOY`, or (if archive validation was
   skipped) neither — read `failing gates: N` and `deployment ready: true|false` above it, and do
   not deploy unless it says `ALL RELEASE GATES GREEN`. `-SkipDeployArchiveValidation` is a
   pre-commit development convenience; using it before a production deploy is a procedure
   violation, not a shortcut — the summary will honestly read `deployment ready: false` in that
   case.
3. **Build the archive for real** (no `-ValidateOnly`):
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-deploy-archive.ps1
   ```
   Note the printed `commit`, `sha256` and `archive` path. Every real run leaves a new file named
   `capro-backend_<commit>_<timestamp>.zip` in the output directory (`D:\CA-PRO-Toolkit\` by
   default) and never overwrites an older one — that accumulation *is* the rollback mechanism (see
   below), pruned to the 5 most recent automatically after each successful, non-`-ValidateOnly` run
   (`-RetainCount`, default 5). **The archive this run just produced is your new "current" — before
   you upload it, make a note of which archive was live until now** (the second-newest file in that
   directory, by write time, right before this run); you will need its filename if this deploy has
   to be rolled back.
4. **Upload through the Hostinger panel**, restart the Node app.
5. **Run the post-deploy smoke**, all four, in order:
   - `curl -si https://api.caprotoolkit.in/health` -> `200`, body contains `"status":"ok"` and
     `"db":{"state":"connected"`.
   - `curl -si https://api.caprotoolkit.in/api/app-config` -> `200`, body contains `"ok":true` and
     a `featureFlags` object. This is the one route both the desktop app and the browser extension
     fetch at startup — its failure breaks every client, not just this deploy's own feature.
   - `curl -si https://api.caprotoolkit.in/` -> `200`.
   - One authenticated read with a real token (any `GET` route behind `authRequired`) -> `200`.

   All four verified live on 2026-08-22 against a deploy that had already landed:
   `GET /health` -> `200` `{"status":"ok","uptime":7973,"db":{"state":"connected","ping_ms":77},
   "background":"ready"}`; `GET /` -> `200`.

## Rollback

**The rollback restores code, not data.** If the bad deploy ran a destructive migration, rolling
the code back alone leaves the database in the new shape — that case needs O4's restore, and O3's
RTO applies instead of this section.

1. Identify the last-known-good archive: the file noted in Deploy step 3 before this deploy (or,
   if that note was not kept, the second-newest `capro-backend_*.zip` in the output directory by
   write time — the newest is the one just rolled back from).
2. Re-upload that archive through the Hostinger panel exactly as in Deploy step 4. Restart.
3. Re-run the same four-item post-deploy smoke from Deploy step 5. All four must pass before the
   incident is considered contained.
4. Record the wall-clock time this took, end to end, in this section (the next entry below) — an
   unrehearsed, untimed rollback procedure is a paragraph, not a capability.

**Rehearsal log** (append one entry per real rehearsal or real incident rollback; do not leave
this list empty for a release that claims this procedure is trustworthy):

| Date | Operator | From commit | To commit | Wall-clock | Smoke result |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

## Kill switches

Two independent mechanisms, both driven from the admin panel and both read through
`AppConfig.getInstance()`.

**Maintenance mode** — `PATCH /api/app-config/maintenance` from `super.html`. When on,
`src/middleware/maintenance.middleware.js` answers protected API routes with `503` and
`{ ok: false, error: "maintenance" }`. Three properties matter when you are using it under
pressure:

- It **allowlists** `/api/auth/*`, `/api/app-config`, `/api/super/*`, `/health` and
  `/api/digests/unsubscribe`. The first three are what let an admin sign in and turn maintenance
  back off — that is why they are exempt. The unsubscribe route is exempt on purpose: a
  recipient's right to stop receiving mail must not depend on the site being up.
- It **fails OPEN.** If the config read throws, the middleware calls `next()` and traffic flows.
  A database blip therefore does *not* silently take the API down — but it also means maintenance
  mode cannot be relied on as a security control.
- `AppConfig.getInstance()` caches for **30 seconds** (`CACHE_MS = 30_000`). Engaging and lifting
  maintenance both take **up to 30 s** to be observed by every process. Wait it out; do not assume
  the toggle failed and click again.

**Per-feature rollout flags** — `PATCH /api/app-config/features`, enforced by
`src/middleware/rollout.middleware.js`. A disabled flag makes the route answer **404** with
`{ ok: false, error: "Feature unavailable", featureFlag: "<name>" }` and a `requestId`. A 404
carrying a `featureFlag` key is a deliberately-disabled feature, not a missing route — that
distinction is the first thing to check when a user reports a page "disappeared". The same 30 s
cache applies.

## Observability

**INCOMPLETE — blocked on O7, an owner decision (free-tier uptime monitor and error aggregator).**
Required when it lands: what is watched, who is paged, and the escalation path.

What already works and should be carried into that section: every error response carries a
`requestId`, and the desktop surfaces it to the user as a selectable `Reference: <id>` line. That
id is the join key — a user quotes it from their screen or from a saved diagnostics file, and it
matches the server log line for the same request. Until O7 exists, `GET /health` polled by hand is
the only uptime signal, and there is no alerting of any kind: **an outage is noticed when a user
reports one.** Say that plainly to whoever takes an on-call rotation.

## Support

The inbound support address is **[OWNER TO COMPLETE — O8/L1]**. It is not written here as a guess;
`SupportContact` in the desktop carries the same literal placeholder so the two cannot silently
disagree, and the published response window is already set to **30 days**.

What a diagnostics bundle contains, so you can tell a worried user honestly: app version, Windows
version, runtime version, whether they are signed in, whether a workspace is active, last sync
time, online state, up to 20 recent failure descriptions, recent request ids, and the crash log.

What it **excludes by construction, not by redaction**: there is no field anywhere in
`DiagnosticsSnapshot` for a client name or a firm name, so one cannot be included even by mistake.
Free-text that does pass through is filtered by `CrashLog.Redact`. Nothing is uploaded — the file
is written only when the user chooses Save, and it goes wherever they put it. That is the whole
answer to "what are you sending about my clients": nothing, and the record has no place to put it.

## Provider accounts and cost

Four external providers. Each row is: what it does, its env var, and where it is administered.

| Provider | Purpose | Env var(s) | Console |
|---|---|---|---|
| DeepSeek | AI analysis of submitted text | `DEEPSEEK_API_KEY`, `DEEPSEEK_URL`, `DEEPSEEK_MODEL` (+ `_FALLBACK`, `_CLASSIFIER_MODEL`, `_INSIGHTS_MODEL`) | DeepSeek platform account |
| OCR.space | Text extraction from images/scans | `OCR_SPACE_API_KEY` | OCR.space account |
| Resend | Outbound transactional email | `RESEND_API_KEY` | Resend dashboard |
| Google | Sign-in (web + desktop OAuth clients) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS`, `GOOGLE_DESKTOP_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_SECRET` | Google Cloud console |

**Who pays each account, and on which card, is [OWNER TO COMPLETE — O3/O11].**

Spend is capped in code (O10), so a runaway loop costs calls rather than money. Defaults, all
overridable by env var:

| Cap | DeepSeek | OCR.space |
|---|---|---|
| Per user, per day | 60 | 25 |
| Per user, per month | 800 | 300 |
| Global, per day | 1500 | 600 |

Raising a cap is an env-var change plus a redeploy, not a code change. Note the global caps are the
real budget control — the per-user caps only stop one account from consuming everything.

## Fix needed under pressure — decision order

Do not improvise this at 1am. In order:

1. **If the fault is one module:** turn its feature flag off via the admin panel
   (`https://api.caprotoolkit.in/admin/super.html`, Feature flags card). No deploy. Effect is
   immediate for `tdsHealth`, `noticeCases`, `assuranceEngagements`, `auditWorkingPapers`
   (`rollout.middleware.js` passes `fresh:true` for these four); the other 15 flags take up to 30
   seconds (`AppConfig.CACHE_MS`).
2. **If the fault is broad:** engage maintenance mode from the same admin panel. No deploy.
   `maintenance.middleware.js` blocks every `/api/*` route EXCEPT `/api/auth/*`,
   `/api/app-config`, `/api/super/*`, `/health`, and `/api/digests/unsubscribe` — so the admin
   panel itself, sign-in, and the health check all stay reachable while everything else answers
   `503` with the configured maintenance message. **Honest limitation, verified by reading the
   code (`maintenance.middleware.js`'s `catch` block calls `next()`):** if the config read itself
   fails, the gate fails OPEN — a database blip disables maintenance mode rather than engaging it.
   Maintenance mode is an availability lever, not a security control; never rely on it to contain
   a data-exposure incident.
3. **If the fault came from the last deploy:** roll back per the Rollback section above.
4. **Only then attempt a forward fix**, and never skip `run-gates.ps1` to save time — the exact
   suites it runs (`production-readiness-checklist`, `production-error-envelope`,
   `error-contract-invariants`, `deploy-archive-security`, `deploy-archive-boundary`) are the ones
   most likely to catch a panic-edit before it becomes a second incident.

## Staging

No second Hostinger app on a subdomain pointed at a scratch database exists. This is an owner
decision (cost) that has not been recorded either way yet — until it is, `run-gates.ps1` reporting
`ALL RELEASE GATES GREEN` is the *only* gate before a production deploy, which makes step 2 of the
Deploy section load-bearing rather than advisory, and the retained last-known-good archive (kept
automatically, 5 most recent) is the only real safety net.

## Known limitation: one developer's PC

`run-gates.ps1` and `make-deploy-archive.ps1` both default `-RepoRoot` to
`D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend` and require `node`, `npm` and `git` resolvable on
`PATH`. Deploys today can only originate from this one machine. A second machine that needed to
deploy would need: the repo cloned to the same relative structure (or both scripts' `-RepoRoot`
passed explicitly), Node/npm/git on `PATH`, the Hostinger panel credentials, and — since the
archive scanner shells out via a self-authorizing nested-process launch — a real interactive
Windows console session; it is not yet confirmed to run under CI or a fully headless session.

## Known operational limits

An honest list. Every item here is a real constraint a new operator will hit, not a caveat.

- **No CI for the backend.** `.github/` carries a desktop workflow only (V10). Backend correctness
  before a deploy rests entirely on `run-gates.ps1` run by hand.
- **No staging.** See the Staging section above — this is an unrecorded owner cost decision.
- **Single region, single instance.** One Hostinger app, one database. There is no failover.
- **Deploys originate from one developer's PC.** See "Known limitation: one developer's PC".
- **No backup at all, and therefore no restore.** The database is an Atlas M0 free tier, which
  has no snapshot or point-in-time facility. See Database and Backup-and-restore. This is the
  one item on this list that can lose a customer's work irrecoverably.
- **No alerting.** See Observability — blocked on O7. Outages are user-reported.
- **The installer is unsigned, by owner decision.** There is no paid code-signing certificate, so
  Windows SmartScreen warns on first install and the user must click "More info -> Run anyway".
  This is expected behaviour, not a compromised download, and the download page says so.
