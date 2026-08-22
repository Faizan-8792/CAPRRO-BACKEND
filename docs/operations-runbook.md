# Operations runbook

Seeded by `.kiro/finalreleasefix.md` **O9** (deploy, rollback, and the fix-needed-under-pressure
decision order). This file does **not** yet cover everything `docs/operations-runbook.md` is
supposed to per **O5** — the Database, Credential custody, Observability, Support, Provider
accounts, and Known-operational-limits sections all depend on decisions (O3, O4, O7, O8) that
have not been made yet. Whoever closes O5 adds those sections here; do not create a second file.

---

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
