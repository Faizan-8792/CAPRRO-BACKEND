# Remaining verification — what only the owner can do

**Purpose.** One place for every check that an agent cannot run, so nobody has to reconstruct the
list from the ledger. Each entry says what the gate is, why it is pending, exactly what to do,
what a pass looks like, and what evidence to capture.

**Nothing in this file is a failure.** These are checks that need a person, a browser, a second
machine, or a mailbox. Anything that could be executed has been, and is recorded in
`.kiro/finalreleasefix.md` against its own task.

Last updated: 2026-08-26 (second pass, same day). Ledger at the time: **65 of 115 done (56.5%)**,
agent-completable **65 of 92 (70.7%)**, release gates **8 of 14**, protocol OK. UPDATED AGAIN 2026-08-26 evening: **65 of 116 (56.0%)**, agent-completable **65 of 92 (70.7%)**, gates **8 of 14**, protocol OK — L16 was added to the denominator, which is why the headline fell.

UPDATED 2026-08-27: **82 of 133 (61.7%)**, agent-completable **78 of 107 (72.9%)**, gates **8 of
14**, protocol OK. The owner decided the three open decisions on 2026-08-27 ("deploy the
same-origin fix, accept O19, and apply T14 = B + C"): the CORS same-origin rule is implemented and
pinned (15/15), the ledger's two bookkeeping rules were amended exactly as drafted, and `U5`, `R9`,
`T14` and `O19` are now ticked on evidence that already existed. Sections **4** and **12 items
1-3** below are therefore resolved — struck through in place rather than deleted.

**Why the percentage moved down slightly rather than up.** Two tasks were added (`T13`, `V16`, both
closed with evidence) and one was un-ticked (`R9`), because `ledger-status.ps1` had a bug that made it
report "protocol OK" over three tasks that breached the rule it exists to enforce: its evidence scan
stopped at the first blank line, so a caveat written into a second evidence block was invisible to it.
Fixed, and it now has its own committed regression tests. `D10` and `V13` survived scrutiny — D10's
caveat was a stale line for a gate since run and passed, and V13's remaining "Not verified" lines are
mandated by its own Verify list. `R9` genuinely was not finished. The arithmetic going down here is the
protocol working, not the product regressing.

---

## How to use this

Work top to bottom. The order is by how much each unblocks, not by how hard it is. The first item
alone releases eight tasks and three release gates.

When you finish one, paste the evidence into `.kiro/finalreleasefix.md` under that task, or hand it
to the agent and it will file it. **Do not tick anything you did not actually observe** — a false
tick is worse than an open box, because the next reader trusts it.

---

## 1. Clean Windows 11 VM install — releases 8 tasks and 3 gates

**Gates:** G8, G9, G11 · **Tasks:** L5, O11, D5, V2, T6, D2, D3, U10

### Why it is pending
Needs a Windows 11 machine that has never had CA PRO on it. This machine cannot substitute: it has
had development builds, and a VM under VirtualBox is the owner's own to schedule.

### Before you start — this matters
The installer had been packaging a **two-day-stale** `dist` output until 2026-08-26. If you ran a VM
test before that date, **it tested a build with none of the sign-in, browser or uninstall fixes in
it.** Rebuild first:

```
cd apps/desktop-native
powershell -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Platform x64
```

Note the SHA-256 it prints. Carry **that** file to the VM, downloaded through a browser so
SmartScreen behaves as a real user's would.

### Steps

1. Fresh Win11 VM, standard (non-administrator) user account.
2. Download the installer **through a browser**, not a shared folder — SmartScreen only appears on a
   browser-downloaded file.
3. Run it. Expect SmartScreen: **More info → Run anyway**. That is documented and expected.
4. Confirm it installs with **no UAC prompt** (the installer is per-user, `PrivilegesRequired=lowest`).
5. Launch. Confirm the window opens and the sign-in page renders.
6. Sign in with Google. **This is the check that matters most today** — it is the flow that was
   failing, and the fix has never been exercised on a VM.
7. Try a second browser: set Chrome, Firefox or Brave as default in the VM and sign in again.
8. With the app **open**, run uninstall from Settings → Apps. It must **refuse** and say CA PRO is
   running.
9. Close the app, uninstall again. Read the warning page. Answer **No** to deleting local data,
   then confirm `%LOCALAPPDATA%\CA PRO` still exists.
10. Reinstall, then uninstall answering **Yes**, and confirm the folder is gone.

### Expected result
Installs without UAC. Sign-in completes in **any** default browser. Uninstall refuses while running,
warns before removing, and honours the data answer both ways.

### Evidence to capture
- The SHA-256 you installed, and that it matches what `release.ps1` printed
- A screenshot of SmartScreen, and of the app after sign-in
- The exact text of the uninstall refusal, and of the warning page
- `Get-ChildItem HKCU:\Software\Classes\AppUserModelId` after first launch — must be **exactly one**
  CA PRO key, `CAProToolkit.CAPro`, zero GUID-named ones (this is D2's gate; it appears on first
  launch, not at install)

---

## 2. Schedule the backup — the last backup item

**Task:** O4

### Why it is pending
Every backup so far has been run by hand. `schtasks /Query /TN "CAPRO nightly backup"` finds
nothing, so the *habit* is unproven — and the habit is what is there at 3am when a cluster is lost.
The mechanism itself is proven: 43 collections captured, encrypted, copied off-host, restored, 0
mismatches, health 200.

### Steps
The exact line is in `operations-runbook.md` under **Backups**:

```
schtasks /Create /TN "CAPRO nightly backup" /SC DAILY /ST 02:30 /RL HIGHEST /RU SYSTEM ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend\tools\backup-database.ps1"
```

`CAPRO_BACKUP_URI` and `CAPRO_BACKUP_RECIPIENT` are already set at **Machine** level, which is what a
SYSTEM task needs — no further setup.

An agent tried this line on 2026-08-27 and got `ERROR: Access is denied.` — the agent console is
not elevated, and `/RU SYSTEM /RL HIGHEST` needs an administrator prompt. So this genuinely needs
your elevated console; nothing else about it is blocked.

### Expected result
Twenty-four hours later, a **new dated archive** has appeared in
`C:\Users\Saifullah Faizan\OneDrive\CA-PRO-Backups` without anyone running it.

### Evidence to capture
The new filename and its timestamp, plus `schtasks /Query /TN "CAPRO nightly backup" /V /FO LIST`
showing the last run result as `0`.

---

## 3. Sign the human test sheets

**Gates:** G4, G16 · **Tasks:** T6, T12

### Why it is pending
`humantesting.md` §13's sign-off block is blank — tester, date, build, firms, and twelve section
boxes. §12 has rows explicitly marked "agent could not verify". Sign-off is yours by definition.

### Steps
1. Work through `humantesting.md` sections 1, 2, 3 and 9.
2. Fill §13: your name, the date, the build version and SHA-256, and the firms you tested with.
3. Answer §12's agent-could-not-verify rows.
4. Confirm none of §14's eight blocker conditions is true.

### Evidence to capture
The filled §13 block, committed.

---

## 4. ~~Two browser checks in the admin panel~~ — RESOLVED 2026-08-27, nothing here is yours

**Every bullet of U5 and R9 has since been run for real, and both tasks are `[x]`.** U5's Save flow
was exercised in a real browser against a local backend with a scratch database
(`tools/drive-local-panel.mjs`, 10/10, the button actually pressed); its notify refusal paths were
observed with zero network requests (`tools/verify-admin-desktop-release.mjs`, 22/22); R9's toggle
and 403 bullets were executed after the `94a4779` panel-defect deploy, with the flag round-trip and
the non-super 403 observed (a real `FIRM_ADMIN` account, plus a scratch-seeded `USER` account — no
production identity was invented). The blocking bookkeeping question was decided by the owner on
2026-08-27 as T14 = B + C. Evidence lives under U5 and R9 in `.kiro/finalreleasefix.md`.

The original text is kept below for the record.

**Tasks:** U5 and R9 — **R9 is NOT closed; corrected 2026-08-26.** It had been ticked while carrying
its own `Not verified:` and `Gate not run:` lines, which the protocol does not allow, and only a bug in
the ledger checker hid it. It is back at `[~]` with exactly three things left, all needing you:

1. ~~**On screen:** that the 19 checkboxes' **checked state** matches `/api/app-config`.~~
   **DONE 2026-08-26 — no longer yours.** Verified in a real headless browser against the live panel:
   19 checkboxes rendered, all 19 checked states equal to the live values (12 on, 7 off), no box
   disabled (which is how a failed load is distinguished from "everything off"), and the live set is
   mixed so an all-unchecked render could not have matched by accident. See
   `capro-backend/tools/verify-admin-provider-usage.mjs` and `verify-admin-desktop-release.mjs`.
2. **Toggle one low-risk flag and Save**, confirming the echo changes only that key. **An agent
   deliberately did not do this**: it is a write to production feature flags, it changes what every
   user sees, and `R10` is the owner task that decides that state. A verification run is not a licence
   to move it.
3. **A non-super account gets a 403** with the card's own readable message. This needs a second
   account: `mint-admin-token.mjs` mints only for the hardcoded super-admin address and needs an OTP
   from your mailbox. Signing a token locally for a different identity was considered and rejected —
   forging an authentication credential against production to test a refusal is not an agent's call,
   even with a no-op payload.

Verify bullet 4 is done: `node --check super.js` exits 0 and `grep -c featureFlags` returns 23.

### Why it is pending
No browser exists in the agent environment — no puppeteer, no playwright, nothing. Both remaining
bullets need a rendered page and a Network tab.

### Steps
Open `https://api.caprotoolkit.in/admin/super.html` with your super-admin token in localStorage
(`node capro-backend/tools/mint-admin-token.mjs --print`, then
`localStorage.setItem("caproadminjwt", "<token>")`).

1. **Card renders.** Confirm the Desktop Release card appears **below** Welcome Announcement with the
   same visual weight, and that its readout matches the API.
2. **Notify flow.** Press *Notify all users*. Confirm the dialog appears. **Cancel it** and check the
   Network tab shows **zero requests**. Confirm again, type the **wrong** version, and check it says
   *Cancelled* with **still zero requests**.

### Expected result
Cancelling makes no request at all. A wrong version makes no request at all.

### Evidence to capture
A screenshot of the card, and of the Network tab showing zero requests after each cancel.

---

## 5. Cold-read of the operations runbook

**Task:** O5

### Why it is pending
The gate asks whether **a person who has never seen the Hostinger panel** can follow only the
runbook. The author cannot self-certify that, and no agent can stand in for the stranger.

### Steps
Hand `capro-backend/docs/operations-runbook.md` to someone who has not worked on this, and ask them
to reach a mongosh prompt on the backup credential and drive `restore-drill.ps1` to a PASS —
**without asking you anything**.

### Expected result
They get there. Every question they have to ask is a defect in the runbook, not in them.

### Evidence to capture
Who read it, when, and every question they asked. The questions are the finding.

---

## 6. Rollback rehearsal, re-run with all four smoke checks

**Task:** O9

### Why it is pending
The 2026-08-24 rehearsal observed **3 of 4** smoke checks; the fourth, an authenticated read, had no
token. That is now solved — it ran on the 2026-08-26 deploy and passed. But a rehearsal cannot be
improved retroactively.

**It was deliberately not re-run on 2026-08-26**, and the reason is worth keeping: the archive it
would roll back to contains the feature-flag panel defect fixed that day. Briefly restoring a build
that can wipe production flags, while you are working in that panel, is a worse trade than leaving
the rehearsal at 3 of 4.

### Steps
Once two archives exist that both post-date the panel fix, roll back to the older and forward again,
running all four smoke checks on **each** leg. The procedure is in `operations-runbook.md` under
**Deploy** and **Rollback**.

### Evidence to capture
Wall-clock minutes each way, and 4-of-4 on both legs.

---

## 7. Independent legal review

**Task:** L15 · gates L4, L9, L11, L12, L13

### Why it is pending
The owner has verified the legal work and it is published live — that is recorded as the **owner's**
sign-off. L15 asks for an **independent qualified Indian practitioner**, which is a different thing.
The record keeps them separate deliberately: a compliance file that blurs the two is worth less than
one that does not.

### Steps
Engage a practitioner. The pack is: `ca-pro-website/privacy.html`, `ca-pro-website/terms.html`,
`capro-backend/src/config/current-terms.js`, and PLAN.md §37.4's per-class retention bases.

Point them at §37.4's open questions specifically — the actual retention period for working papers,
whether it binds the firm or the platform, whether a consent record may outlive the account, and
whether an append-only trail may keep a name after an erasure request.

### Evidence to capture
The reviewer's name, their qualification, the date, and their answers to those four questions.

---

## 8. Chrome Web Store submission

**Task:** L8

### Why it is pending
Owner-only: needs a signed-in developer-dashboard session. You have said this goes after the product
is fully made.

### Ready when you are
The package is built and validated:

```
audit-nlp-extension\artifacts\ca-pro-toolkit-extension-1.4.4.zip
```

67 entries, 534,609 bytes, **exactly one manifest.json at the archive root** — verified by reading
the finished zip back. Rebuild any time with `npm run package`.

**Do not zip the repository folder.** That is what produced the *"More than one manifest found in
package"* rejection: it carries both `manifest.json` and `dist/manifest.json`.

Version is **1.4.4**, not 1.4.03. A Chrome version's components must be `0` or start with a non-zero
digit, so `03` is invalid — the store would reject it, and so does this repo's own validator.

---

## 9. One toast, observed on screen

**Task:** D2 · **Gate:** G9

### Why it is pending
Needs a signed-in session and a toast visible on a real desktop. The registry half of D2 is closed:
after a clean install and first launch there is exactly one AppUserModelId key, `CAProToolkit.CAPro`,
with the right DisplayName and icon, and zero GUID-named ones.

### Steps
1. Signed in, trigger a due reminder. Confirm the toast shows **CA PRO** and its icon — not
   `CaPro.Desktop`.
2. Then the one that actually matters: create a deadline due ~3 minutes out, let it schedule, **fully
   exit CaPro.Desktop.exe** (`Get-Process CaPro.Desktop` returns nothing), and wait.

### Expected result
**The toast still arrives with the app closed.** If it does not, this task has failed regardless of
what the code looks like.

### Evidence to capture
A photo or screenshot of the toast, and `Get-Process CaPro.Desktop` showing nothing at the moment it
appeared.

---

## 10. ~~Settle one contradiction: V15 is ticked but has no evidence row~~ — RESOLVED 2026-08-26

**Task:** V15 · **Added and closed the same day. Nothing here is yours any more.**

The audit was run rather than the row transcribed. All three of V15's bullets are met and measured:
the script exits 1 with **exactly one** FAIL line, and it is the pre-accepted Settings mute-checkbox
gap the bullet explicitly permits; `grep -c "Got it"` over the run output returns **0**; the
"Read a notice: Shift+Tab" FAIL line returns **0**. Run-wide: **pages reached 25/25, forbidden tokens
0**. `.kiro/release-evidence.md`'s V15 row now carries that run, so the ledger and the evidence file
agree again. The app was closed by the script and confirmed gone.

The original text is kept below for the record.

**Task:** V15 · **Added 2026-08-26**

### Why it is pending
`.kiro/finalreleasefix.md` carries `V15` as `[x]` with an evidence block, while `.kiro/release-evidence.md`
still shows its row as `NOT RUN`. That file's own preamble settles which way to read a disagreement:
*"A tick with no row here is a false tick."* So either the row needs filling from a real run, or V15
needs un-ticking. It was deliberately not resolved by copying the ledger's numbers into the row, because
`release-evidence.md` explicitly forbids transcribing a figure from another document — and its gates need
the UIA audit driven against a rendered window, which an agent working console-only cannot do.

### Steps
Run `powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop-native\tools\ui-route-audit.ps1`
against the unpackaged Release x64 exe with a signed-in session, and confirm the three defects V15 names
are gone: the duplicate "Got it" accessible names on two pages, and the Shift+Tab order break on
*Read a notice*.

### Expected result
Either a clean run that fills the row, or a FAIL that justifies moving V15 back to `[~]`.

### Evidence to capture
The audit's own summary lines (`pages reached`, `forbidden tokens (total)`, `failures`) and the exit code.

---

## 11. The desktop-app screen queue — six tasks, one sitting, ~40 minutes

**Tasks:** L10 (bullets 4-5) · L12 (bullet 13) · L13 (bullets 2-3) · L7 (click-through) · O10 (bullet 5) · R11/R13/R7/R8 · V15 · V2/V4
**Added 2026-08-26.** These are grouped because they share one requirement and nothing else: **the
WinUI desktop app has to be on a screen.**

### Why an agent did not do these
Not a capability gap — a courtesy one, stated so you can overrule it. Launching `CaPro.Desktop.exe`
puts a window up and steals focus. You said you were studying, and this machine is the one you sit
exams on, so an agent running a UI Automation sweep could interrupt something that matters more than a
task tick. **Every script these need is written and passing on everything else.** If you are away from
the machine and want them run, say so and they take one pass.

### What to look at, once, with the app open and signed in
1. **Security page** — the "WHAT IS KEPT, AND FOR HOW LONG" card. The Accounts line must show the new
   deletion text and name a real contact (L10 bullet 4). Then pull the network and re-open it: it must
   fall back to `RetentionDisclosure.UnstatedLine`, **not** a cached copy of the old false claim
   (L10 bullet 5). The same card carries L12 bullet 13's erasure wording and grievance address.
2. **Sign-in screen** — click the privacy hyperlink; it must reach the published policy (L7).
3. **Sign in on the shipped build** against the deployed backend: no terms mismatch (L13 bullet 3), and
   on a build carrying the OLD terms hash, the changed-terms recovery path (L13 bullet 2).
4. **Rate-limited state** — with the DeepSeek daily cap set to 2 on a non-production instance, the third
   AI Audit Scan must show the rate-limited surface, not a crash or a generic server error (O10 bullet 5).
5. **`ui-route-audit.ps1`** — settles V15, and V2/V4's remaining coverage.

### Evidence to capture
A screenshot of the Security card online and offline, the terms-mismatch behaviour, and the audit's
summary lines (`pages reached`, `forbidden tokens (total)`, `failures`) plus its exit code.

---

## 12. Two admin-panel actions an agent refused on purpose — items 1-3 RESOLVED 2026-08-27, only O11 remains

**Items 1-3 have since been run for real** (see section 4's resolution note: U5 bullet 3 against a
local backend and scratch database, R9 bullets 2-3 after the `94a4779` deploy with a real non-super
identity). **Item 4 — O11's raise-`minSupportedVersion`-and-watch-a-real-desktop — is still yours**:
it is a production write that reaches every installed client, and it needs a real desktop on screen
to observe the "Update required" surface. The original text is kept below for the record.

**Tasks:** U5 (bullet 3) · R9 (bullets 2-3) · O11
**Added 2026-08-26.** The panel itself is now verified by machine — 30 assertions across
`tools/verify-admin-desktop-release.mjs` and `tools/verify-admin-provider-usage.mjs`, all passing
headless against the live panel. What is left is only the things that **change production state or need
a second identity**:

1. **U5 bullet 3 — a valid-values Save on the Desktop Release card.** Its own text expects
   `desktopRelease: null` afterwards, which is now a stale premise: release 0.1.2 **is** announced, so
   running it as written would overwrite an announced release. Decide whether you want that bullet
   re-scoped or performed deliberately.
2. **R9 bullet 2 — toggle one low-risk feature flag and Save**, confirming the echo changes only that
   key. An agent will not do this: it changes what every user sees, and `R10` is the owner task that
   decides that state.
3. **R9 bullet 3 / U5 bullet 6 — a non-super account gets a readable 403.** Needs a second account.
   `mint-admin-token.mjs` mints only for the hardcoded super-admin address and needs an OTP from your
   mailbox. Signing a token locally for a different identity was considered and rejected: forging an
   authentication credential against production to test a refusal is not an agent's call.
4. **O11 — raise `minSupportedVersion` and observe a real desktop show "Update required"**, then lower
   it. A production write reaching every client.

### Evidence to capture
For the 403: the status line's exact text. For the flag toggle: the echoed map, and a
`curl /api/app-config` before and after showing only that key moved.

---

## 13. One decision, five minutes: L16

**Task:** L16 · **Added 2026-08-26**

L10's bullet 3 demands `grep -rn "no route that removes" .` return **0 hits** repo-wide. It returns 16,
and **0 is unreachable while the fix stays pinned** — `capro-backend/tests/data-retention-contract.mjs:639`
must name the forbidden string in order to assert its absence. Satisfying the grep would mean deleting
the only guard against the false claim coming back.

The substance the bullet was reaching for is already proved against production: the live
`accountDeletion` text is correct and a grep for the false claim over the live response returns 0.

**L16 carries a drafted replacement wording, already measured to pass.** Reply accept or refuse in one
clause. Refusing is legitimate — it just leaves L10 permanently unmeetable, and that should be a
deliberate choice rather than a thing everyone steps over.

---

## 14. One decision, five minutes: V27 — V2's `-Packaged` gate cannot exist any more

**Task:** V27 · unblocks V2 (BLOCKER) · **Added 2026-08-27**

V2's fourth Verify bullet tests the UIA audit's `-Packaged` branch "against the still-installed
MSIX 0.1.1.1". That package no longer exists anywhere: `Get-AppxPackage` returns nothing, no
.msix/.appx artifact exists in the repo, D1 removed MSIX from the build, and an unsigned MSIX
cannot be rebuilt and installed (hard-fails `0x800B010A`, no override). Every other V2 bullet is
run and passing.

**V27 carries a drafted replacement wording** (the branch is present and intact, verified by
reading the file fresh, recorded as preserved dead code from the completed MSIX migration).
Accept or refuse in one clause. Refusing leaves V2, a BLOCKER, permanently `[~]` over a package
that can never exist again — legitimate, but it should be deliberate.

**Related:** `D3` and `D5` are blocked on the same judgement (their MSIX-machine gates need a
machine with the old MSIX genuinely installed, which no longer exists here either). If you accept
V27's shape, say whether the same reading applies to D3/D5's real-machine gates or whether those
wait for a VM that has the old MSIX.

---

## Resolved since the last version of this file — do not redo these

- **The 23 Mongo-dependent backend suites** (was blocked under `V13` as "Docker is deliberately down").
  All 23 now run: **962 assertions, 0 failed.** The stated reason was stale twice over — Docker is up,
  and the real blocker was that every suite defaults to port **27017** while the containers publish
  **27117** and **27118**. No test file needed editing. Running them found two real defects, both fixed
  under `V16`: six quota-persistence assertions that no gate run had ever executed, and a suite that
  crashed on a null dereference instead of reporting a verdict.
- **`D10`'s download-page gate** (was blocked on `D9` not existing). The page is live; the gate was run
  and passed, and re-verified independently — the served page is byte-identical to the repo copy.
- **The three `LiveBackendContractTests`**, which had been silently skipping in every run this project
  has recorded while being counted inside a `Passed!` line. They pass against production: the real Core
  figure is **2953/2953 with 0 skipped**, not 2950 with 3 skipped.
- **Every gate that was deferred for "no browser exists in the agent environment."** That premise was
  false. Chrome is installed at the standard path, a full Playwright browser cache sits in
  `LOCALAPPDATA\ms-playwright`, and `capro-backend/tools/browser-drive.mjs` — a dependency-free CDP
  driver — had already been committed *for exactly these gates* and imported by nothing
  (`grep -rln browser-drive` returned only itself). Two new headless harnesses now cover **30
  assertions, all passing** against the live panel: U5's card-render and both zero-request notify
  refusal paths, U5's invalid-input message, R9's 19-checkbox checked-state comparison, and O10's
  Provider usage card. **U5 item 4 in this file is therefore no longer the whole ask** — only the two
  production-state items in section 12 remain.
- **O10's `Blocked on: OWNER` line.** Resolved. It rested entirely on the Provider usage card needing a
  browser session.
- **L13's "is the rewritten Terms deploy live?" question.** It is:
  `/api/auth/terms/current` returns `documentHash 70b649d9b113e8b3...`, version `2026-08-23`, **17
  sections**, naming Kolkata and the entity. Any note elsewhere saying a Terms redeploy is still pending
  is stale.
- **Both published legal pages match the repository.** `privacy.html` is byte-identical;
  `terms.html` differs only by line endings (0 CR served vs 180 in the Windows checkout) and is
  identical once normalised.
- **L12's deletion cascade.** Its old note that `deleteFirmForSuper` "handles only 3 of the 32
  collections" is stale — it now drives the classified plan. Six of its seven gates pass, including the
  coverage gate run **in both directions**: adding a throwaway firm-scoped model makes the contract test
  fail by name and abort, and removing it returns 75/75. Only the on-screen Security card remains
  (section 11).
