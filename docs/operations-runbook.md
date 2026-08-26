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
storage cap. That is why the dump-and-encrypt path in this document exists at all: the cluster
itself will not save you.

**Corrected 2026-08-26.** This paragraph used to end "There is currently **no copy of the production
database anywhere**." That is no longer true and must not be quoted. A production backup has been
taken, encrypted, copied off-host, and — crucially — **restored and verified**: 43 collections
compared against the manifest, 0 mismatches, backend health 200 against the restored data. The full
record is in `backup-recovery-status.md`.

What remains true, and is now the real risk: **every backup so far has been run by hand.** No
scheduled task exists yet (`schtasks /Query /TN "CAPRO nightly backup"` finds nothing). A manual
backup proves the mechanism; a scheduled one proves the habit, and it is the habit that is there at
3 a.m. See the `schtasks /Create` line below.

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

Both scripts exist and the whole path has been drilled end to end. **What has NOT happened yet is a
run against production**, because that needs the Atlas credential and an off-host destination (O3).
Read the "Still outstanding" note at the end of this section before assuming you are covered.

### Taking a backup

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup-database.ps1
```

It reads the connection string from `$env:CAPRO_BACKUP_URI` and the gpg recipient from
`$env:CAPRO_BACKUP_RECIPIENT`, so neither is ever typed on a command line or visible in a process
list. Useful switches: `-OutputDirectory`, `-OffHostDirectory`, `-Retain` (default 14),
`-WhatIfNoUpload`, `-GpgPath`.

What it does, in order: reads per-collection document counts **before** dumping (the restore drill
has nothing to compare against otherwise), runs `mongodump --gzip --archive`, refuses any archive
under 1 KB, refuses an archive whose size moved by more than 10x against the previous run,
encrypts with gpg to the recipient, **deletes the plaintext dump**, writes a manifest beside the
archive, copies both off-host, and prunes beyond `-Retain`.

### Running the drill

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-drill.ps1 `
    -ArchivePath <the .archive.gz.gpg> `
    -ScratchUri  "mongodb://127.0.0.1:27017/scratch-drill" `
    -HealthUri   "mongodb://127.0.0.1:27117/scratch-drill" `
    -IncludeHealthCheck
```

**The drill refuses to run unless the database in `-ScratchUri` starts with `scratch-`**, and it
checks that before decrypting anything. It exits **2** for that refusal and **1** for a genuine
drill failure, so a script can tell them apart. This guard is the only thing between a mistyped URI
and `mongorestore --drop` deleting a live database.

### Three traps this environment has already sprung, all real

- **Two different addresses for one database.** The mongo tools run inside the
  `capro-mongo-dev` container and see Mongo on **27017**; the health-check backend runs on the host
  and must use the published **27117**. Getting this wrong does not error, it just leaves
  `db.state` at `"connecting"` until the drill times out. That is why `-HealthUri` exists.
- **A database name in the restore URI silently defeats `--nsFrom`/`--nsTo`.** mongorestore treats
  it as an implicit `--db`, scopes the restore to a namespace the archive does not contain, and
  exits **0** having written nothing. The script strips it; do not add it back.
- **gpg is usually not on PATH.** Git for Windows ships one under `usr\bin` that only Git Bash
  sees. The script searches the known locations, and `-GpgPath` overrides. If you use Git's gpg,
  `GNUPGHOME` must be a POSIX-style path (`/c/...`), not `C:\...`.

### Scheduling it

Not yet scheduled. When the credential exists, register it as a daily task:

```
schtasks /Create /TN "CAPRO nightly backup" /SC DAILY /ST 02:30 /RL HIGHEST /RU SYSTEM ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend\tools\backup-database.ps1"
```

A task running as SYSTEM does not inherit a user's environment, so set `CAPRO_BACKUP_URI` and
`CAPRO_BACKUP_RECIPIENT` as **machine-level** variables (`setx /M`) or the task will fail on its
first night with "No MongoDB URI". Prefer a scheduler on the hosting side over this if one is
available: a backup that depends on one developer's PC being powered on is a backup that stops the
first time that PC is off.

### Last drill

| | |
|---|---|
| Date | 2026-08-23 |
| Source | `capro-o4-backup-source` on the local `capro-mongo-dev` container |
| Archive | `capro-capro-o4-backup-source-20260823-064106.archive.gz.gpg` (5,641 bytes ciphertext, 5,008 plaintext) |
| Collections compared | **39** |
| Mismatches | **0** |
| Non-zero collections | clients 23, tasks 41, firmmemberships 11, users 7, firms 3, engagements 1 |
| App health | `{"status":"ok","uptime":2,"db":{"state":"connected","ping_ms":2},"background":"ready"}` |
| Guard test | pointed at a non-`scratch-` database, refused with exit 2, nothing decrypted, mongorestore never called |
| Result | **PASS** (exit 0), scratch database dropped afterwards |

### Still outstanding

- **The drill has never run against production.** It ran against a local container database.
  Needs the Atlas credential from O3.
- **No off-host destination.** Until `-OffHostDirectory` points somewhere, an archive lives on the
  same machine that made it and does not survive losing that machine.
- **Not scheduled**, so no backup happens unless someone runs it by hand.
- Until those three are done, the honest statement remains: **there is no verified restore path for
  production data.** Re-run the drill after any change to the model set in `capro-backend/src/models/`.

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
4. **Upload and deploy.** Two ways; prefer the first, because it is repeatable and leaves evidence.

   **From this machine (no panel):**
   ```
   # Load the token into the environment only. Never paste it on a command line or into a file.
   $env:HOSTINGER_API_TOKEN = (Select-String -Path .env -Pattern '^HOSTINGER_API_TOKEN=' |
       ForEach-Object { $_.Line -replace '^HOSTINGER_API_TOKEN=', '' }).Trim('"', "'")

   node tools/hostinger-upload-file.mjs --domain api.caprotoolkit.in `
       --file "D:/CA-PRO-Toolkit/capro-backend_<commit>_<timestamp>.zip" `
       --remote "capro-backend.zip"

   node tools/hostinger-deploy-backend.mjs --node-version 22
   ```
   The upload tool re-downloads the file afterwards and compares SHA-256 before reporting success.
   The deploy tool reads the build settings off the uploaded archive on the server (it never invents
   an entry file), triggers the build, waits for a terminal state, and then asks the running app for
   `/api/app-config` — a completed build is not the same as a healthy service. Add `--dry-run` to
   see the settings a deploy would use without triggering one.

   **`--node-version` is not optional in practice.** The settings endpoint infers a Node major from
   the archive and has been observed inferring **20** while production runs **22**. Deploying new
   code and a new runtime major together makes any failure ambiguous, so pin the version that is
   already serving and change one thing at a time. Check what is running with
   `hosting_listJsDeployments` (or the panel) before deploying if you are unsure.

   **Through the Hostinger panel** is the fallback if the API is unavailable: upload the same
   archive as `capro-backend.zip`, then trigger the Node app build and restart.

   Either way, expect the service to answer `/api/app-config` within seconds but `/health` to report
   `"status":"degraded"` with `"background":"initializing"` for a while after the restart — see the
   readiness note in step 5.
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

   **Do not read the first `/health` as a failure.** `server.js` starts accepting connections before
   `bootstrap()` finishes, and readiness is only set true after connect -> provision-indexes ->
   rollout-flags -> feature-index-readiness -> digest-startup all complete. Until then `/health`
   honestly reports `"status":"degraded"`, `"background":"initializing"` while `db.state` is already
   `connected`. Measured on 2026-08-24 across three real deploys: **roughly 60-90 s** for a deploy
   that changes only code, and **about 3.5 minutes** (uptime 202 s at the moment it flipped) for the
   deploy that introduced a new collection, because provisioning that collection's indexes on the
   Atlas **M0 free tier** is slow. Poll until `"status":"ok"` before declaring the deploy good, and
   only treat it as a failure if it has not settled after roughly 5 minutes.

   **One thing to check on the first deploy after 2026-08-24.** Index provisioning now covers the
   GST storage collections (ImportBatch, ImportRow, ReconciliationRun and friends), which it did not
   before -- a fresh database could not commit a GST import at all. Provisioning builds a UNIQUE
   index over existing data, and a unique index cannot be built over duplicates. If production
   already holds duplicate rows under one of those keys, the build refuses and the collection is
   recorded in the provisioning result's `failures` list; boot continues rather than aborting, so
   this fails QUIETLY. After that deploy, confirm GST still imports rather than assuming it: commit
   one small import, or check the boot log for a provisioning failure naming a GST collection.

   `node tools/verify-live-posture.mjs` runs the health check plus the CORS and error-envelope
   checks in one pass; a clean result is `8 passed, 0 failed, 2 skipped` (the 2 skips need a
   super-admin token in `CAPRO_TOKEN`).

## Rollback

**The rollback restores code, not data.** If the bad deploy ran a destructive migration, rolling
the code back alone leaves the database in the new shape — that case needs O4's restore, and O3's
RTO applies instead of this section.

1. Identify the last-known-good archive: the file noted in Deploy step 3 before this deploy (or,
   if that note was not kept, the second-newest `capro-backend_*.zip` in the output directory by
   write time — the newest is the one just rolled back from).
2. Re-upload that archive exactly as in Deploy step 4 — the same two commands, pointed at the
   older file. Nothing else changes; `--remote capro-backend.zip` is always the same destination,
   so a rollback is a normal deploy of an older archive rather than a special path.
3. Re-run the same four-item post-deploy smoke from Deploy step 5. All four must pass before the
   incident is considered contained.
4. Record the wall-clock time this took, end to end, in this section (the next entry below) — an
   unrehearsed, untimed rollback procedure is a paragraph, not a capability.

**Rehearsal log** (append one entry per real rehearsal or real incident rollback; do not leave
this list empty for a release that claims this procedure is trustworthy):

The 2026-08-24 rows' `Smoke result` column is **3 of 4 on both legs**, not 4. Read the note below
before quoting those rows: the fourth check (an authenticated read returning 200) did not run on
either leg that day, for want of a production bearer token. This line exists because the
roll-forward row said “4 of 4” until 2026-08-26 while the paragraph under the table said the
opposite — a reader skimming only the table would have concluded the rollback was proved for
authenticated behaviour. The **2026-08-27 rehearsal closed that gap**: all four checks ran and
passed on both legs, the fourth against `GET /api/auth/me` with a real super-admin bearer token.

| Date | Operator | From commit | To commit | Wall-clock | Smoke result |
|---|---|---|---|---|---|
| 2026-08-24 | agent (Opus 5), rehearsal | `0ea0bcb` | `10bf147` | **89 s** | 3 of 4 pass — see note |
| 2026-08-24 | agent (Opus 5), roll-forward | `10bf147` | `0ea0bcb` | **52 s** | 3 of 4 pass — see note |
| 2026-08-27 | agent (Fable 5), rehearsal | `e000d87` | `0a0e5dc` | **47 s** | **4 of 4 pass** |
| 2026-08-27 | agent (Fable 5), roll-forward | `0a0e5dc` | `e000d87` | **67 s** (+ ~2.5 min to `background:ready`) | **4 of 4 pass** |

**What the 2026-08-27 rehearsal did.** Both legs were confirmed by content, not by the deploy
reporting success: the two builds differ observably only in the served `public/admin/super.js`
(the O18 same-origin base landed in `da5c47f`), so after the rollback the live file carried the
absolute `https://api.caprotoolkit.in/api` base exactly once, and after the roll-forward it
carried none and the relative `"/api"` form once. `/health` uptime reset on both legs. The
rollback target was chosen so the restored build post-dates the `94a4779` feature-flag panel fix,
per the constraint recorded on 2026-08-26. The extension preflight
(`chrome-extension://emimafaefblkocfndndcgghbliodhnkp` → 204 with the origin reflected) was
re-checked after the roll-forward. Note the roll-forward's `background:ready` took ~2.5 minutes —
inside the documented window; do not read an interim `"status":"degraded"` as a failed leg.

**What that rehearsal actually did**, so the numbers above are readable rather than decorative. It
was a real rollback against production, not a described one: the live API was moved back to the
previous archive and then forward again, both through the tooling in Deploy step 4.

The rollback was confirmed by content, not by the deploy reporting success — after it, the live
`accountDeletion` string was **466 characters** (the previous build's text) and after the
roll-forward it was **768** and byte-identical to the repository's. That comparison is the reliable
check: **an HTTP 401 does not prove a route is deployed.** `/api/super/*` sits behind router-level
authentication that runs before route matching, so a path that does not exist in the deployed build
still answers `401`, not `404`. Anything asserting "the new routes are live" from a 401 is asserting
nothing.

**Smoke coverage, stated honestly.** Of Deploy step 5's four checks, three ran on both legs of the
2026-08-24 rehearsal and passed: `/health` (after the readiness wait), `/api/app-config`
(`ok:true`, `featureFlags` present) and `GET /`. The fourth — an authenticated read returning `200`
— was **not run** on either leg, for want of a production bearer token.

**Update 2026-08-26: the fourth check is no longer unrunnable.** `tools/mint-admin-token.mjs` mints
a real session token through the ordinary OTP login and stores it in `.env`, so an authenticated
read is now part of any deploy's smoke. It ran on the 2026-08-26 deploy of commit `94a4779`:
`GET /api/auth/me` -> **200**, alongside `/api/app-config` 200, `GET /` 200, and `/health` reaching
`{"status":"ok","background":"ready"}` after 151 seconds. **Four of four.**

What that does and does not close: the *capability* gap is gone, and every future deploy can smoke
all four. The 2026-08-24 **rollback rehearsal** itself still shows 3 of 4, because that is what was
actually observed on those two legs, and a rehearsal cannot be improved retroactively. Re-running it
was deliberately not done on 2026-08-26: the archive it would have rolled back to contains the
feature-flag panel defect fixed in `94a4779`, and briefly restoring a build that can wipe production
flags — while the owner is working in the panel — is a worse trade than leaving the rehearsal at 3
of 4 until a calmer pair of archives exists.

**Prune interaction, worth knowing before an incident.** `-RetainCount` defaults to 5 and prunes by
write time after each real build. A rollback deploys an *older* archive but does not re-create it,
so the file's mtime does not move and it stays as old as it was — five further deploys after a
rollback will prune the very archive you rolled back to. If you are sitting on a known-good archive
during an incident, copy it somewhere outside the output directory before continuing to deploy.

## Withdrawing a desktop release

**Start from what a desktop rollback cannot do.** The backend rollback above restores code that runs
on one server. A desktop release does not: once an installer has been downloaded, it is on other
people's machines and there is no mechanism in this product — and no ethical one — to reach in and
remove it. Withdrawing a release therefore means two separate things, and confusing them wastes the
first hour of an incident:

1. **Stop new installs of the bad build.** Fully within your control, effective immediately.
2. **Get users already on it onto something better.** Only partly within your control, and the
   levers that reach installed apps are the blunt ones.

### The four levers, in order of reach

| # | Lever | Reaches | Effect |
|---|---|---|---|
| 1 | `download/CA-PRO-Setup-<version>-x64.exe` | New downloads | The file itself. Remove or replace it and the link 404s |
| 2 | `download/latest.json` | The website, and the download page when the API is unreachable | Advertises version, URL, SHA-256 and size |
| 3 | `desktopRelease` on the AppConfig singleton | Installed apps' update banner | Stops advertising the bad version in-app |
| 4 | `desktopRelease.minSupportedVersion` | Installed apps, forcibly | Locks out builds below the floor |

**Levers 1 and 2 are the rollback.** Do both, in that order — the file first, then the manifest, so
there is never a window where `latest.json` advertises a URL that 404s. Re-upload the previous
installer and restore the previous `latest.json` (its `latestVersion`, `downloadUrl`, `sha256` and
`sizeBytes` must all move together; a stale hash beside a new file is worse than either alone,
because the download page tells users to verify against it). Both go up with the same tool the
website uses:

```
node tools/hostinger-upload-file.mjs --domain caprotoolkit.in     --file "<path to the previous installer>" --remote "download/CA-PRO-Setup-<previous>-x64.exe"
node tools/hostinger-upload-file.mjs --domain caprotoolkit.in     --file "ca-pro-website/download/latest.json" --remote "download/latest.json"
```

The upload tool re-downloads and compares SHA-256 before reporting success, so a half-finished
upload does not read as a rollback.

**Lever 3 stops the in-app nag.** `PATCH /api/app-config/desktop-release` as the super administrator,
setting `enabled: false` (or repointing it at the previous version). Installed apps stop offering
the bad update on their next `/api/app-config` read. This does not un-install anything; it stops the
product recommending a build you have withdrawn, which is the part that would otherwise keep
generating new victims after the download link is already fixed.

**Lever 4 is the only one that reaches an already-installed bad build, and it is a lockout.** Raising
`minSupportedVersion` above the bad version makes the API answer `426` to those clients: they stop
working until the user updates. Use it only when running the bad build is worse than not running the
product at all — data corruption, a privacy leak, a wrong figure shown as authoritative. For a
cosmetic or partial fault it is the wrong trade: you have taken the product away from people who
were getting value from it. Note the deliberate fail-open in the middleware: a request carrying **no**
version header is allowed through, so the floor never locks out the browser extension or an older
client that does not send one.

### Is maintenance mode the lever? Usually not

Maintenance mode is a **server-side** switch. It stops the API for every client — the Chrome
extension, every desktop build including the good ones, every firm. It is the right lever when the
fault is in the backend and everyone is affected anyway.

It is the **wrong** lever for a bad desktop build, and reaching for it is a common instinct worth
naming: it punishes every user on a good version to contain a fault they do not have. Use levers 1-3
for a desktop problem, and lever 4 only under the test above.

If you do engage it, remember the allowlist in `maintenance.middleware.js`: `/api/auth/*`,
`/api/app-config`, `/api/super/*`, `/health` and `/api/digests/unsubscribe` stay reachable, which is
what keeps the admin panel usable so you can lift it again.

### What to tell users

Say it in these three places, in this order, and say the same thing in each:

1. **The download page** — the visible statement. Name the affected version, say plainly what goes
   wrong, and say what to do. A user who has already installed it needs an instruction, not an
   apology.
2. **`releaseNotes` in `latest.json`** — the download page renders it, so it reaches someone
   mid-download.
3. **`desktopRelease.releaseNotes`** — reaches installed apps through the update banner.

Write it as: what is wrong, which version, what a user should do now, and when a fix is expected. Do
not describe a withdrawn build as "an issue" — a chartered accountant deciding whether their filing
figures were affected needs to know whether the fault touched data or only display. If you do not
yet know, say that, and say when you will know.

**Do not silently replace the artefact at the same URL.** The download page publishes a SHA-256 and
tells users to verify against it. A user who checks and finds a mismatch has been given a reason to
distrust the whole distribution. Withdraw the version, publish the replacement under its own version
and its own hash.

### Rehearsal status

The **backend** rollback is rehearsed and timed — see the log above. This desktop-side procedure is
**written but not rehearsed**: no version has yet been withdrawn from the live site. The two are not
interchangeable evidence, and this section should not be read as tested until an entry appears below.

| Date | Operator | Version withdrawn | Levers used | Wall-clock | Outcome |
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

## Paid provider caps

Six figures decide how much CA PRO can spend with a paid provider before it refuses. They are read
from the environment and fall back to the defaults below, which are what production runs on today
because none of the six variables is set.

| Provider | Scope | Env var | Default |
|---|---|---|---|
| DeepSeek | per user, per day | `DEEPSEEK_DAILY_CALL_CAP_PER_USER` | **60** |
| DeepSeek | per user, per month | `DEEPSEEK_MONTHLY_CALL_CAP_PER_USER` | **800** |
| DeepSeek | all users, per day | `DEEPSEEK_GLOBAL_DAILY_CALL_CAP` | **1500** |
| OCR.space | per user, per day | `OCR_SPACE_DAILY_CALL_CAP_PER_USER` | **25** |
| OCR.space | per user, per month | `OCR_SPACE_MONTHLY_CALL_CAP_PER_USER` | **300** |
| OCR.space | all users, per day | `OCR_SPACE_GLOBAL_DAILY_CALL_CAP` | **600** |

**The reasoning, so a future operator can argue with it rather than guess at it.**

The per-user daily caps are set at roughly a heavy but plausible day of real work — 60 AI calls is
far more than a CA doing genuine review will make, and 25 OCR calls is more documents than one
person scans in a day. They are not there to ration normal use. They are there so that a runaway
loop, a stuck retry, or one compromised account cannot spend a month's budget in an afternoon.

The monthly per-user caps are deliberately **not** 30x the daily figure (800, not 1800; 300, not
750). A user who hits their daily cap every day for a month is not doing accountancy, and the
monthly ceiling is what notices that pattern.

The global daily caps are the ones that actually bound the bill. They are set above the sum of a
realistic day's use across the current user base and well below anything that would be a surprise on
an invoice. **They are the figures to revisit as the user count grows** — the per-user caps scale
with users automatically, the global ones do not, so the global cap is what will start refusing real
work first if it is left where it is.

All six are enforced atomically against a compound unique index on `ProviderUsage`, so twenty
concurrent calls at cap-minus-one produce exactly one success and nineteen refusals — proved live,
not assumed (`tests/provider-quota-contract.mjs`, Part E). Without that index the counter is
advisory and every concurrent call is allowed; `index-provisioning.service.js` creates it at every
boot.

**Where to see the spend.** The admin panel's Provider usage card reads
`GET /api/super/provider-usage`, which reports today and this month per provider plus the top users
today.

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
- **No backup of production yet.** The database is an Atlas M0 free tier, which has no snapshot
  or point-in-time facility of its own. `toolsackup-database.ps1` and `tools
estore-drill.ps1`
  now exist and the whole path was drilled end to end on 2026-08-23 (39/39 collections, app
  health 200) -- but against a LOCAL database, not production, and nothing is scheduled. Until
  the Atlas credential and an off-host destination exist, production still has no restorable
  copy. This remains the one item on this list that can lose a customer's work irrecoverably.
- **No alerting.** See Observability — blocked on O7. Outages are user-reported.
- **The installer is unsigned, by owner decision.** There is no paid code-signing certificate, so
  Windows SmartScreen warns on first install and the user must click "More info -> Run anyway".
  This is expected behaviour, not a compromised download, and the download page says so.
