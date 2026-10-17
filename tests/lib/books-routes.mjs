// tests/lib/books-routes.mjs
//
// W10 AP18-AP21: the books snapshot through the real Express app against a scratch MongoDB - create, upload in
// chunks (in order, repeated, out of order, tampered), seal, group mapping, the party master and the diff of two
// snapshots. Called by books-snapshot-contract.mjs.

export async function runBooksRouteChecks({ uri, MASTERS, DAYBOOK, only, linesOf, sha }) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name: `route: ${name}`, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const { chunkDigest } = await import("../../src/services/books/tally-canonical.js");
  const { readSnapshotMasters, streamVouchers } = await import("../../src/services/books-snapshot.service.js");

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, name: `Books Firm ${label}`, displayName: `Books Firm ${label}`, handle: `scratch-books-${label.toLowerCase()}`, ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `JBK${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "Books Traders", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const send = (snapshotId, kind, seq, ndjson, token = A.token, hash = sha(ndjson)) =>
    call("POST", `/api/books/snapshots/${snapshotId}/chunks`, token, { kind, seq, ndjson, hash });
  const digestOf = (log) => chunkDigest(log);

  try {
    // ─── create ───
    const created = await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2025-26", source: "TALLY_XML", label: "First export" });
    const id = created.json?.snapshot?.id;
    check("create answers 201 with a DRAFT snapshot", created.status === 201 && created.json?.snapshot?.status === "DRAFT", `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}`);
    check("a client from another firm is 404", (await call("POST", "/api/books/snapshots", B.token, { clientId: String(clientId), financialYear: "2025-26" })).status === 404);
    check("a financial year that is not consecutive is refused", (await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2025-27" })).status === 400);
    check("a field the route does not take is refused", (await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2025-26", status: "SEALED" })).status === 400);

    // ─── chunks ───
    const groupsChunk = only(MASTERS, "group");
    const ledgersChunk = only(MASTERS, "ledger");
    const vouchersChunk = only(DAYBOOK, "voucher");
    const g0 = await send(id, "groups", 0, groupsChunk);
    check("the first chunk of groups is accepted (201, 3 stored)", g0.status === 201 && g0.json?.accepted === 3 && g0.json?.snapshot?.counts?.groups === 3, `status ${g0.status} ${JSON.stringify(g0.json)?.slice(0, 200)}`);
    const again = await send(id, "groups", 0, groupsChunk);
    check("the same chunk sent again is a duplicate (200) and stores nothing more", again.status === 200 && again.json?.duplicate === true && again.json?.snapshot?.counts?.groups === 3, `status ${again.status}`);
    check("a different chunk at an accepted position is 409 BOOKS_CHUNK_CONFLICT", (await send(id, "groups", 0, `${linesOf(groupsChunk)[0]}\n`)).json?.code === "BOOKS_CHUNK_CONFLICT");
    const skip = await send(id, "ledgers", 3, ledgersChunk);
    check("a chunk out of order is refused 409, saying which to send next", skip.status === 409 && skip.json?.code === "BOOKS_CHUNK_OUT_OF_ORDER" && /Send chunk 0/.test(skip.json?.error || skip.json?.message || ""), `status ${skip.status} ${JSON.stringify(skip.json)}`);
    const bad = await send(id, "ledgers", 0, ledgersChunk, A.token, sha("something else"));
    check("a chunk that does not match its hash is refused 400 and stores nothing", bad.status === 400 && bad.json?.code === "BOOKS_CHUNK_HASH_MISMATCH" && (await raw("booksledgers").countDocuments({})) === 0, `status ${bad.status}`);
    const tampered = JSON.parse(linesOf(ledgersChunk)[0]);
    tampered.extra = "x";
    const rejected = await send(id, "ledgers", 0, `${JSON.stringify(tampered)}\n`);
    check("a record with an unknown field is refused 400 naming the line", rejected.status === 400 && /Line 1/.test(rejected.json?.error || rejected.json?.message || ""), `status ${rejected.status} ${JSON.stringify(rejected.json)}`);
    const l0 = await send(id, "ledgers", 0, ledgersChunk);
    const v0 = await send(id, "vouchers", 0, vouchersChunk);
    check("ledgers and vouchers are accepted in their own sequences", l0.status === 201 && v0.status === 201 && v0.json?.snapshot?.counts?.vouchers === 8, `${l0.status}/${v0.status}`);
    check("the snapshot's alter id range spans masters and vouchers (one sequence in Tally), its dates the vouchers'", v0.json?.snapshot?.alterId?.min === 2 && v0.json.snapshot.alterId.max === 508 && v0.json.snapshot.voucherDates.min === "2025-04-15", JSON.stringify(v0.json?.snapshot?.alterId));
    check("the server counts what it found unreadable itself", v0.json?.snapshot?.warnings?.amountsUnreadable === 2 && v0.json.snapshot.warnings.datesUnreadable === 1 && v0.json.snapshot.warnings.recordsWithWarnings === 3, JSON.stringify(v0.json?.snapshot?.warnings));
    check("a snapshot of another firm reads as 404", (await call("GET", `/api/books/snapshots/${id}`, B.token)).status === 404);
    const dup = await send(id, "vouchers", 1, vouchersChunk);
    check("a record already in the snapshot, sent in a new chunk, is refused 409 and leaves the first copy alone", dup.status === 409 && dup.json?.code === "BOOKS_DUPLICATE_RECORD" && (await raw("booksvouchers").countDocuments({})) === 8, `status ${dup.status} ${JSON.stringify(dup.json)} stored ${await raw("booksvouchers").countDocuments({})}`);

    // ─── seal ───
    const snapshot = (await call("GET", `/api/books/snapshots/${id}`, A.token)).json.snapshot;
    const stored = await raw("bookssnapshots").findOne({ _id: new mongoose.Types.ObjectId(id) });
    const digest = digestOf(stored.chunkLog);
    const wrongCounts = await call("POST", `/api/books/snapshots/${id}/seal`, A.token, { counts: { groups: 3, ledgers: 4, vouchers: 9 }, chunkDigest: digest });
    check("sealing with a count that is not what was stored is refused 409", wrongCounts.status === 409 && wrongCounts.json?.code === "BOOKS_SNAPSHOT_COUNT_MISMATCH", `status ${wrongCounts.status}`);
    const wrongDigest = await call("POST", `/api/books/snapshots/${id}/seal`, A.token, { counts: snapshot.counts, chunkDigest: sha("nope") });
    check("sealing with a digest that is not the chunks' is refused 409", wrongDigest.status === 409 && wrongDigest.json?.code === "BOOKS_SNAPSHOT_DIGEST_MISMATCH", `status ${wrongDigest.status}`);
    const sealed = await call("POST", `/api/books/snapshots/${id}/seal`, A.token, { counts: snapshot.counts, chunkDigest: digest });
    check("sealing with the right counts and digest seals it, and records the digest", sealed.status === 200 && sealed.json?.snapshot?.status === "SEALED" && sealed.json.snapshot.contentHash === digest, `status ${sealed.status} ${JSON.stringify(sealed.json)?.slice(0, 200)}`);
    check("a sealed snapshot takes no more chunks (409 BOOKS_SNAPSHOT_SEALED)", (await send(id, "vouchers", 1, vouchersChunk)).json?.code === "BOOKS_SNAPSHOT_SEALED");
    check("sealing again answers the same snapshot and changes nothing", (await call("POST", `/api/books/snapshots/${id}/seal`, A.token, { counts: snapshot.counts, chunkDigest: digest })).json?.alreadySealed === true);
    const empty = (await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2025-26" })).json.snapshot.id;
    check("an empty snapshot cannot be sealed", (await call("POST", `/api/books/snapshots/${empty}/seal`, A.token, { counts: { groups: 0, ledgers: 0, vouchers: 0 }, chunkDigest: chunkDigest([]) })).json?.code === "BOOKS_SNAPSHOT_EMPTY");

    // ─── group mapping ───
    const report = (await call("GET", `/api/books/snapshots/${id}/groups`, A.token)).json;
    const byName = Object.fromEntries((report.groups || []).map((g) => [g.name, g]));
    check("a custom group resolves through its parent to Sundry Creditors", byName["Raw Material Suppliers"]?.standardGroup === "SUNDRY_CREDITORS" && byName["Raw Material Suppliers"]?.source === "PARENT_CHAIN", JSON.stringify(byName["Raw Material Suppliers"]));
    check("a ledger parent Tally never exported (Cash-in-Hand) resolves by its own name", byName["Cash-in-Hand"]?.standardGroup === "CASH", JSON.stringify(byName["Cash-in-Hand"]));
    check("nothing is unmapped in the fixture", report.unmappedGroups === 0 && report.unmappedLedgers === 0, JSON.stringify({ g: report.unmappedGroups, l: report.unmappedLedgers }));

    // A second, small snapshot whose ledger hangs from a group that leads nowhere.
    const odd = (await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2024-25" })).json.snapshot.id;
    const oddGroups = `${JSON.stringify({ t: "group", guid: "g1", alterId: 1, name: "Mystery", parent: "Elsewhere", reserved: "", warnings: [] })}\n`;
    const oddLedgers = `${JSON.stringify({ t: "ledger", guid: "l1", alterId: 2, name: "Some Party", parent: "Mystery", openingMinor: null, gstin: "", pan: "", gstRegistrationType: "", isBillwise: null, creditPeriodDays: null, udyam: "", warnings: [] })}\n`;
    await send(odd, "groups", 0, oddGroups);
    await send(odd, "ledgers", 0, oddLedgers);
    const oddReport = (await call("GET", `/api/books/snapshots/${odd}/groups`, A.token)).json;
    check("a group that leads nowhere is listed unmapped, with its ledger counted", oddReport.unmappedGroups >= 1 && oddReport.groups.find((g) => g.name === "Mystery")?.standardGroup === null && oddReport.unmappedLedgers === 1, JSON.stringify(oddReport.groups));
    const suggestion = await call("POST", `/api/books/snapshots/${odd}/groups/suggest`, A.token, { groups: ["Mystery"] });
    check("with no AI key the suggestion route says so and the mapping still works", suggestion.status === 200 && suggestion.json?.available === false && suggestion.json?.suggestions?.length === 0, `status ${suggestion.status} ${JSON.stringify(suggestion.json)}`);
    const refusedCode = await call("PUT", "/api/books/group-mappings", A.token, { clientId: String(clientId), groupName: "Mystery", standardGroup: "MADE_UP" });
    check("a mapping to a code that is not a standard group is refused", refusedCode.status === 400, `status ${refusedCode.status}`);
    const mapped = await call("PUT", "/api/books/group-mappings", A.token, { clientId: String(clientId), groupName: "Mystery", standardGroup: "SUNDRY_DEBTORS" });
    check("a person's mapping is stored with its source", mapped.status === 200 && mapped.json?.mapping?.standardGroup === "SUNDRY_DEBTORS" && mapped.json.mapping.source === "USER", `status ${mapped.status}`);
    const afterMap = (await call("GET", `/api/books/snapshots/${odd}/groups`, A.token)).json;
    check("after the mapping the group and its ledger resolve, from the person", afterMap.unmappedLedgers === 0 && afterMap.groups.find((g) => g.name === "Mystery")?.source === "USER", JSON.stringify(afterMap.groups));
    check("another firm cannot map a group for this client", (await call("PUT", "/api/books/group-mappings", B.token, { clientId: String(clientId), groupName: "X", standardGroup: "CASH" })).status === 404);

    // ─── masters and vouchers for the engines ───
    const masters = await readSnapshotMasters({ firmId: A.firmId, snapshotId: id });
    const asha = masters.ledgers.find((l) => l.name === "Asha Fabrics & Co");
    check("a ledger is read with its standard group and where that came from", asha?.standardGroup === "SUNDRY_CREDITORS" && asha.groupSource === "PARENT_CHAIN" && asha.groupChain.length === 2, JSON.stringify(asha && { g: asha.standardGroup, s: asha.groupSource }));
    let streamed = 0;
    let order = true;
    let last = "";
    for await (const v of streamVouchers({ firmId: A.firmId, snapshotId: id, batchSize: 3 })) {
      streamed += 1;
      if (String(v._id) < last) order = false;
      last = String(v._id);
    }
    check("vouchers stream in pages of any size, all of them, once", streamed === 8 && order, `streamed ${streamed}`);

    // ─── the party master ───
    const early = await call("POST", `/api/books/snapshots/${empty}/parties/seed`, A.token);
    check("the party master is not built from a snapshot that is not sealed", early.status === 409, `status ${early.status}`);
    const seeded = await call("POST", `/api/books/snapshots/${id}/parties/seed`, A.token);
    const party = seeded.json?.parties?.find((p) => p.name === "Asha Fabrics & Co");
    check("sundry creditors become parties with what Tally holds", seeded.status === 200 && seeded.json?.parties?.length === 1 && party?.gstin === "27AAAAA1111A1Z1" && party.creditPeriodDays === 45 && party.udyamNumber === "UDYAM-MH-01-0000001", JSON.stringify(seeded.json)?.slice(0, 300));
    check("an Udyam number does not make a category: it stays UNKNOWN", party?.udyamCategory === "UNKNOWN" && seeded.json.counts.udyamCategoryUnknown === 1);
    check("related person and lender are unknown until a person says", party?.relatedPerson === null && party.lenderOrDepositor === null && seeded.json.counts.relatedPersonUnknown === 1);
    check("what Tally left blank is named (PAN present, nothing blank here but the GST status is unknown)", Array.isArray(party?.blanks) && !party.blanks.includes("GSTIN") && party.gstStatus === "UNKNOWN", JSON.stringify(party));
    const patched = await call("PATCH", `/api/books/parties/${party.id}`, A.token, { expectedVersion: party.version, udyamCategory: "SMALL", relatedPerson: false });
    check("a person answers a flag; who and when are recorded", patched.status === 200 && patched.json?.party?.udyamCategory === "SMALL" && patched.json.party.relatedPerson === false && patched.json.party.confirmedBy === String(A.ownerId) && patched.json.party.version === 1, `status ${patched.status} ${JSON.stringify(patched.json)?.slice(0, 200)}`);
    check("a stale version is refused 409", (await call("PATCH", `/api/books/parties/${party.id}`, A.token, { expectedVersion: 0, udyamCategory: "MICRO" })).json?.code === "PARTY_CHANGED");
    check("a category that is not one is refused", (await call("PATCH", `/api/books/parties/${party.id}`, A.token, { expectedVersion: 1, udyamCategory: "HUGE" })).status === 400);
    check("another firm cannot answer for this party", (await call("PATCH", `/api/books/parties/${party.id}`, B.token, { expectedVersion: 1, relatedPerson: true })).status === 404);
    const reseeded = await call("POST", `/api/books/snapshots/${id}/parties/seed`, A.token);
    const kept = reseeded.json?.parties?.find((p) => p.name === "Asha Fabrics & Co");
    check("seeding again refreshes Tally's fields and never touches a person's answers", kept?.udyamCategory === "SMALL" && kept.relatedPerson === false && reseeded.json.parties.length === 1, JSON.stringify(kept));

    // ─── the diff ───
    const second = (await call("POST", "/api/books/snapshots", A.token, { clientId: String(clientId), financialYear: "2025-26", label: "Second export" })).json.snapshot.id;
    const vouchers = linesOf(vouchersChunk).map((l) => JSON.parse(l));
    const changed = vouchers
      .filter((v) => v.guid !== "v-0001")
      .map((v) => (v.guid === "v-0003" ? { ...v, alterId: 509, entries: v.entries.map((e, i) => (i === 1 ? { ...e, amountMinor: e.amountMinor - 100 } : e)) } : v));
    changed.push({ ...vouchers[0], guid: "v-0009", alterId: 510, number: "9" });
    const secondChunk = `${changed.map((v) => JSON.stringify(v)).join("\n")}\n`;
    await send(second, "groups", 0, groupsChunk);
    await send(second, "ledgers", 0, ledgersChunk);
    await send(second, "vouchers", 0, secondChunk);
    const secondStored = await raw("bookssnapshots").findOne({ _id: new mongoose.Types.ObjectId(second) });
    await call("POST", `/api/books/snapshots/${second}/seal`, A.token, { counts: { groups: 3, ledgers: 4, vouchers: 8 }, chunkDigest: digestOf(secondStored.chunkLog) });
    const diff = await call("GET", `/api/books/snapshots/${id}/diff?against=${second}`, A.token);
    const d = diff.json?.diff;
    check("the diff counts one inserted, one deleted, one altered and six unchanged vouchers", diff.status === 200 && d?.counts?.inserted === 1 && d.counts.deleted === 1 && d.counts.altered === 1 && d.counts.unchanged === 6, JSON.stringify(d?.counts));
    check("the altered voucher is named with what changed (its amounts)", d?.samples?.altered?.[0]?.guid === "v-0003" && d.samples.altered[0].changed.includes("amounts") && d.alteredFields.amounts === 1, JSON.stringify(d?.samples?.altered));
    check("the vouchers changed after the first export's last alter id are counted (the alteration and the insertion)", d?.changedAfterBaseAlterId === 2, `${d?.changedAfterBaseAlterId}`);
    check("the diff says what it cannot show", /who changed a record or when/.test(d?.limits || ""));
    const reversed = await call("GET", `/api/books/snapshots/${second}/diff?against=${id}`, A.token);
    check("the diff is the same whichever snapshot is named first (the earlier export is the base)", reversed.json?.diff?.base?.id === id && reversed.json.diff.counts.inserted === 1, JSON.stringify(reversed.json?.diff?.counts));
    check("a snapshot not yet sealed cannot be diffed", (await call("GET", `/api/books/snapshots/${id}/diff?against=${empty}`, A.token)).status === 409);
    const oddStored = await raw("bookssnapshots").findOne({ _id: new mongoose.Types.ObjectId(odd) });
    await call("POST", `/api/books/snapshots/${odd}/seal`, A.token, { counts: { groups: 1, ledgers: 1, vouchers: 0 }, chunkDigest: digestOf(oddStored.chunkLog) });
    const otherYear = await call("GET", `/api/books/snapshots/${id}/diff?against=${odd}`, A.token);
    check("two snapshots of different years cannot be diffed", otherYear.status === 400 && otherYear.json?.code === "BOOKS_SNAPSHOT_MISMATCH", `status ${otherYear.status}`);
    check("another firm cannot diff them", (await call("GET", `/api/books/snapshots/${id}/diff?against=${second}`, B.token)).status === 404);

    // ─── the flag ───
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/books/snapshots", A.token);
    check("with auditPacks off every books route answers 404 naming the flag", off.status === 404 && off.json?.featureFlag === "auditPacks", `status ${off.status}`);
  } catch (error) {
    // A throw mid-flow must not hide which checks had already failed before it.
    check("the flow ran to its end without throwing", false, String(error?.stack || error).split("\n").slice(0, 3).join(" | "));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return checks;
}
