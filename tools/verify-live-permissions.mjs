// Checks, against the DEPLOYED backend, that the permission answers both clients draw their buttons
// from (R23-R27) are live and agree with the caller's firm role.
//
//   CAPRO_TOKEN=<jwt> node tools/verify-live-permissions.mjs
//   CAPRO_TOKEN=<jwt> CAPRO_EXPECT_TRANSFER=1 node tools/verify-live-permissions.mjs   # after R27 is live
//
// WHAT IT TOUCHES: nothing. Every request is a GET, except two POSTs to the ownership-transfer route
// that the route must refuse before its first write - one for a firm id that does not exist, and
// one with no toUserId for a workspace the caller owns. It never switches workspace (that writes
// User.firmId), never leaves, never rotates a join code. It prints roles, counts and booleans; it
// never prints the token, an email, a name or a join code.
//
// WHAT IT CAN AND CANNOT PROVE. The server decides canComplete and canWrite for the caller's ACTIVE
// workspace only, from that caller's membership. So one token proves the verdict for that one
// caller's rung. A SUPER_ADMIN is the global bypass (firm-authority.service.js) and reads true
// everywhere, so a super-admin token can show the fields are deployed and coherent, but not how an
// ADMIN, MEMBER or VIEWER is answered - that needs a token of somebody on that rung.
//
// process.exitCode, never process.exit(): exiting after a fetch aborts Node 24 on Windows (V32).

const BASE = (process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in").replace(/\/+$/, "");
const TOKEN = process.env.CAPRO_TOKEN || "";
const EXPECT_TRANSFER = process.env.CAPRO_EXPECT_TRANSFER === "1";

let pass = 0;
let fail = 0;
let note = 0;
const check = (id, ok, detail) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${id}  ${detail}`);
};
const info = (id, detail) => {
  note += 1;
  console.log(`  INFO ${id}  ${detail}`);
};
const tail = (id) => (id ? `...${String(id).slice(-6)}` : "none");

async function call(method, path, { auth = true, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, ms: Date.now() - started };
}

// The write guard's ladder (firm-authority.service.js) as the clients should expect it: an owner, an
// administrator or an editing member may write; a viewer, or a member of a READ_ONLY firm, may not;
// a super admin may, except in somebody else's personal workspace.
function expectedWrite(accountRole, workspace) {
  if (!workspace) return false;
  if (accountRole === "SUPER_ADMIN") return true;
  const role = String(workspace.role || "");
  if (role === "OWNER" || role === "ADMIN") return true;
  if (role === "VIEWER") return false;
  if (role === "MEMBER") return workspace.memberAccess !== "READ_ONLY";
  return false;
}

async function main() {
  console.log(`Live permission check against ${BASE}`);

  const health = await call("GET", "/health", { auth: false });
  check("health", health.status === 200, `status ${health.status}, uptime ${health.json?.uptime ?? health.json?.uptimeSeconds ?? "?"} s`);

  const controlPath = "/api/auth/definitely-not-a-real-route-xyz";
  const controlOut = await call("GET", controlPath, { auth: false });
  info("control-signed-out", `status ${controlOut.status}, ${controlOut.text.length} bytes`);

  if (!TOKEN) {
    console.log("\nCAPRO_TOKEN not set: nothing signed in was checked.");
    return fail === 0 ? 0 : 1;
  }

  const controlIn = await call("GET", controlPath);
  check("control-signed-in", controlIn.status === 404, `status ${controlIn.status}, code ${controlIn.json?.code ?? "-"}`);

  const me = await call("GET", "/api/auth/me");
  const user = me.json?.user || me.json || {};
  const accountRole = String(user.role || "");
  check("auth-me", me.status === 200 && Boolean(accountRole), `status ${me.status}, account role ${accountRole || "?"}, accountType ${user.accountType || "?"}`);
  if (me.status !== 200) {
    console.log("\nThe token was refused; nothing further can be checked.");
    return 1;
  }
  if (accountRole === "SUPER_ADMIN") {
    info("bypass", "SUPER_ADMIN is the global bypass: every write answer below should read true; this token cannot show an ADMIN, MEMBER or VIEWER verdict");
  }

  const config = await call("GET", "/api/app-config");
  const flags = config.json?.config?.featureFlags || config.json?.featureFlags || {};
  const off = Object.entries(flags).filter(([, value]) => value === false).map(([key]) => key);
  check("app-config", config.status === 200, `status ${config.status}, ${Object.keys(flags).length} flags, off: ${off.length ? off.join(", ") : "none"}`);

  const list = await call("GET", "/api/firms/workspaces");
  const workspaces = Array.isArray(list.json?.workspaces) ? list.json.workspaces : [];
  check("workspaces", list.status === 200 && workspaces.length > 0, `status ${list.status}, ${workspaces.length} workspace(s)`);
  for (const w of workspaces) {
    info("workspace", `${tail(w.id)} kind ${w.kind}${w.isPersonal ? " (personal)" : ""}, role ${w.role}, members ${w.memberCount}, memberAccess ${w.memberAccess}${w.isActive ? ", ACTIVE" : ""}`);
  }
  const active = workspaces.find((w) => w.isActive) || null;
  const expected = expectedWrite(accountRole, active);
  info("expected", `active workspace ${tail(active?.id)} role ${active?.role ?? "none"}: a write should be ${expected ? "accepted" : "refused"}`);

  // R23: canComplete on the my-open read, at the response and on every row, equals the guard.
  const open = await call("GET", "/api/tasks/my-open");
  const rows = Array.isArray(open.json?.tasks) ? open.json.tasks : [];
  const rowValues = [...new Set(rows.map((t) => t.canComplete))];
  check(
    "R23 my-open canComplete",
    open.status === 200 && typeof open.json?.canComplete === "boolean" && open.json.canComplete === expected
      && rows.every((t) => t.canComplete === open.json.canComplete),
    `status ${open.status}, canComplete ${open.json?.canComplete}, ${rows.length} row(s) carrying ${rowValues.length ? rowValues.join("/") : "-"}`,
  );
  if (rows[0]?._id) {
    const one = await call("GET", `/api/tasks/${encodeURIComponent(rows[0]._id)}`);
    check("R23 task read canComplete", one.status === 200 && typeof one.json?.canComplete === "boolean", `status ${one.status}, canComplete ${one.json?.canComplete} (false is right for a task that is not open)`);
  } else {
    info("R23 task read", "no open task to read; skipped");
  }

  // R24: canWrite on the tax work list.
  const tax = await call("GET", "/api/taxworker/sessions");
  check(
    "R24 taxworker canWrite",
    tax.status === 200 && typeof tax.json?.canWrite === "boolean" && tax.json.canWrite === expected,
    `status ${tax.status}, canWrite ${tax.json?.canWrite}, ${Array.isArray(tax.json?.sessions) ? tax.json.sessions.length : "?"} session(s)`,
  );

  // R26/R27: the members read, for every workspace with other people in it. The owner pointer is not
  // in this read; role OWNER in the workspace list is the confirmed owner (a stale row reads MEMBER).
  let ownedShared = null;
  for (const w of workspaces) {
    const members = await call("GET", `/api/firms/${encodeURIComponent(w.id)}/members`);
    const people = Array.isArray(members.json?.members) ? members.json.members : [];
    const byRole = people.reduce((acc, m) => ({ ...acc, [m.role]: (acc[m.role] || 0) + 1 }), {});
    const shared = w.kind === "SHARED" && !w.isPersonal;
    const isOwner = w.role === "OWNER";
    if (shared && isOwner && !ownedShared) ownedShared = w;
    const detail = `status ${members.status}, ${people.length} member(s) ${JSON.stringify(byRole)}`;
    if (!EXPECT_TRANSFER) {
      check(`members ${tail(w.id)}`, members.status === 200, detail);
      continue;
    }
    const offered = members.json?.canTransferOwnership;
    const receivable = people.filter((m) => m.canReceiveOwnership === true).length;
    check(
      `R27 members ${tail(w.id)}`,
      members.status === 200 && offered === (shared && isOwner)
        && people.every((m) => typeof m.canReceiveOwnership === "boolean")
        && (offered || receivable === 0)
        && people.every((m) => !(m.isYou && m.canReceiveOwnership)),
      `${detail}, canTransferOwnership ${offered}, ${receivable} may receive it`,
    );
  }

  if (EXPECT_TRANSFER) {
    // Refusals only. Neither request can reach a write: an unknown firm is refused before anything is
    // read about the caller, and a request with no toUserId is refused before the first write.
    const unknownFirm = "0123456789abcdef01234567";
    const ghost = await call("POST", `/api/firms/${unknownFirm}/transfer-ownership`, { body: {} });
    check(
      "R27 route deployed (unknown firm)",
      ghost.status === 404 && /Workspace not found/.test(String(ghost.json?.error || "")) && ghost.json?.code !== "NOT_FOUND",
      `status ${ghost.status}, "${ghost.json?.error || ""}" (the control path answers code ${controlIn.json?.code ?? "-"})`,
    );
    const signedOut = await call("POST", `/api/firms/${unknownFirm}/transfer-ownership`, { auth: false, body: {} });
    info("R27 signed out", `status ${signedOut.status} (the catch-all answers every signed-out /api path the same way, so this proves nothing alone)`);
    const own = ownedShared || workspaces.find((w) => w.isPersonal) || null;
    if (own) {
      const refusedProbe = await call("POST", `/api/firms/${encodeURIComponent(own.id)}/transfer-ownership`, { body: {} });
      const expectedError = ownedShared ? /Choose the member/ : /personal workspace cannot be transferred|Only the workspace owner/;
      check(
        `R27 refusal on ${ownedShared ? "an owned shared" : "the personal"} workspace`,
        refusedProbe.status === (ownedShared || own.role === "OWNER" ? 400 : 403) && expectedError.test(String(refusedProbe.json?.error || "")),
        `status ${refusedProbe.status}, "${refusedProbe.json?.error || ""}"`,
      );
    } else {
      info("R27 refusal", "no workspace this caller owns; skipped");
    }
  }

  console.log(`\nLive permission check: ${pass} passed, ${fail} failed, ${note} notes`);
  return fail === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`FAIL harness: ${error?.message || error}`);
  process.exitCode = 1;
}
