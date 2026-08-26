# Backup and recovery — proven status

**Status: PROVEN end to end on 2026-08-26.** Production is recoverable, and that is a measured
result rather than an assumption. This file exists so the proof can be cited later without anyone
re-deriving it, and so a future reader can tell what was actually demonstrated from what was
merely configured.

Owner-supplied record, transcribed 2026-08-26. The drill itself was run by the owner on this
machine; the figures below are theirs.

---

## What the chain proves

    production Atlas
      -> mongodump
      -> GPG encryption
      -> off-host copy (OneDrive)
      -> decrypt
      -> mongorestore into scratch-drill
      -> 43/43 collection count verification
      -> backend health 200
      -> DRILL PASSED

Every arrow in that chain was executed. Nothing in it is inferred from the step before it.

---

## Configuration, as it actually stands

| Item | Value | Where |
|---|---|---|
| Backup source URI | `CAPRO_BACKUP_URI` | **Machine**-level environment variable |
| GPG recipient | `CAPRO_BACKUP_RECIPIENT` | **Machine**-level environment variable |
| Off-host destination | `C:\Users\Saifullah Faizan\OneDrive\CA-PRO-Backups` | verified present, holds a real archive |
| mongodump | 100.18.0 | installed and verified |
| mongosh | 2.10.0 | installed and verified |

**Machine level, not user level, and that is deliberate.** A scheduled task running as SYSTEM does
not inherit a user's environment. Setting these with `setx /M` is what makes the scheduled path work
at all; setting them per-user would produce a task that succeeds by hand and fails on its schedule,
which is the worst of both.

Neither variable is in `capro-backend/.env`, and neither should be. `.env` is read by the
application; these are read by the backup tooling, and keeping the production backup credential out
of the app's own configuration file is the right separation.

---

## Backup run — what was captured

- **43 collections** captured from production
- Encrypted `.archive.gz.gpg` produced
- **Plaintext archive deleted after encryption** — the step that matters most, because a backup
  process that leaves a decrypted dump on disk has moved the risk rather than removed it
- Manifest generated alongside the archive
- Encrypted archive copied to the OneDrive off-host destination
- Retention logic executed

## Restore drill — what was verified

Restored into the protected `scratch-drill` database, which the drill script refuses to run against
any database whose name does not mark it as scratch.

```
collections compared : 43
mismatches           : 0
health               : 200
db state             : connected
background           : ready

==> DRILL PASSED
```

All 43 collections matched their manifest document counts, including the GST collections that carry
the most user-visible consequence if a restore silently under-delivers:

| Collection | Restored / expected |
|---|---|
| `importbatches` | 9 / 9 |
| `importrows` | 30 / 30 |
| `reconciliationitems` | 11 / 11 |
| `reconciliationruns` | 1 / 1 |

The scratch database was dropped after the drill.

---

## What this closes, and what it does not

**Closed.** O3 and O4's backup and recovery *capability* is proven. It should not be carried as an
outstanding technical blocker, and the long-standing statement that "production has no restorable
copy" is no longer true.

**Still open — one item.** The **scheduled** backup has not been proven. No task exists yet:

```
schtasks /Query /TN "CA PRO Backup"
ERROR: The system cannot find the file specified.
```

So every backup so far has been run by hand. The distinction matters: a manual backup proves the
mechanism, a scheduled one proves the *habit*, and it is the habit that is there at 3 a.m. when a
cluster is lost. O4's own remaining verify bullet is exactly this — a new dated archive appearing at
the off-host destination without anyone running it.

The `schtasks /Create` line is recorded verbatim in `operations-runbook.md`, along with the warning
about SYSTEM not inheriting a user's environment (already handled above).

---

## The one caveat worth stating plainly

The off-host destination is a **OneDrive folder on the same machine that runs the backup**. That
defends against the cluster being lost, a bad migration, or a truncated collection — which is what
this was built for. It does not defend against this machine being lost or encrypted while OneDrive
is syncing, because the local copy and the "off-host" copy are the same file until the sync
completes and are both reachable from the same account afterwards.

That is a reasonable position for a single-operator product today, and it is a real improvement over
having nothing. It is written down so nobody later mistakes it for geographic redundancy.
