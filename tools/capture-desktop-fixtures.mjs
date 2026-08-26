// tools/capture-desktop-fixtures.mjs
//
// V12 (.kiro/finalreleasefix.md): gives the desktop's contract tests a real coupling to this
// backend. Before this tool, every payload in apps/desktop-native/tests/CaPro.Desktop.Core.Tests
// /ApiContractTests.cs was a hand-typed C# string literal that had never touched this backend --
// a controller could rename a field and all 2610+ desktop tests would still pass while the
// shipped app broke in the field. This tool boots the real Express app in-process against a
// disposable local MongoDB, seeds one real firm through the real sign-in provisioning code path,
// calls the real routes, and writes what actually comes back as committed JSON fixtures the
// desktop test suite reads.
//
// Route discovery is NOT hand-picked (V12 step 1's own requirement): every static-literal route
// CaProApiClient.cs calls is parsed out of that file at run time by parseDesktopRoutes() below,
// the same way tools/ui-route-audit.ps1 derives its page list from PageRouteCatalog.cs instead of
// hand-copying it. 32 static routes were found this way. Each is attempted; a route this tool
// cannot yet safely or completely drive (a multipart body, a second firm to switch into, a
// pre-existing join code, an announced release to dismiss) is recorded in the manifest as
// "skipped" with the real reason, rather than silently absent -- an omission a human would
// otherwise have to rediscover by diffing the route list against the fixture directory by hand.
//
// Never run against production. The seed data below is written straight into whatever
// MONGODB_URI is active, and the DeepSeek/OCR.space keys are deliberately cleared so the 5
// paid-provider routes capture a real, safe "provider not configured" response instead of ever
// making a real billed call -- capturing that shape is itself a legitimate, valuable fixture
// (ApiStatus.ProviderUnavailable is a real state the desktop must parse), not a workaround.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseStaticRoutes as parseStaticRouteLiterals,
  parseInterpolatedRoutes as parseInterpolatedRouteLiterals,
  parseIndirectRoutes,
  parseAllRouteLiterals,
} from "./desktop-route-parsers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const desktopRoot = resolve(repoRoot, "..", "apps", "desktop-native");
const clientPath = join(desktopRoot, "src", "CaPro.Desktop.Core", "Api", "CaProApiClient.cs");
// --out <dir> lets the drift gate (tools/run-gates.ps1) re-capture into a disposable temp
// directory and diff it against the committed Fixtures/ without ever touching the committed
// copy itself. Omitted for a real capture, which always writes the committed location.
const outArgIndex = process.argv.indexOf("--out");
const fixturesDir = outArgIndex !== -1 && process.argv[outArgIndex + 1]
  ? resolve(process.argv[outArgIndex + 1])
  : join(desktopRoot, "tests", "CaPro.Desktop.Core.Tests", "Fixtures");

mongoose.set("bufferTimeoutMS", 5_000);
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
// Prefer the replica set. One route (`PATCH api/digests/settings`) runs inside a MongoDB
// transaction, which a standalone mongod rejects with "Transaction numbers are only allowed on a
// replica set member or mongos" -- that was recorded here as a genuine environment limitation, and
// it stopped being one once a replica set existed on 27118. Falls back to the standalone dev
// container so this tool still runs where the replica set is not up; the transactional route then
// skips itself with its real reason rather than failing the whole capture.
async function pickDatabaseUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  // A NAME, not a URI. The drift gate needs its own disposable database but must not also choose
  // the server, or it bypasses the probe below and silently loses transaction support -- which is
  // exactly the bug that made its first run report two routes as "drift".
  const dbName = process.env.CAPTURE_DB_NAME || "capro-desktop-fixtures-capture";
  const replicaSet = `mongodb://127.0.0.1:27118/${dbName}?replicaSet=rs0`;
  const standalone = `mongodb://127.0.0.1:27117/${dbName}`;

  try {
    const probe = await mongoose.createConnection(replicaSet, {
      serverSelectionTimeoutMS: 2500,
    }).asPromise();
    await probe.close();
    return replicaSet;
  } catch {
    return standalone;
  }
}

process.env.MONGODB_URI = await pickDatabaseUri();
const usingReplicaSet = /replicaSet=/.test(process.env.MONGODB_URI);
// Deliberately cleared -- see the file header. Never let this tool make a real paid call.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.OCR_SPACE_API_KEY;

// ─── Step 1: parse the real route list out of CaProApiClient.cs, not a hand-kept copy ──────

// The regexes themselves now live in ./desktop-route-parsers.mjs, imported at the top of this file,
// because tests/desktop-route-discovery-contract.mjs needs the same definitions and nothing can
// import THIS file to get them -- it drops a database at module scope. Two copies of a discovery
// regex is how a discovery gap gets closed in one place and left open in the other.
//
// The history worth keeping: `\(\s*` rather than `\(` matters because the client formats longer
// calls with a newline after the opening paren, and without tolerating that this parser silently
// missed TEN real static routes, every one a list/index GET -- cases, engagements,
// engagements/working-papers, filing-dashboard, gst-reconciliation/runs, review-queue, tasks/board,
// taxworker/clients, tds-health/runs, workspace/search. They were never skipped with a reason, they
// were never DISCOVERED, so "uncovered by plan: 0" was measured against a set that already excluded
// them. A discovery bug is worse than a coverage gap, because it reports as completeness. The same
// thing was true again, in a different form, for the ten indirectly-built routes below.
function parseDesktopRoutes(sourcePath) {
  return parseStaticRouteLiterals(readFileSync(sourcePath, "utf8"));
}

const staticRoutes = parseDesktopRoutes(clientPath);

/**
 * The OTHER half of the client's surface: routes built with an interpolated string, e.g.
 * `$"api/tds-health/runs/{Uri.EscapeDataString(runId)}/checks/{Uri.EscapeDataString(checkId)}"`.
 *
 * WHY THESE ARE COUNTED SEPARATELY RATHER THAN IGNORED
 * ---------------------------------------------------
 * A literal scan cannot capture them: each needs a real id for the entity it addresses, and the
 * ids only exist once this capture has created the entity. Until this session they were not merely
 * uncaptured, they were UNCOUNTED -- the tool reported "routes discovered" as though the static
 * literals were the whole surface, which is how "33 of 33" came to read as full coverage while a
 * quarter of the real surface had never been looked at (and the interpolated majority never at all).
 *
 * So they are discovered, normalised and REPORTED, but deliberately kept out of `planless`: making
 * them fail the run today would turn a green gate red for a gap that has always existed and that
 * nothing in this pass closes. The number is the honest measure of how far the desktop-to-backend
 * coupling actually reaches, and it should go down over time rather than being hidden.
 */
// Hole collapsing (`{Uri.EscapeDataString(runId)}` -> `{runId}`, `{Math.Clamp(limit, 1, 100)}` ->
// `{limit}`) lives in normaliseRouteTemplate in ./desktop-route-parsers.mjs, so the key is a stable
// route shape rather than a snapshot of the C# inside it -- otherwise it changes whenever someone
// edits a clamp bound and every fixture bound to it silently becomes uncaptured. It also now drops
// trailing method names, so `{Uri.EscapeDataString(id.Trim())}` keys as `{id}` and not as `{Trim}`.
function parseInterpolatedRoutes(sourcePath) {
  return parseInterpolatedRouteLiterals(readFileSync(sourcePath, "utf8"));
}

const interpolatedRoutes = parseInterpolatedRoutes(clientPath);

// Form 3, and the denominator both other forms are measured against. See the module's header for
// why these were uncounted rather than merely uncaptured.
const indirectRoutes = parseIndirectRoutes(readFileSync(clientPath, "utf8"));
const allRouteLiterals = parseAllRouteLiterals(readFileSync(clientPath, "utf8"));

// ─── Step 2: boot the real app in-process, exactly as tests/production-error-envelope.mjs does ──

const toFileUrl = (...segments) => pathToFileURL(join(repoRoot, ...segments)).href;

// app.js alone never connects to MongoDB -- connectDB() is server.js's job, called from its own
// bootstrap() alongside index provisioning, rollout-flag readiness and the digest schedulers.
// This tool needs the connection but deliberately NOT the schedulers (a real cron firing during
// a fixture capture could send a real digest email), so it calls connectDB() directly rather
// than importing server.js or reimplementing bootstrap()'s fuller sequence.
const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
const { default: app } = await import(toFileUrl("src", "app.js"));
const { default: User } = await import(toFileUrl("src", "models", "User.js"));
const { default: Firm } = await import(toFileUrl("src", "models", "Firm.js"));
const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(
  toFileUrl("src", "models", "AppConfig.js")
);
const { ensurePersonalFirm } = await import(
  toFileUrl("src", "services", "firm-provisioning.service.js")
);

await connectDB();
// A fresh disposable database per run -- never accumulate stale seed data across captures.
await mongoose.connection.dropDatabase();

// Provision indexes the way a real boot does. connectDB() alone does not: server.js owns the
// "provision-indexes" bootstrap stage, and this tool deliberately skips server.js so no scheduler
// fires during a capture. Without it the capture runs against a database no real deployment is
// ever in, and routes that assert storage readiness refuse -- reproduced as a 503 from every GST
// import commit, "GST storage is not rollout-ready", which is also how that production gap was
// found in the first place.
const { ensureRequiredIndexes } = await import(
  toFileUrl("src", "services", "index-provisioning.service.js")
);
const indexOutcome = await ensureRequiredIndexes();
if (indexOutcome.failures?.length) {
  console.log("index provisioning failures: " + JSON.stringify(indexOutcome.failures).slice(0, 300));
}

// Every flag defaults false on a fresh singleton (AppConfig.js's own DEFAULT_FEATURE_FLAGS), and
// AppConfig.getInstance() synthesises and CACHES an all-false in-memory doc for 30s when none is
// persisted -- well past this whole capture run. Persisting every flag ON before the first
// request avoids that cache trap and reaches the routes gated by rollout.middleware.js
// (noticeCases, assuranceEngagements, homeWorkspace, ...) instead of 404ing on all of them.
await AppConfig.create({
  _id: "singleton",
  featureFlags: Object.fromEntries(Object.keys(DEFAULT_FEATURE_FLAGS).map((key) => [key, true])),
  // Seeded here, not later, for the reason above the AppConfig.create call.
  // mandatory:false is load-bearing: a mandatory update answers 409 by design, so capturing it
  // would record the refusal shape rather than the dismissal shape the desktop actually parses.
  desktopRelease: {
    latestVersion: "0.1.3.0",
    minSupportedVersion: "",
    downloadUrl: "https://caprotoolkit.in/download.html",
    releaseNotes: "Fixture capture announcement.",
    mandatory: false,
    announcementId: "fixture-announcement-1",
    announcedAt: new Date(),
    enabled: true,
    updatedAt: new Date(),
  },
});

const server = app.listen(0);
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = `http://127.0.0.1:${server.address().port}`;

// ─── Step 3: seed one real user + firm through the real sign-in provisioning path ──────────

let user = await User.create({
  email: "desktop-fixtures@example.invalid",
  name: "Desktop Fixture User",
  role: "USER",
  accountType: "INDIVIDUAL",
  isActive: true,
});
user = await ensurePersonalFirm(user);

function mintToken(forUser) {
  return jwt.sign(
    {
      id: String(forUser._id),
      email: forUser.email,
      role: forUser.role,
      accountType: forUser.accountType,
      firmId: forUser.firmId,
      isActive: forUser.isActive,
      tv: forUser.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const token = mintToken(user);

async function call(method, path, { body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(base + "/" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/**
 * POST a real multipart body. Node 24 has FormData/Blob natively, so this needs no dependency and
 * produces a genuine multipart/form-data request that multer parses as `req.file`.
 *
 * Deliberately does NOT set Content-Type: fetch derives it from the FormData, including the
 * boundary. Setting it by hand is the classic way to make multer see no file at all.
 */
async function callMultipart(method, path, { fileField = "file", fileName, contentType, bytes, fields = {} }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append(fileField, new Blob([bytes], { type: contentType }), fileName);

  const response = await fetch(base + "/" + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

// ─── Step 4: per-route capture plan ─────────────────────────────────────────────────────────
//
// Generic capture (no auth, no body) covers most GETs. Anything needing a request body, a
// chained id from an earlier create, or a prerequisite this seed does not seed is a named
// `capture` function below; anything genuinely out of reach right now is a `skip` reason.

const captured = [];
const skipped = [];
const chain = {};

const plan = new Map();

function define(method, path, handler) {
  plan.set(`${method} ${path}`, handler);
}

// Simple authenticated GETs -- work immediately against the freshly seeded personal firm.
for (const path of [
  "api/auth/me",
  "api/firms/me",
  "api/firms/workspaces",
  "api/home/summary",
  "api/stats/clients-to-chase-today",
  "api/reminders",
  "api/digests/preferences",
  "api/taxworker/stats",
  "api/taxworker/templates",
]) {
  define("GET", path, async () => call("GET", path));
}

// Public, unauthenticated GETs.
define("GET", "api/app-config", async () => call("GET", "api/app-config", { auth: false }));
define("GET", "api/auth/terms/current", async () =>
  call("GET", "api/auth/terms/current", { auth: false }),
);

// Creates that need only fields this seed already has.
define("POST", "api/reminders", async () => {
  const result = await call("POST", "api/reminders", {
    body: { typeId: "GSTR-3B", dueDateISO: "2026-09-20", clientLabel: "Fixture Client" },
  });
  if (result.json?.reminder?._id) chain.reminderId = result.json.reminder._id;
  return result;
});

define("POST", "api/tasks", async () => {
  const result = await call("POST", "api/tasks", {
    body: {
      clientName: "Fixture Client",
      title: "Fixture desktop-contract task",
      dueDateISO: "2026-09-20",
    },
  });
  if (result.json?.task?._id) chain.taskId = result.json.task._id;
  return result;
});

// Several routes below need a real Client document id (case-record.service.js and
// engagement.service.js both call requireFirmClient(input.clientId, firmId)). staticRoutes is
// iterated in alphabetical order, which runs "api/cases" before "api/taxworker/clients" -- so
// this creates the prerequisite client itself on first need, cached in chain.taxworkClientId,
// rather than depending on iteration order to have captured api/taxworker/clients already.
async function ensureClientId() {
  if (chain.taxworkClientId) return chain.taxworkClientId;
  const result = await call("POST", "api/taxworker/clients", {
    body: { name: "Fixture Taxworker Client" },
  });
  chain.taxworkClientId = result.json?.client?._id ?? null;
  return chain.taxworkClientId;
}

define("POST", "api/taxworker/clients", async () => {
  const result = await call("POST", "api/taxworker/clients", {
    body: { name: "Fixture Taxworker Client" },
  });
  if (result.json?.client?._id) chain.taxworkClientId = result.json.client._id;
  return result;
});

define("POST", "api/taxworker/sessions", async () => {
  const clientId = await ensureClientId();
  if (!clientId) return { skip: "api/taxworker/clients did not return a usable client id" };
  return call("POST", "api/taxworker/sessions", {
    body: { clientId, taxType: "GST_MONTHLY" },
  });
});

define("POST", "api/cases", async () => {
  const clientId = await ensureClientId();
  if (!clientId) return { skip: "api/taxworker/clients did not return a usable client id" };
  const result = await call("POST", "api/cases", {
    body: {
      clientId,
      caseType: "GST_NOTICE_ASSESSMENT",
      title: "Fixture case",
      mutationKey: "fixture-capture-case-001",
    },
  });
  if (result.json?.case?._id) chain.caseId = result.json.case._id;
  return result;
});

define("POST", "api/engagements", async () => {
  const clientId = await ensureClientId();
  if (!clientId) return { skip: "api/taxworker/clients did not return a usable client id" };
  const result = await call("POST", "api/engagements", {
    body: {
      clientId,
      engagementType: "STATUTORY_AUDIT",
      scope: "Fixture scope for desktop contract capture.",
      targetDate: "2026-12-31",
      // R15's relaxation lets a firm's own OWNER/ADMIN membership satisfy assertReviewerRole
      // (engagement.service.js), which the seeded user holds on its own personal firm.
      reviewerUserId: String(user._id),
      mutationKey: "fixture-capture-engagement-001",
    },
  });
  if (result.json?.engagement?._id) chain.engagementId = result.json.engagement._id;
  return result;
});

// Un-skipped 2026-08-23. The "second real firm id" this needs is the one `api/firms` creates a few
// lines below and caches as chain.sharedFirmId. operationId is required for the same reason it is
// on `api/firms`: beginWorkspaceRequest -> workspaceOperationService.claim reads req.body.operationId,
// and without it the claim is untracked and the response carries no "operation" key for
// ResponseMapper.ReadWorkspaceOperation to read - a capture-realism gap, not a backend bug.
// The firm is created here on demand rather than trusting alphabetical iteration order.
define("POST", "api/firms/switch", async () => {
  if (!chain.sharedFirmId) {
    const seed = await call("POST", "api/firms", {
      body: {
        displayName: "Fixture Switch Target",
        handle: "fixture-switch-target",
        operationId: randomUUID().replaceAll("-", ""),
      },
    });
    chain.sharedFirmId = seed.json?.firm?._id ?? null;
  }
  return call("POST", "api/firms/switch", {
    body: { firmId: chain.sharedFirmId, operationId: randomUUID().replaceAll("-", "") },
  });
});

// Un-skipped 2026-08-23. The "pre-existing set of task ids" is the task `api/tasks` already creates
// and caches as chain.taskId; created here on demand so this does not depend on iteration order.
// Route is requireFirmAdmin, which the capture user satisfies as the firm's own creator/OWNER.
// normalizePatch accepts status/assignedTo/dueDateISO; status is the least stateful of the three.
define("POST", "api/tasks/bulk/preview", async () => {
  if (!chain.taskId) {
    const seed = await call("POST", "api/tasks", {
      body: {
        title: "Fixture bulk-preview task",
        clientName: "Fixture Client",
        dueDateISO: "2026-12-31",
      },
    });
    chain.taskId = seed.json?.task?._id ?? null;
  }
  return call("POST", "api/tasks/bulk/preview", {
    body: { items: [{ taskId: chain.taskId, patch: { status: "IN_PROGRESS" } }] },
  });
});

define("POST", "api/firms", async () => {
  // operationId is not optional in practice: CaProApiClient.CreateFirmAsync validates it
  // client-side (IsOperationId, a lowercase GUID-N) before ever sending the request, so every
  // real call carries one. Confirmed live, directly, that omitting it (this handler's first
  // draft) reaches a genuinely different code path: workspaceOperationService.claim() reports
  // untracked, `createFirm` returns a bare {firm, workspace} with no "operation" key at all, and
  // ResponseMapper.ReadWorkspaceOperation (which every real desktop call needs, since it always
  // sends operationId) has nothing to read -- not a backend contract bug, a capture realism gap.
  const result = await call("POST", "api/firms", {
    body: {
      displayName: "Fixture Shared Firm",
      handle: "fixture-shared-firm",
      operationId: randomUUID().replaceAll("-", ""),
    },
  });
  if (result.json?.firm?._id) chain.sharedFirmId = result.json.firm._id;
  return result;
});

// welcomeAnnouncement carries a real default (version "v1-ai-launch", enabled: true) even on a
// fresh singleton, per AppConfig.js's own schema default -- confirmed by reading the captured
// api/app-config fixture directly rather than assuming this needed a real announcement seeded.
define("POST", "api/app-config/dismiss-welcome", async () =>
  call("POST", "api/app-config/dismiss-welcome"),
);

define("PATCH", "api/digests/preferences", async () =>
  call("PATCH", "api/digests/preferences", { body: { dailyEnabled: true, weeklyEnabled: true } }),
);

// L12: the desktop's erasure-request write. Captured with requestErasure:false deliberately --
// withdrawing a request that was never made is a no-op, so the capture leaves no state behind and
// erasureRequestedAt comes back null, which keeps the fixture stable across runs. Capturing the
// true case would bake a fresh timestamp into the fixture and read as drift on every re-capture.
define("PATCH", "api/auth/me", async () =>
  call("PATCH", "api/auth/me", { body: { requestErasure: false } }),
);

// Paid-provider routes: keys are cleared above, so these capture the real, safe
// ApiStatus.ProviderUnavailable shape rather than ever making a billed call.
define("POST", "api/audit/insights", async () =>
  call("POST", "api/audit/insights", {
    body: { rawText: "Fixture capture text for the insights route.", candidates: [], catalog: [] },
  }),
);
define("POST", "api/audit/refine", async () =>
  call("POST", "api/audit/refine", {
    body: { rawText: "Fixture capture text.", topicId: "x", topicName: "Fixture topic" },
  }),
);
define("POST", "api/audit/standard-guidance", async () =>
  call("POST", "api/audit/standard-guidance", { body: { code: "SA-700" } }),
);
define("POST", "api/audit/reminder-message", async () =>
  call("POST", "api/audit/reminder-message", {
    body: {
      clientName: "Fixture Client",
      serviceType: "GST",
      type: "pending",
      daysPending: 5,
      dueDate: "2026-09-20",
      tone: "polite",
    },
  }),
);


// ── Routes that used to be skipped ──────────────────────────────────────────────────────────
//
// TWO OF THE OLD SKIP REASONS WERE SIMPLY WRONG, and that is worth stating rather than quietly
// fixing. `POST api/imports/preview` and `POST api/imports/gstr2b/convert` were both recorded as
// needing "a real multipart file body this tool does not yet build". They do not. Reading
// CaProApiClient.cs, preview sends `JsonContent.Create(body)` with the file's TEXT in a `text`
// field, and gstr2b/convert sends a plain `{"json": ...}` string body. Neither route has multer on
// it. The skips were inferred from the routes' subject matter rather than from what the client
// actually sends, and they survived three passes because a skip with a confident reason attached
// reads like a finding. Only `POST api/cases/ocr` is genuinely multipart.

// CLIENTS is the one preview kind with no statutory context to invent: its spec requires exactly
// one mapped field, `name`. `mapping` is field -> source column header, not the reverse.
define("POST", "api/imports/preview", async () =>
  call("POST", "api/imports/preview", {
    body: {
      kind: "CLIENTS",
      text: "Client Name,PAN\nVerity Textiles Private Limited,AAACV1234K\nDhanraj & Sons,AAAFD5678L\n",
      mapping: { name: "Client Name", pan: "PAN" },
      delimiter: ",",
    },
  }),
);

// The converter reads a GSTR-2B export's own shape. This is the minimum the real portal file has
// that the converter navigates; it is a shape fixture, not a data fixture.
define("POST", "api/imports/gstr2b/convert", async () =>
  call("POST", "api/imports/gstr2b/convert", {
    body: {
      json: {
        data: {
          docdata: {
            b2b: [
              {
                ctin: "27AAACV1234K1ZP",
                trdnm: "Verity Textiles Private Limited",
                inv: [
                  {
                    inum: "INV-0001",
                    dt: "01-07-2026",
                    val: 118000,
                    itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, iamt: 18000 } }],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  }),
);

// The one genuinely multipart route. The OCR provider key is deliberately cleared at the top of
// this file, so this captures the real "provider not configured" refusal -- which is itself a shape
// the desktop must parse (ApiStatus.ProviderUnavailable), not a workaround.
define("POST", "api/cases/ocr", async () =>
  callMultipart("POST", "api/cases/ocr", {
    fileField: "file",
    fileName: "notice.png",
    contentType: "image/png",
    // "true" as TEXT, matching CaProApiClient.cs:3095 and the server's
    // String(req.body?.consent).toLowerCase() === "true". Without it the route answers
    // OCR_CONSENT_REQUIRED, which is a real shape but not the one this route exists to serve.
    fields: { consent: "true" },
    // A real 1x1 PNG, so multer sees a genuine file rather than an empty part.
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  }),
);

// The announcement it dismisses is seeded onto the AppConfig singleton at the top of this file,
// before the server starts, so it is already visible past getInstance()'s 30-second cache. The
// route under test is the DISMISSAL, not the announcement, which is why this does not drive the
// super-admin announce route -- this capture holds no super-admin identity.
define("POST", "api/app-config/dismiss-desktop-update", async () =>
  call("POST", "api/app-config/dismiss-desktop-update", {
    body: { announcementId: "fixture-announcement-1" },
  }),
);

// Needs a join code for a firm the caller is NOT already in, so this builds both sides itself.
//
// TWO SEPARATE THROWAWAY USERS, and the second one is the point. Joining a firm SWITCHES the
// caller's active workspace, so having the main capture user join would have silently changed what
// every later route sees. It did, on the first attempt: `GET api/firms/me` started returning the
// host firm instead of "Fixture Shared Firm" and its fixture check failed. That is the capture
// contaminating itself -- a fixture that is individually valid while describing a state no real
// session would be in. A dedicated joiner keeps the main user's workspace exactly as the other 32
// routes found it.
define("POST", "api/firms/join", async () => {
  const provision = async (email, name) => {
    const created = await User.create({
      email,
      name,
      role: "USER",
      accountType: "INDIVIDUAL",
      isActive: true,
    });
    return ensurePersonalFirm(created);
  };

  const asUser = async (forUser, method, path, body) => {
    const response = await fetch(base + "/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mintToken(forUser)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  };

  const host = await provision("desktop-fixtures-host@example.invalid", "Fixture Host User");
  const created = await asUser(host, "POST", "api/firms", {
    displayName: "Fixture Host Firm",
    handle: "fixture-host-firm",
    operationId: randomUUID().replaceAll("-", ""),
  });
  const hostFirmId = created.json?.firm?.id || created.json?.firm?._id;
  if (!hostFirmId) {
    return { skip: `second firm could not be created for a join code (HTTP ${created.status})` };
  }

  const hostFirm = await Firm.findById(hostFirmId).select("joinCode").lean();
  if (!hostFirm?.joinCode) return { skip: "the second firm carries no join code to join with" };

  const joiner = await provision("desktop-fixtures-joiner@example.invalid", "Fixture Joiner User");
  return asUser(joiner, "POST", "api/firms/join", {
    joinCode: hostFirm.joinCode,
    operationId: randomUUID().replaceAll("-", ""),
  });
});

// The transactional route. updateFirmDigestSettings opens a MongoDB session, which a standalone
// mongod rejects outright -- that was recorded here as a genuine environment limitation and it was
// true at the time. It stopped being true when a replica set appeared on 27118 for L12's erasure
// work, which the connection probe at the top of this file now prefers. Still skips itself with the
// original reason when only the standalone container is up, so this tool keeps working either way
// rather than making the replica set a hard dependency of the drift gate.
define("PATCH", "api/digests/settings", async () => {
  if (!usingReplicaSet) {
    return {
      skip:
        "updateFirmDigestSettings runs inside a MongoDB session/transaction, which requires a " +
        "replica set; this run connected to a standalone mongod, which rejects it with " +
        "'Transaction numbers are only allowed on a replica set member or mongos'",
    };
  }
  return call("PATCH", "api/digests/settings", {
    body: { timezone: "Asia/Kolkata", dailyHour: 7, weeklyDay: 1, weeklyHour: 8 },
  });
});

// ── The ten list/index GETs the discovery regex used to miss ────────────────────────────────
//
// Every one of these is an ordinary authenticated GET against the firm this capture already seeds.
// They were never hard to capture; they were invisible, because the route parser required
// `Authorized(HttpMethod.X` on one line and these are formatted with a newline after the paren.
// The discovered path carries its trailing "?" because that is how the client writes it before
// appending a query string, so the plan key has to match that exactly.
//
// Captured with no query parameters, deliberately: the default view is the one the desktop opens
// with, and adding filters would capture a narrower shape than the client's own first request.
for (const path of [
  "api/cases?",
  "api/engagements?",
  "api/filing-dashboard?",
  "api/gst-reconciliation/runs?",
  "api/review-queue?",
  "api/tasks/board?",
  "api/taxworker/clients?",
  "api/tds-health/runs?",
]) {
  define("GET", path, async () => call("GET", path));
}

// working-papers needs an engagementId: listAuditWorkingPapers calls objectId(query.engagementId)
// and throws without it, so an unparameterised call captures a 400 validation refusal instead of
// the list contract. Chained off the engagement this capture already creates a few routes earlier.
define("GET", "api/engagements/working-papers?", async () => {
  if (!chain.engagementId) {
    return { skip: "api/engagements did not return an engagement id to list working papers for" };
  }
  return call(
    "GET",
    "api/engagements/working-papers?engagementId=" + encodeURIComponent(String(chain.engagementId)),
  );
});

// workspace/search is the one of the ten that needs a parameter: the client always sends
// q=<term> and the route answers 400 without it. Capturing that 400 would record a validation
// refusal as if it were the search contract, so this sends a real term against the seeded firm.
define("GET", "api/workspace/search?", async () =>
  call("GET", "api/workspace/search?q=" + encodeURIComponent("Fixture")),
);

// ── Parameterised routes, batch 1: reads reachable from ids this capture already creates ────
//
// These are the first fixtures for the INTERPOLATED half of the client's surface. Everything here
// is a GET, deliberately: a read cannot disturb the state a later route depends on, and the first
// batch should not risk the 43 fixtures that already work. Writes and destructive routes
// (join-code rotation, leave, DELETE user, run locks) are left for a later pass where ordering has
// to be reasoned about rather than assumed.
//
// Each guards on its chained id and SKIPS with a real reason rather than capturing a 404, because a
// 404 fixture would record "not found" as if it were the route's contract.

/**
 * A client the CURRENTLY active firm can see.
 *
 * `ensureClientId()` memoises a client created before `POST api/firms/switch` moves the active
 * workspace, and every interpolated route runs after the static ones. Handlers that reused it were
 * answered 404 -- "Client not found in your scope" from the tax-work session route, and
 * "Selected client is not available in the active firm" (GST_IMPORT_CLIENT_NOT_FOUND) from the
 * import preview. Both were reproduced, not guessed.
 *
 * This is the single fix for that whole class: any handler needing a client in the firm that is
 * active NOW asks here rather than carrying its own workaround.
 */
let currentFirmClientId = null;
async function ensureClientInCurrentFirm() {
  if (currentFirmClientId) return currentFirmClientId;
  const created = await call("POST", "api/taxworker/clients", {
    body: { name: "Fixture Client (active firm)", entityType: "INDIVIDUAL" },
  });
  currentFirmClientId = created.json?.client?._id ?? null;
  return currentFirmClientId;
}

/**
 * A case that exists in the CURRENTLY active firm.
 *
 * `chain.caseId` is created before `POST api/firms/switch` moves the active workspace, and every
 * interpolated route runs after the static ones, so reading that id back answers 404 -- verified
 * directly, not assumed. Creating one here binds the fixture to the firm actually in scope.
 */
let currentFirmCaseId = null;
async function ensureCaseInCurrentFirm() {
  if (currentFirmCaseId) return currentFirmCaseId;
  const clientId = await ensureClientId();
  if (!clientId) return null;
  const created = await call("POST", "api/cases", {
    body: {
      clientId,
      caseType: "GST_NOTICE_ASSESSMENT",
      title: "Fixture case for detail reads",
      mutationKey: `fixture-capture-case-detail-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    },
  });
  currentFirmCaseId = created.json?.case?._id ?? null;
  return currentFirmCaseId;
}

let currentFirmEngagementId = null;
let currentFirmEngagementRevision = null;
async function ensureEngagementInCurrentFirm() {
  if (currentFirmEngagementId) return currentFirmEngagementId;
  const clientId = await ensureClientId();
  if (!clientId) return null;
  const created = await call("POST", "api/engagements", {
    body: {
      clientId,
      engagementType: "STATUTORY_AUDIT",
      scope: "Fixture scope for detail reads.",
      targetDate: "2026-12-31",
      reviewerUserId: String(user._id),
      mutationKey: `fixture-capture-engagement-detail-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    },
  });
  currentFirmEngagementId = created.json?.engagement?._id ?? null;
  // Carried, not assumed: assertRevision refuses a stale expectedRevision, and a fresh engagement
  // is at revision 1 today but need not stay that way.
  currentFirmEngagementRevision = created.json?.engagement?.revision ?? null;
  return currentFirmEngagementId;
}

define("GET", "api/cases/{caseId}?{query}", async () => {
  const caseId = await ensureCaseInCurrentFirm();
  if (!caseId) return { skip: "could not create a case in the active firm to read back" };
  return call("GET", `api/cases/${encodeURIComponent(String(caseId))}`);
});

define("GET", "api/cases/{caseId}/references", async () => {
  const caseId = await ensureCaseInCurrentFirm();
  if (!caseId) return { skip: "could not create a case in the active firm" };
  return call("GET", `api/cases/${encodeURIComponent(String(caseId))}/references`);
});

define("GET", "api/cases/{caseId}/export", async () => {
  const caseId = await ensureCaseInCurrentFirm();
  if (!caseId) return { skip: "could not create a case in the active firm" };
  return call("GET", `api/cases/${encodeURIComponent(String(caseId))}/export`);
});

define("GET", "api/engagements/{engagementId}", async () => {
  const engagementId = await ensureEngagementInCurrentFirm();
  if (!engagementId) return { skip: "could not create an engagement in the active firm" };
  return call("GET", `api/engagements/${encodeURIComponent(String(engagementId))}`);
});

define("GET", "api/engagements/{engagementId}/export", async () => {
  const engagementId = await ensureEngagementInCurrentFirm();
  if (!engagementId) return { skip: "could not create an engagement in the active firm" };
  return call("GET", `api/engagements/${encodeURIComponent(String(engagementId))}/export`);
});

define("GET", "api/firms/{firmId}", async () => {
  const firmId = chain.sharedFirmId || user.firmId;
  if (!firmId) return { skip: "no firm id available to read back" };
  return call("GET", `api/firms/${encodeURIComponent(String(firmId))}`);
});

define("GET", "api/firms/{firmId}/members", async () => {
  const firmId = chain.sharedFirmId || user.firmId;
  if (!firmId) return { skip: "no firm id available to list members for" };
  return call("GET", `api/firms/${encodeURIComponent(String(firmId))}/members`);
});

// No id at all -- these three were invisible purely because they carry a query string built by
// interpolation, not because they need anything this capture does not have.
define("GET", "api/team-workload?page={page}&limit={limit}", async () =>
  call("GET", "api/team-workload?page=1&limit=25"),
);

define("GET", "api/digests/inbox?page={boundedPage}&limit={boundedLimit}", async () =>
  call("GET", "api/digests/inbox?page=1&limit=25"),
);

// The kind vocabulary is the server's, not a guess: digest.routes.js validates against it and
// answered 400 for "DAILY". The real vocabulary is DAILY_PERSONAL / WEEKLY_FIRM (digest.service.js:18-19).
define("GET", "api/digests/preview?kind={kind}", async () =>
  call("GET", "api/digests/preview?kind=DAILY_PERSONAL"),
);

// ── Parameterised routes, batch 2: the remaining reads that need no imported run ────────────
//
// Same rule as batch 1 -- reads only, each creating what it needs in the firm that is active now.

/** A working paper in the current firm, plus the engagement it hangs off. */
let currentFirmWorkingPaperId = null;
async function ensureWorkingPaperInCurrentFirm() {
  if (currentFirmWorkingPaperId) return currentFirmWorkingPaperId;
  const engagementId = await ensureEngagementInCurrentFirm();
  if (!engagementId) return null;

  // ATTEST FIRST. assertEngagementWritable refuses working-paper work while
  // templateReview.status !== "ATTESTED" (audit-working-paper.service.js:283) -- a real reviewer
  // control, reproduced live as HTTP 409 ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED rather than guessed at.
  const attested = await call("POST", `api/engagements/${encodeURIComponent(String(engagementId))}/review`, {
    body: {
      action: "ATTEST_TEMPLATE",
      confirmed: true,
      expectedRevision: currentFirmEngagementRevision,
      reviewerName: "Fixture Reviewer",
      credentialReference: "FIXTURE-CRED-001",
      mutationKey: `fixture-capture-attest-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    },
  });
  if (!attested.json?.ok) return null;

  // No clientId: PAPER_CREATE_FIELDS is {mutationKey, engagementId, title, purpose, period,
  // priorWorkingPaperId} and the service calls assertAllowedFields, so an extra field refuses the
  // whole request rather than being ignored. The client comes from the engagement.
  const created = await call("POST", "api/engagements/working-papers", {
    body: {
      engagementId,
      title: "Fixture working paper",
      purpose: "Captured so the desktop has a real working-paper shape to parse.",
      mutationKey: `fixture-capture-wp-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    },
  });
  // The route answers { ok, paper }, not { workingPaper } - read off a real 201 rather than guessed.
  currentFirmWorkingPaperId = created.json?.paper?._id ?? null;
  return currentFirmWorkingPaperId;
}

define("GET", "api/engagements/working-papers/{workingPaperId}", async () => {
  const id = await ensureWorkingPaperInCurrentFirm();
  if (!id) return { skip: "could not create a working paper in the active firm" };
  return call("GET", `api/engagements/working-papers/${encodeURIComponent(String(id))}`);
});

define("GET", "api/engagements/working-papers/{workingPaperId}/export", async () => {
  const id = await ensureWorkingPaperInCurrentFirm();
  if (!id) return { skip: "could not create a working paper in the active firm" };
  return call("GET", `api/engagements/working-papers/${encodeURIComponent(String(id))}/export`);
});

/** A task in the current firm. chain.taskId predates the workspace switch, so make a fresh one. */
let currentFirmTaskId = null;
async function ensureTaskInCurrentFirm() {
  if (currentFirmTaskId) return currentFirmTaskId;
  // Same body shape as the POST api/tasks capture above, which is known to work. "service" is not
  // a field this route accepts.
  const created = await call("POST", "api/tasks", {
    body: {
      clientName: "Fixture Client",
      title: "Fixture task for detail read",
      dueDateISO: "2026-12-31",
    },
  });
  currentFirmTaskId = created.json?.task?._id ?? null;
  return currentFirmTaskId;
}

define("GET", "api/tasks/{taskId}", async () => {
  const id = await ensureTaskInCurrentFirm();
  if (!id) return { skip: "could not create a task in the active firm" };
  return call("GET", `api/tasks/${encodeURIComponent(String(id))}`);
});

/**
 * A workspace-operation receipt, read back by its id.
 *
 * Every workspace write (firm create, switch, join) carries an operationId and the server records
 * a receipt against it, which is how the desktop recovers from a write whose response it never
 * saw. Rather than reuse an id from an earlier route -- whose firm may since have changed -- this
 * performs its own switch to the firm already active, which is a no-op the server still records.
 */
define("GET", "api/firms/workspace-operations/{operationId}", async () => {
  const firmId = user.firmId;
  if (!firmId) return { skip: "no active firm to record a workspace operation against" };
  const operationId = randomUUID().replaceAll("-", "");
  const switched = await call("POST", "api/firms/switch", {
    body: { firmId: String(firmId), operationId },
  });
  if (!switched.json?.ok) {
    return { skip: `could not record a workspace operation to read back (HTTP ${switched.status})` };
  }
  return call("GET", `api/firms/workspace-operations/${encodeURIComponent(operationId)}`);
});

/** A bulk task operation, read back by its operation id. */
define("GET", "api/tasks/bulk/{operationId}", async () => {
  const id = await ensureTaskInCurrentFirm();
  if (!id) return { skip: "could not create a task to build a bulk operation from" };
  const operationId = randomUUID().replaceAll("-", "");
  const preview = await call("POST", "api/tasks/bulk/preview", {
    body: {
      operationId,
      items: [{ taskId: String(id), patch: { status: "IN_PROGRESS" } }],
    },
  });
  if (!preview.json?.ok) {
    return { skip: `bulk preview did not produce an operation to read back (HTTP ${preview.status})` };
  }
  // The GET keys on the operation's ObjectId, NOT on the caller-supplied operationId: getTaskBulk
  // Operation rejects anything that is not a valid ObjectId (task-bulk.service.js:620). The preview
  // returns it as operation.id.
  const bulkId = preview.json?.operation?.id ?? null;
  if (!bulkId) return { skip: "bulk preview returned no operation id to read back" };
  return call("GET", `api/tasks/bulk/${encodeURIComponent(String(bulkId))}`);
});

/** A tax-work session in the current firm. */
define("GET", "api/taxworker/sessions/{sessionId}", async () => {
  const clientId = await ensureClientInCurrentFirm();
  if (!clientId) return { skip: "could not create a client in the active firm" };
  const created = await call("POST", "api/taxworker/sessions", {
    body: { clientId, taxType: "GST_MONTHLY" },
  });
  const sessionId = created.json?.session?._id ?? null;
  if (!sessionId) return { skip: `tax-work session was not created (HTTP ${created.status})` };
  return call("GET", `api/taxworker/sessions/${encodeURIComponent(String(sessionId))}`);
});

// ── A real GST reconciliation run, built through the real import pipeline ────────────────────
//
// The nine gst-reconciliation detail routes all key on a run id, and a run cannot be faked: it
// requires two committed ImportBatch documents (GST_PURCHASE and GSTR2B) that agree with each other
// and with the run on firmId, clientId, gstin and period (gst-reconciliation.service.js:470-482).
//
// Seeding a run straight into Mongo would produce a document the product never actually creates,
// and the fixtures taken from it would describe a shape no user can reach. So this drives the real
// chain: preview -> commit -> preview -> commit -> create run.
//
// The CSV shape is the one self-test.service.js already uses for GST_PURCHASE, which is also
// exactly what api/imports/gstr2b/convert emits -- the converter and the importer share a contract,
// so one table serves both kinds.

const GST_FIXTURE_GSTIN = "27AAQCV9182K1ZQ";
const GST_FIXTURE_PERIOD = "2026-07";
const GST_MAPPING = {
  supplierGstin: "Supplier GSTIN",
  recipientGstin: "Recipient GSTIN",
  invoiceNumber: "Invoice Number",
  documentDate: "Document Date",
  documentType: "Document Type",
  taxableValue: "Taxable Value",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};
const GST_CSV = [
  "Supplier GSTIN,Recipient GSTIN,Invoice Number,Document Date,Document Type,Taxable Value,IGST,CGST,SGST,Cess",
  `29AAQCV1234K1ZP,${GST_FIXTURE_GSTIN},INV-0001,2026-07-05,INVOICE,100000.00,18000.00,0.00,0.00,0.00`,
  `29AAQCV1234K1ZP,${GST_FIXTURE_GSTIN},INV-0002,2026-07-18,INVOICE,50000.00,0.00,4500.00,4500.00,0.00`,
  "",
].join("\n");

/** Preview then commit one import batch, returning its id. */
async function commitGstBatch(kind, clientId) {
  // The commit URL keys on sourceHash, which is a hash of the TEXT. Two kinds sharing one CSV
  // therefore share a sourceHash, and the second commit resolves the first kind's preview. Vary
  // the invoice numbers per kind so each import has its own identity, which is also what a real
  // books-versus-portal pair looks like.
  const text = GST_CSV.replaceAll("INV-", kind === "GSTR2B" ? "PINV-" : "BINV-");
  const body = {
    kind,
    text,
    mapping: GST_MAPPING,
    delimiter: ",",
    clientId: String(clientId),
    gstin: GST_FIXTURE_GSTIN,
    period: GST_FIXTURE_PERIOD,
  };

  const preview = await call("POST", "api/imports/preview", { body });
  const sourceHash = preview.json?.preview?.sourceHash ?? null;
  const previewToken =
    preview.json?.preview?.commitToken
    ?? preview.json?.preview?.previewToken
    ?? preview.json?.previewToken
    ?? null;
  if (!sourceHash) return null;

  const commit = await call("POST", `api/imports/${encodeURIComponent(sourceHash)}/commit`, {
    body: { ...body, ...(previewToken ? { previewToken } : {}) },
  });
  return commit.json?.batch?._id ?? commit.json?.batch?.id ?? commit.json?.batchId ?? null;
}

let gstRunId = null;
let gstRunResolved = false;
async function ensureGstRun() {
  if (gstRunResolved) return gstRunId;
  gstRunResolved = true;

  const clientId = await ensureClientInCurrentFirm();
  if (!clientId) return null;

  const booksBatchId = await commitGstBatch("GST_PURCHASE", clientId);
  const portalBatchId = await commitGstBatch("GSTR2B", clientId);
  if (!booksBatchId || !portalBatchId) return null;

  const created = await call("POST", "api/gst-reconciliation/runs", {
    body: {
      clientId: String(clientId),
      gstin: GST_FIXTURE_GSTIN,
      period: GST_FIXTURE_PERIOD,
      booksBatchId: String(booksBatchId),
      portalBatchId: String(portalBatchId),
    },
  });
  gstRunId = created.json?.run?._id ?? created.json?.run?.id ?? null;
  return gstRunId;
}

for (const [template, build] of [
  ["GET api/gst-reconciliation/runs/{runId}", (id) => `api/gst-reconciliation/runs/${id}`],
  ["GET api/gst-reconciliation/runs/{runId}/3b-control", (id) => `api/gst-reconciliation/runs/${id}/3b-control`],
  ["GET api/gst-reconciliation/runs/{runId}/export", (id) => `api/gst-reconciliation/runs/${id}/export`],
  ["GET api/gst-reconciliation/runs/{runId}/items?", (id) => `api/gst-reconciliation/runs/${id}/items`],
  ["GET api/gst-reconciliation/runs/{runId}/supplier-chase", (id) => `api/gst-reconciliation/runs/${id}/supplier-chase`],
]) {
  const [method, path] = [template.slice(0, template.indexOf(" ")), template.slice(template.indexOf(" ") + 1)];
  define(method, path, async () => {
    const runId = await ensureGstRun();
    if (!runId) {
      return {
        skip:
          "the second GST import commit is refused by assertGstStorageIndexes with 'completed GST "
          + "imports without generation-safe identity require approved migration'. The FIRST commit "
          + "(GST_PURCHASE) succeeds and its batch and rows were checked field by field against "
          + "every condition in findUnsafeLegacyDocuments -- importFingerprint, sourceHash, "
          + "activeImportGeneration, normalizationVersion, gstin, period, importGeneration, "
          + "sourceRow -- and all pass, so the refusal is not those. Ruled out: missing indexes "
          + "(now provisioned at boot, which fixed the FIRST commit's earlier 503) and a shared "
          + "sourceHash between the two kinds (the texts now differ per kind). What remains is a "
          + "domain gate in the GST rollout path that needs someone who knows that migration story",
      };
    }
    return call("GET", build(encodeURIComponent(String(runId))));
  });
}

// ── Parameterised routes, batch 3: writes that create their own subject ─────────────────────
//
// The first writes among the interpolated routes. Each acts on an entity this handler created, so
// it cannot disturb the state another fixture depends on -- which is why these are safe to add
// while the destructive ones (lock, leave, rotate join-code, DELETE user) are still left alone.
//
// Bodies are taken from what CaProApiClient actually sends for each route, not from the server's
// field allow-list: the allow-list says what is permitted, the client says what is real.

define("POST", "api/cases/{caseId}/timeline", async () => {
  const caseId = await ensureCaseInCurrentFirm();
  if (!caseId) return { skip: "could not create a case in the active firm" };
  return call("POST", `api/cases/${encodeURIComponent(String(caseId))}/timeline`, {
    body: {
      mutationKey: `fixture-capture-timeline-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      // From CASE_EVENT_TYPES (CaseTimelineEvent.js:3); a free-text type is refused by the enum.
      type: "NOTE_ADDED",
      title: "Fixture timeline note",
      detail: "Recorded so the desktop has a real timeline-event shape to parse.",
    },
  });
});

define("POST", "api/engagements/{engagementId}/findings", async () => {
  const engagementId = await ensureEngagementInCurrentFirm();
  if (!engagementId) return { skip: "could not create an engagement in the active firm" };
  return call("POST", `api/engagements/${encodeURIComponent(String(engagementId))}/findings`, {
    body: {
      mutationKey: `fixture-capture-finding-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      title: "Fixture finding",
      description: "Recorded so the desktop has a real finding shape to parse.",
      // NOT free text, despite the schema allowing any 120-char string. The service accepts only
      // `templateSnapshot.findingCategories` plus the literal "OTHER" (engagement.service.js:1592),
      // and the statutory-audit template this capture creates ships WITHOUT findingCategories -- so
      // "OTHER" is the only value it will take. Stage keys like FIELDWORK are a different
      // vocabulary and are refused here; that was tried first and rejected.
      category: "OTHER",
      evidenceReferences: ["WP-1"],
    },
  });
});

define("POST", "api/engagements/working-papers/{workingPaperId}/rows", async () => {
  const workingPaperId = await ensureWorkingPaperInCurrentFirm();
  if (!workingPaperId) return { skip: "could not create a working paper in the active firm" };
  return call(
    "POST",
    `api/engagements/working-papers/${encodeURIComponent(String(workingPaperId))}/rows`,
    {
      body: {
        mutationKey: `fixture-capture-wp-row-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        // A freshly created working paper is at revision 1; the row write is revision-guarded.
        expectedRevision: 1,
        rowKey: "TR-001",
        description: "Fixture working-paper row",
        observedValue: "1,20,000",
        // Required. A working-paper row without a source reference is an assertion with no evidence
        // behind it, which is exactly what the service refuses.
        sourceReference: "Bank confirmation letter, 2026-07-31",
      },
    },
  );
});

// Explicitly out of reach for this pass, with the real reason recorded rather than left silent.
// Tracked in preSkippedKeys (not just the skipped[] report list) so the "uncovered by plan"
// check below -- which exists to catch a route the parser found that this file forgot about
// entirely -- does not also, wrongly, flag every route named here as forgotten.
const preSkippedKeys = new Set();
for (const [key, reason] of [
]) {
  skipped.push({ route: key, reason });
  preSkippedKeys.add(key);
}

// ─── Step 5: run the plan ────────────────────────────────────────────────────────────────────

// Always start from an empty directory. A route captured on an earlier run and later moved to
// `skipped` (a body-shape fix that turned out to need a replica set, a multipart body, etc.)
// would otherwise leave its stale fixture file behind forever -- reproduced directly: this
// tool's own development left post-api-cases-ocr.json and patch-api-digests-settings.json on
// disk after both routes were moved to the skip list, and the C# Theory below correctly failed
// on both, refusing to run an assertion for a route with none registered.
if (existsSync(fixturesDir)) {
  rmSync(fixturesDir, { recursive: true, force: true });
}
mkdirSync(fixturesDir, { recursive: true });

// Static routes always; interpolated routes only where a handler exists. An interpolated route
// with no handler is not a failure -- it is the remaining coverage gap, counted in the manifest
// under parameterisedRoutesNotCaptured rather than turning the gate red for a gap that predates
// this tool.
const interpolatedWithHandler = interpolatedRoutes.filter((route) =>
  plan.has(`${route.method} ${route.path}`),
);

for (const route of [...staticRoutes, ...interpolatedWithHandler]) {
  const key = `${route.method} ${route.path}`;
  if (preSkippedKeys.has(key)) continue; // already recorded once, with its real reason, above.

  const handler = plan.get(key);
  if (!handler) {
    skipped.push({ route: key, reason: "no capture handler defined yet for this route" });
    continue;
  }

  const result = await handler();
  if (result?.skip) {
    skipped.push({ route: key, reason: result.skip });
    continue;
  }

  const slug = key.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "");
  const fixturePath = join(fixturesDir, `${slug}.json`);
  writeFileSync(
    fixturePath,
    JSON.stringify({ method: route.method, path: route.path, status: result.status, body: result.json }, null, 2) + "\n",
  );
  captured.push({ route: key, file: `${slug}.json`, status: result.status });
}

// Routes the parser found that this plan never even considered (a real gap, not a skip) --
// should be empty; if not, the plan above has drifted from the real route list.
const planless = staticRoutes.filter((route) => {
  const key = `${route.method} ${route.path}`;
  return !plan.has(key) && !preSkippedKeys.has(key);
});

const commitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

const manifest = {
  capturedAtUtc: new Date().toISOString(),
  backendCommitSha: commitSha,
  totalRoutesDiscovered: staticRoutes.length,
  captured,
  skipped,
  // Which database class produced these fixtures. Two routes (PATCH api/digests/settings and
  // POST api/firms/join) open MongoDB transactions, so a capture taken without a replica set is
  // NOT comparable to one taken with it. Recording it lets the drift gate say "captured against a
  // different database class" instead of reporting the difference as a field-shape change.
  transactionsAvailable: usingReplicaSet,
  uncoveredByPlan: planless.map((route) => `${route.method} ${route.path}`),
  // The parameterised surface. Discovered and counted, not captured -- see parseInterpolatedRoutes
  // for why these are reported rather than failed. Shrinking this list is real coverage work; a
  // fixture for one of these is worth more than a fixture for another list endpoint, because every
  // TDS-health and GST-reconciliation contract claim in the desktop suite sits behind one.
  parameterisedRoutesTotal: interpolatedRoutes.length,
  parameterisedRoutesNotCaptured: interpolatedRoutes
    .filter((r) => !plan.has(`${r.method} ${r.path}`))
    .map((r) => `${r.method} ${r.path}`),
  // The THIRD construction form: a literal built into a local and passed to the call by name, e.g.
  // `var path = string.Create(culture, $"api/tasks/my-open?...")`. Neither precise parser above can
  // see those, so until this line they were not merely uncaptured, they were UNCOUNTED -- and
  // `api/tasks/my-open` is the Overview page's own endpoint, whose absence from the fixture set is
  // why D13 survived a drift gate built to catch exactly that class of defect. Their verb is
  // INFERRED from the nearest following HttpMethod, so it is reported separately from the two
  // parsed sets rather than blended into them.
  indirectlyConstructedRoutes: indirectRoutes.map(
    (r) => `${r.method} ${r.path}${r.methodSource === "inferred" ? " (verb inferred)" : ""}`,
  ),
  // The honest denominator: every `api/...` literal in the client, whichever way it is built. The
  // three parsers must account for all of it; tests/desktop-route-discovery-contract.mjs fails when
  // they do not, so a fourth construction form cannot go uncounted the way the third did.
  routeLiteralsInClient: allRouteLiterals.length,
};
writeFileSync(join(fixturesDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`routes discovered : ${staticRoutes.length}`);
console.log(`captured          : ${captured.length}`);
console.log(`skipped           : ${skipped.length}`);
console.log(`uncovered by plan : ${planless.length}`);
console.log(
  `parameterised     : ${interpolatedRoutes.length} discovered, ${interpolatedWithHandler.length} captured, ` +
    `${interpolatedRoutes.length - interpolatedWithHandler.length} outstanding (see manifest)`,
);
console.log(
  `indirect          : ${indirectRoutes.length} discovered (verb inferred), of ${allRouteLiterals.length} route literals in the client`,
);
for (const item of planless) console.log(`  UNCOVERED: ${item.method} ${item.path}`);
for (const item of indirectRoutes) console.log(`  INDIRECT : ${item.method} ${item.path}`);

await mongoose.connection.close();
await new Promise((resolve) => server.close(resolve));

process.exit(planless.length > 0 ? 1 : 0);
