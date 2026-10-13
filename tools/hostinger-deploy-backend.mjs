// Trigger a Hostinger Node.js build for capro-backend from an archive ALREADY uploaded to the
// account's filespace, then wait for it to finish and report the outcome honestly.
//
//   HOSTINGER_API_TOKEN=<token> node tools/hostinger-deploy-backend.mjs \
//     --domain api.caprotoolkit.in \
//     --archive capro-backend.zip \
//     --expect-commit 0ea0bcb54a24ccebb85612b757e8ad7629374804
//
//   --dry-run     resolve the account and print the build settings the deploy WOULD use, then cover
//                 the archive like every other exit does - upload it again before the real deploy.
//   --cover-only  overwrite the archive path with the placeholder and prove it, nothing else: for an
//                 archive left in place by a build that timed out, or uploaded and never deployed.
//
// WHY THIS EXISTS
// ---------------
// A push changes nothing: Hostinger builds this API from an uploaded archive, not from git. Until
// now the trigger was a manual hPanel click, which meant every corrected string sat in the repo
// looking deployed while production served the old one. That is exactly how L10 came to be "written,
// gated, pushed, and still false in production".
//
// The MCP server's hosting_deployJsApplication cannot be used from here. It uploads the archive
// itself from a LOCAL path, and the MCP gateway runs in an ephemeral container with no mounts, so
// it cannot see this machine's disk. The upload half is already solved by hostinger-upload-file.mjs
// (TUS, exact relative path, no site-root deploy). This tool is the other half: it calls the same
// two REST endpoints the MCP server calls after its own upload, which is why the request shape
// below mirrors that server rather than being invented.
//
//   GET  api/hosting/v1/accounts/{user}/websites/{domain}/nodejs/builds/settings/from-archive
//   POST api/hosting/v1/accounts/{user}/websites/{domain}/nodejs/builds
//   POST api/hosting/v1/accounts/{user}/websites/{domain}/nodejs/server/restart   (only when the
//        API's own domain stays silent after the build, and at most once - lib/deploy-serving-check.mjs)
//
// SAFETY
// ------
// Build settings are FETCHED from the archive on the server, never hand-written here. Inventing an
// entry file or a node version would be a silent way to deploy a differently-configured app; taking
// the server's own answer means this tool cannot reconfigure the service, only rebuild it - and, at
// most once, restart the process it built.
//
// The token is read from the environment and never printed, logged, or written anywhere.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { uploadFileToHostinger } from "./lib/hostinger-files.mjs";
import {
  PLACEHOLDER_BODY,
  assertArchivePathNotExposed,
} from "./lib/deploy-archive-exposure.mjs";
import { confirmServing } from "./lib/deploy-serving-check.mjs";
import { publicOrigin } from "./lib/public-origin.mjs";

const BASE = process.env.HOSTINGER_API_BASE || "https://developers.hostinger.com";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const domain = arg("domain", "api.caprotoolkit.in");
const archive = arg("archive", "capro-backend.zip");
const expectCommit = arg("expect-commit");
const dryRun = has("dry-run");
const timeoutMs = Number(arg("timeout-ms", "300000"));
// The settings endpoint infers a node version from the archive, and its inference is NOT
// necessarily what production is already running -- it suggested 20 while the live service runs 22.
// Deploying new code and a new runtime major in one step would confuse a failure between the two,
// so the caller pins the version that is already serving and changes one thing at a time.
const nodeVersion = arg("node-version");
// Optional. When the caller passes the local archive it deployed, the exposure check can
// compare the served bytes against that exact file rather than only looking for a zip
// signature - so a renamed or recompressed copy is caught too.
const archiveFile = arg("archive-file");

const token = process.env.HOSTINGER_API_TOKEN;

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Reported like any other failed call - status 0 - so it takes the same covered way out instead
    // of crashing past it with the archive still public.
    return { status: 0, json: null, text: String(err) };
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const line = (label, value) => console.log(`  ${label.padEnd(16)}: ${value}`);

// The archive has been public since hostinger-upload-file.mjs put it in the served root, so every way
// out of this tool covers it - not only the deploy that reaches step 5. Until 2026-10-04 a failed
// lookup, a failed settings read, --dry-run, a refused trigger and a failed build all left the whole
// backend source downloadable. The one exception is a build that timed out: it may still be reading
// the archive, so it is left, and the command that covers it is printed instead.
//
// Overwrite rather than delete, because there is nothing to delete with: the file service answers
// 404 to DELETE in every shape TUS defines, and the build cannot read an archive kept outside the
// served root. Both were probed against this account. See lib/deploy-archive-exposure.mjs.
let archiveSha256 = null;
if (archiveFile) {
  try {
    archiveSha256 = createHash("sha256").update(readFileSync(archiveFile)).digest("hex");
    line("archive sha", `${archiveSha256.slice(0, 16)}...`);
  } catch (err) {
    // Not fatal to the cover: the proof still refuses anything zip-shaped or large without the hash.
    console.error(`  could not hash ${archiveFile}: ${String(err)} - the proof will run without it`);
  }
}

const coverCommand = `node tools/hostinger-deploy-backend.mjs --domain ${domain} --archive ${archive} --cover-only`;

async function coverArchive() {
  try {
    await uploadFileToHostinger({
      domain,
      token,
      remotePath: archive,
      content: PLACEHOLDER_BODY,
      log: (message) => console.log(message),
    });
    return true;
  } catch (err) {
    console.error("");
    console.error("=== NEUTRALISATION FAILED ===");
    console.error(`  ${String(err)}`);
    console.error(`  The backend source may still be downloadable at ${publicOrigin(domain)}/${archive}.`);
    console.error(`  Cover it before anything else: ${coverCommand}`);
    return false;
  }
}

async function proveCovered() {
  try {
    await assertArchivePathNotExposed({
      domain,
      remotePath: archive,
      archiveSha256,
      createHash,
      log: (message) => console.log(message),
    });
    return true;
  } catch (err) {
    console.error("");
    console.error("=== ARCHIVE STILL EXPOSED ===");
    console.error(`  ${String(err)}`);
    return false;
  }
}

// A way out before step 5: cover, prove, then leave with the code the stop already had - or 1 when
// the archive cannot be shown covered, because that is then the larger problem. It returns the code
// rather than exiting: the comment above deploy() says why nothing here calls process.exit().
async function exitCovered(code) {
  console.log("");
  console.log("=== closing the archive exposure before stopping ===");
  const covered = (await coverArchive()) && (await proveCovered());
  return covered ? code : 1;
}

// Every step runs inside deploy(), which RETURNS the exit code, and the module sets process.exitCode
// and lets Node finish on its own. Calling process.exit() after a fetch aborts Node 24 on Windows
// with 0xC0000409 (libuv's "!(handle->flags & UV_HANDLE_CLOSING)" assertion) - every time, measured
// 8 of 8 on 2026-10-04 - which turned a clean --dry-run into a crash code and hid a failure's real
// code behind it. Not even the token check calls it: tests/no-exit-after-network-contract.mjs
// fails the gates for any process.exit() in a file that makes requests (V32).
async function deploy() {
  if (!token) {
    console.error("HOSTINGER_API_TOKEN is not set in the environment.");
    console.error("Load it from capro-backend/.env into the process environment; do not pass it on the command line.");
    console.error("An archive already uploaded stays public until covered: set the token, then run with --cover-only.");
    return 2;
  }
  if (has("cover-only")) {
    console.log("=== cover only: nothing is built ===");
    return exitCovered(0);
  }

  console.log("=== 1. resolve the hosting account ===");
  const site = await api(`api/hosting/v1/websites?domain=${encodeURIComponent(domain)}`);
  if (site.status !== 200) {
    console.error(`  FAILED: websites lookup returned ${site.status}`);
    console.error(`  ${site.text.slice(0, 400)}`);
    return exitCovered(1);
  }
  const record = Array.isArray(site.json) ? site.json[0] : site.json?.data?.[0] ?? site.json?.[0];
  const username = record?.username;
  if (!username) {
    console.error("  FAILED: could not resolve a username for that domain.");
    return exitCovered(1);
  }
  line("domain", domain);
  line("account", username);

  console.log("");
  console.log("=== 2. read the build settings off the uploaded archive ===");
  const settingsPath =
    `api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}` +
    `/nodejs/builds/settings/from-archive?archive_path=${encodeURIComponent(archive)}`;
  const settings = await api(settingsPath);
  if (settings.status !== 200 || !settings.json) {
    console.error(`  FAILED: settings returned ${settings.status}`);
    console.error(`  ${settings.text.slice(0, 400)}`);
    if (settings.status === 404) {
      console.error("  A 404 here means the archive is not where this tool was told to look.");
    } else if (settings.status === 500) {
      // The expected state BETWEEN deploys. Step 6 overwrites the archive with a placeholder once the
      // build has read it, so the path holds a short text file rather than a zip and the settings
       // endpoint cannot read build settings out of it. That is the exposure fix working, not a fault -
      // and it means a stale archive can never be rebuilt from by accident. Upload a fresh archive
      // first.
      console.error("  A 500 here usually means the path holds the post-deploy placeholder rather than");
      console.error("  an archive, which is the expected state between deploys. Upload the archive first.");
    } else {
      console.error("  Check that the archive is where this tool was told to look.");
    }
    return exitCovered(1);
  }
  const built = settings.json?.data ?? settings.json;
  line("archive", archive);
  line("app type", built?.app_type ?? "(server did not say)");
  line("node", built?.node_version ?? "(server did not say)");
  line("root dir", built?.root_directory ?? "(none)");
  line("entry file", built?.entry_file ?? "(none)");
  line("build script", built?.build_script ?? "(none)");
  if (nodeVersion && String(built?.node_version) !== String(nodeVersion)) {
    line(
      "node (pinned)",
      `${nodeVersion} - overriding the inferred ${built?.node_version} to match what is already running`,
    );
  }

  if (dryRun) {
    console.log("");
    console.log("=== dry run: nothing was deployed ===");
    console.log("  The archive is covered below, like on every other exit; upload it again before the real deploy.");
    return exitCovered(0);
  }

  console.log("");
  console.log("=== 3. trigger the build ===");
  const payload = {
    ...built,
    node_version: nodeVersion ? Number(nodeVersion) : built?.node_version || 20,
    source_type: "archive",
    source_options: { archive_path: archive },
  };
  const triggered = await api(
    `api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/nodejs/builds`,
    { method: "POST", body: payload },
  );
  if (triggered.status !== 200 && triggered.status !== 201 && triggered.status !== 202) {
    console.error(`  FAILED: build trigger returned ${triggered.status}`);
    console.error(`  ${triggered.text.slice(0, 600)}`);
    return exitCovered(1);
  }
  const build = triggered.json?.data ?? triggered.json;
  const uuid = build?.uuid ?? build?.id ?? null;
  line("accepted", `HTTP ${triggered.status}`);
  line("build", uuid ?? "(no uuid returned)");

  console.log("");
  console.log("=== 4. wait for it to finish ===");
  // Poll the same list endpoint the MCP's status tool reads. A deploy that is reported as started but
  // never confirmed finished is the state this whole tool exists to stop happening silently.
  const deadline = Date.now() + timeoutMs;
  let final = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const list = await api(
      `api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/nodejs/builds?perPage=5`,
    );
    const rows = list.json?.data ?? [];
    const row = uuid ? rows.find((r) => r.uuid === uuid) : rows[0];
    if (!row) continue;
    if (row.state === "completed" || row.state === "failed") {
      final = row;
      break;
    }
    process.stdout.write(`  state: ${row.state}\n`);
  }

  if (!final) {
    console.error(`  TIMED OUT after ${Math.round(timeoutMs / 1000)}s without a terminal state.`);
    console.error("  The build may still be running; re-check with hosting_listJsDeployments.");
    console.error("  The archive was LEFT in the served root, because the build may still be reading it.");
    console.error(`  Once the build has ended, cover it: ${coverCommand}`);
    return 1;
  }

  line("state", final.state);
  line("created", final.created_at);
  line("updated", final.updated_at);

  if (final.state !== "completed") {
    console.error("");
    console.error("=== DEPLOY FAILED ===");
    console.error(`  Fetch the logs for build ${final.uuid} before retrying.`);
    return exitCovered(1);
  }

  console.log("");
  console.log("=== 5. close the archive exposure ===");
  // The archive had to be in the domain's document root for the build to read it. The build has now
  // read it, so nothing needs it any more. It is covered BEFORE the health check, not after: on
  // 2026-10-04 the source stayed downloadable for the whole 37 minutes the API was down, and the check
  // can now take longer still (a silent domain is restarted once and probed again), none of which
  // needs the archive.
  if (!(await coverArchive())) return 1;

  console.log("");
  console.log("=== 6. confirm the live API is actually serving again ===");
  // A completed build is not the same as a healthy service, so this asks the running app - on the
  // API's own domain, the only one clients use. Each probe is bounded: with the origin silent the CDN
  // holds a request for minutes, and twelve unbounded attempts kept a dead API looking like a slow one
  // for half an hour on 2026-10-04. A domain still silent after twelve is restarted once through
  // Hostinger's documented endpoint and probed again; lib/deploy-serving-check.mjs says why, and why
  // only once.
  let health = null;
  const serving = await confirmServing({
    probe: async () => {
      const response = await fetch(`${publicOrigin(domain)}/api/app-config`, { redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!response.ok) return false;
      health = await response.json();
      return true;
    },
    // The request that recovered the API on 2026-10-04, unchanged: no body, so no Content-Type.
    restart: async () => {
      const response = await fetch(
        `${BASE}/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/nodejs/server/restart`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(60000),
        },
      );
      return { status: response.status };
    },
    log: (message) => console.log(`  ${message}`),
  });

  const serviceAnswered = serving.answered && Boolean(health);
  if (serviceAnswered) {
    line("app-config", serving.restarted ? "200 OK, after one restart" : "200 OK");
  } else {
    console.error("  The build completed but /api/app-config did not answer on the API's own domain.");
    console.error("  Investigate before assuming success, then roll back (docs/operations-runbook.md, Rollback).");
  }

  if (serviceAnswered && expectCommit) {
    // Optional, and only asserted when the caller supplies it: the deployed build id is not exposed
    // by the public API, so this is a courtesy echo rather than proof of the running commit.
    line("expected", expectCommit.slice(0, 12));
  }

  console.log("");
  console.log("=== 7. prove the archive is no longer public ===");
  // A deploy that cannot prove this fails. Reporting a deploy as complete while the source is still
  // downloadable is the exact outcome step 5 exists to prevent, so it is asserted rather than
  // assumed - and the request is cache-busted, because a stale 404 is how this was missed the first
  // time it happened. A silent API is reported as well, not instead: both are a failed deploy.
  const exposureDisproved = await proveCovered();

  if (!serviceAnswered) {
    console.error("");
    console.error("=== DEPLOY FAILED: the API is not answering ===");
    console.error(
      exposureDisproved
        ? "  The archive exposure is closed. Roll back to the last-known-good archive now."
        : "  The archive exposure is NOT proved closed (above). Overwrite that path, then roll back.",
    );
    return 1;
  }
  if (!exposureDisproved) return 1;

  console.log("");
  console.log("=== DEPLOY COMPLETE ===");
  return 0;
}

process.exitCode = await deploy();
