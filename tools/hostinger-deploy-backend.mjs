// Trigger a Hostinger Node.js build for capro-backend from an archive ALREADY uploaded to the
// account's filespace, then wait for it to finish and report the outcome honestly.
//
//   HOSTINGER_API_TOKEN=<token> node tools/hostinger-deploy-backend.mjs \
//     --domain api.caprotoolkit.in \
//     --archive capro-backend.zip \
//     --expect-commit 0ea0bcb54a24ccebb85612b757e8ad7629374804
//
//   --dry-run   resolve the account and print the build settings the deploy WOULD use, and stop.
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
//
// SAFETY
// ------
// Build settings are FETCHED from the archive on the server, never hand-written here. Inventing an
// entry file or a node version would be a silent way to deploy a differently-configured app; taking
// the server's own answer means this tool cannot reconfigure the service, only rebuild it.
//
// The token is read from the environment and never printed, logged, or written anywhere.

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

const token = process.env.HOSTINGER_API_TOKEN;
if (!token) {
  console.error("HOSTINGER_API_TOKEN is not set in the environment.");
  console.error("Load it from capro-backend/.env into the process environment; do not pass it on the command line.");
  process.exit(2);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
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
}

const line = (label, value) => console.log(`  ${label.padEnd(16)}: ${value}`);

console.log("=== 1. resolve the hosting account ===");
const site = await api(`api/hosting/v1/websites?domain=${encodeURIComponent(domain)}`);
if (site.status !== 200) {
  console.error(`  FAILED: websites lookup returned ${site.status}`);
  console.error(`  ${site.text.slice(0, 400)}`);
  process.exit(1);
}
const record = Array.isArray(site.json) ? site.json[0] : site.json?.data?.[0] ?? site.json?.[0];
const username = record?.username;
if (!username) {
  console.error("  FAILED: could not resolve a username for that domain.");
  process.exit(1);
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
  console.error("  A 404 here usually means the archive is not where this tool was told to look.");
  process.exit(1);
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
  process.exit(0);
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
  process.exit(1);
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
  process.exit(1);
}

line("state", final.state);
line("created", final.created_at);
line("updated", final.updated_at);

if (final.state !== "completed") {
  console.error("");
  console.error("=== DEPLOY FAILED ===");
  console.error(`  Fetch the logs for build ${final.uuid} before retrying.`);
  process.exit(1);
}

console.log("");
console.log("=== 5. confirm the live API is actually serving again ===");
// A completed build is not the same as a healthy service, so this asks the running app.
let health = null;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(`https://${domain}/api/app-config`, { redirect: "follow" });
    if (response.ok) {
      health = await response.json();
      break;
    }
  } catch {
    // still restarting
  }
  await new Promise((r) => setTimeout(r, 5000));
}

if (!health) {
  console.error("  The build completed but /api/app-config did not answer. Investigate before assuming success.");
  process.exit(1);
}
line("app-config", "200 OK");

if (expectCommit) {
  // Optional, and only asserted when the caller supplies it: the deployed build id is not exposed
  // by the public API, so this is a courtesy echo rather than proof of the running commit.
  line("expected", expectCommit.slice(0, 12));
}

console.log("");
console.log("=== DEPLOY COMPLETE ===");
