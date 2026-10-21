// tests/import-mapping-profile-contract.mjs
//
// W11 IN14 + IN15 (2026-10-21): imports remember a client's confirmed column mapping per file layout, and the model
// suggests a mapping for headings nothing recognises - from the headings and column types alone. Through the real
// app (preview, commit, suggest) against a scratch database and a loopback stand-in for DeepSeek.
//
// Pinned: with `intelligence` off nothing is remembered and the suggestion is unchanged (HEADINGS); with it on, a
// committed import saves its mapping and the next file in the same layout for the same client is mapped from it
// (REMEMBERED, complete); a changed layout, another client and another firm get the heading guess; the model
// suggestion sends no cell value, refuses a field the kind does not have, and needs the firm's opt-in and consent.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-import-mapping node tests/import-mapping-profile-contract.mjs

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);

if (!scratch) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exitCode = 2;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const { headerSignature } = await import("../src/services/import-intelligence.service.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  for (const name of ["AiDraft", "AiSuggestionOutcome", "ImportMappingProfile"]) await (await import(`../src/models/${name}.js`)).default.syncIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, displayName: `Mapping Firm ${label}`, handle: `scratch-map-${label.toLowerCase()}`, ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JMP${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  const otherClientId = oid();
  await raw("clients").insertMany([
    { _id: clientId, firmId: A.firmId, name: "ABC Traders Pvt Ltd", isActive: true, createdAt: now, updatedAt: now },
    { _id: otherClientId, firmId: A.firmId, name: "Other Client", isActive: true, createdAt: now, updatedAt: now },
  ]);
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true, intelligence: false }, createdAt: now, updatedAt: now });

  // A trial balance whose headings the synonyms do not all know: "Acct Head" is the ledger name.
  const layout = (rows) => ["ABC Traders Pvt Ltd,,", "Trial Balance,,", "Acct Head,Closing Dr,Closing Cr", ...rows].join("\n");
  const rowsA = ["Capital Account,,\"25,00,000.00\"", "Purchase of Goods,\"50,00,000.00\",", "Sales,,\"25,00,000.00\""];
  const fileA = layout(rowsA);
  const fileB = layout(["Rent,\"6,00,000.00\",", "Cash,,\"6,00,000.00\""]);
  const changed = ["ABC Traders Pvt Ltd,,,", "Trial Balance,,,", "Acct Head,Group,Closing Dr,Closing Cr", "Rent,Expenses,\"6,00,000.00\",", "Cash,Assets,,\"6,00,000.00\""].join("\n");

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const suggest = (text, token = A.token, client = clientId) => call("POST", "/api/imports/suggest-mapping", token, { kind: "TRIAL_BALANCE", text, clientId: String(client) });
  async function commit(text, mapping, financialYear) {
    const previewBody = { kind: "TRIAL_BALANCE", text, mapping, clientId: String(clientId), financialYear };
    const previewed = await call("POST", "/api/imports/preview", A.token, previewBody);
    const { commitToken, sourceHash } = previewed.json?.preview || {};
    return call("POST", `/api/imports/${sourceHash}/books-commit`, A.token, { ...previewBody, previewToken: commitToken, sourceName: "tb.csv" });
  }

  try {
    const first = await suggest(fileA);
    const heading = first.json?.suggestion;
    check("with intelligence off: the suggestion is the heading guess, nothing remembered", first.status === 200 && heading?.mappingSource === "HEADINGS" && heading.remembered === null && /^[a-f0-9]{64}$/.test(heading.headerSignature), JSON.stringify(heading)?.slice(0, 300));
    check("the heading guess does not place \"Acct Head\" (the case the memory is for)", heading?.complete === false && heading.missingRequired.includes("ledgerName"), JSON.stringify(heading?.missingRequired));
    const personMapping = { ...heading.suggestedMapping, ledgerName: "Acct Head" };
    const offCommit = await commit(fileA, personMapping, "2025-26");
    check("with intelligence off a commit saves no profile", offCommit.status === 201 && (await raw("importmappingprofiles").countDocuments({})) === 0, `status ${offCommit.status} ${JSON.stringify(offCommit.json)?.slice(0, 200)}`);

    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": true } });
    const onCommit = await commit(fileB, personMapping, "2024-25");
    const profile = await raw("importmappingprofiles").findOne({ firmId: A.firmId, clientId });
    check("with intelligence on a committed import saves its mapping for the client and layout", onCommit.status === 201 && profile?.kind === "TRIAL_BALANCE" && profile.mapping.ledgerName === "Acct Head" && profile.headerSignature === heading.headerSignature && String(profile.confirmedBy) === String(A.ownerId), JSON.stringify(profile));

    const remembered = (await suggest(fileA)).json?.suggestion;
    check("the next file in the same layout is mapped from memory, complete", remembered?.mappingSource === "REMEMBERED" && remembered.suggestedMapping.ledgerName === "Acct Head" && remembered.complete === true && remembered.missingRequired.length === 0 && remembered.remembered.timesApplied === 1, JSON.stringify(remembered)?.slice(0, 400));
    const changedLayout = (await suggest(changed)).json?.suggestion;
    check("a changed layout gets the heading guess, not the memory", changedLayout?.mappingSource === "HEADINGS" && changedLayout.headerSignature !== heading.headerSignature);
    const otherClient = (await suggest(fileA, A.token, otherClientId)).json?.suggestion;
    check("another client of the same firm does not get this client's mapping", otherClient?.mappingSource === "HEADINGS");
    const otherFirm = (await suggest(fileA, B.token, clientId)).json?.suggestion;
    check("another firm naming this client's id does not get the mapping", otherFirm?.mappingSource === "HEADINGS");
    check("the signature is the headings' identity: same headings, same signature", headerSignature(["Acct Head", "Closing Dr", "Closing Cr"]) === headerSignature([" acct  head", "CLOSING DR", "Closing Cr"]) && headerSignature(["Acct Head"]) !== headerSignature(["Closing Dr"]));

    // ─── the model suggestion ───
    mock.reset();
    mock.on((body) => {
      const input = JSON.parse(String(body.messages[1].content).split("INPUT (json):\n")[1]);
      const ref = input.items[0].headings.find((h) => h.text === "Acct Head")?.ref;
      return JSON.stringify({ items: [{ id: "file", mappings: [{ field: "ledgerName", headingRef: ref }] }] });
    });
    const refused = await call("POST", "/api/imports/mapping-suggestions", A.token, { kind: "TRIAL_BALANCE", text: fileA, consent: true });
    check("model suggestion: refused 403 until the firm opts in, nothing sent", refused.status === 403 && mock.calls.length === 0);
    await raw("firms").updateOne({ _id: A.firmId }, { $set: { aiDrafting: { enabled: true, changedBy: A.ownerId, changedAt: now } } });
    const noConsent = await call("POST", "/api/imports/mapping-suggestions", A.token, { kind: "TRIAL_BALANCE", text: fileA });
    check("model suggestion: refused 400 without consent", noConsent.status === 400 && noConsent.json?.code === "AI_CONSENT_REQUIRED" && mock.calls.length === 0);
    const suggested = await call("POST", "/api/imports/mapping-suggestions", A.token, { kind: "TRIAL_BALANCE", text: fileA, consent: true });
    check("model suggestion: the unmapped field comes back mapped to the heading text, labelled DRAFT FOR REVIEW", suggested.status === 200 && suggested.json?.suggestions?.ledgerName === "Acct Head" && suggested.json.label === "DRAFT FOR REVIEW" && typeof suggested.json.draftId === "string", JSON.stringify(suggested.json));
    const outbound = JSON.stringify(mock.calls[0]?.body || {});
    check("model suggestion: no cell value left CA PRO (no ledger name, no amount, no company name)", !/Capital Account|Purchase of Goods|25,00,000|ABC Traders/.test(outbound) && /Acct Head/.test(outbound) && /numeric/.test(outbound), outbound.slice(0, 400));
    mock.on(() => JSON.stringify({ items: [{ id: "file", mappings: [{ field: "openingBalance", headingRef: "h1" }] }] }));
    // A different layout, so this is a new question (the same headings and column shares would be answered from
    // the stored draft).
    const badField = await call("POST", "/api/imports/mapping-suggestions", A.token, { kind: "TRIAL_BALANCE", text: fileB.replace("Acct Head", "Head of A/c"), consent: true });
    check("model suggestion: a field that was not asked for is refused and nothing is suggested", badField.status === 200 && badField.json?.available === false && Object.keys(badField.json?.suggestions || {}).length === 0, JSON.stringify(badField.json));
    const extra = await call("POST", "/api/imports/mapping-suggestions", A.token, { kind: "TRIAL_BALANCE", text: fileA, consent: true, mapping: {} });
    check("model suggestion: a field the route does not take is refused", extra.status === 400);
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\nimport-mapping-profile-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
