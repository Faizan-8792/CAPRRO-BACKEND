// A reviewer's decision on an AI suggestion saves (2026-10-13).
//
// Found while recording the tutorials: every Accept, Reject or Edit on a working-paper suggestion
// failed with a 500, "Durable provider admission metadata is incomplete". The analysis was loaded
// without processingAttemptId (select: false on the model), and the save's validation read the field
// it had not loaded as missing. Nothing covered the decision path; this suite saves a decision on a
// loaded analysis, both ways the service may load it, and keeps the rule that an analysis cannot be
// CREATED without its admission record.
//
// Needs a scratch mongod: MONGODB_URI, set by tools/run-gates.ps1 (scratch-gates-wp-decision). It
// refuses any database whose name lacks "scratch", and drops its own database when done.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mongoose from "mongoose";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.log("[SKIP] working-paper-decision-save-contract: no MONGODB_URI (a scratch mongod); tools/run-gates.ps1 sets one");
} else {
  const dbName = (uri.split("/").pop() || "").split("?")[0];
  const host = (uri.split("//")[1] || "").split("/")[0];
  if (!/scratch/i.test(dbName) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    console.error(`REFUSING TO RUN: ${host}/${dbName} is not a loopback scratch database.`);
    process.exitCode = 1;
  } else {
    const { default: Analysis, OUTBOUND_DATA_CLASSES } = await import("../src/models/AuditWorkingPaperAnalysis.js");
    await mongoose.connect(uri);
    const id = () => new mongoose.Types.ObjectId();
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    const user = id();
    const row = { rowId: id(), contentHash: hash("row") };
    const proposal = (title) => ({ title, description: `${title}, cited.`, category: "DOCUMENT_GAP", risk: "UNASSESSED", citedRows: [row] });
    const record = (extra = {}) => ({
      firmId: id(),
      workingPaperId: id(),
      engagementId: id(),
      clientId: id(),
      status: "SUPPORTED",
      selectedRows: [row],
      proposals: [proposal("No reply to the confirmation"), proposal("Follow up the balance")],
      promptVersion: "audit-working-paper-findings-v2",
      providerAdmissionVersion: "durable-consent-v1",
      processingAttemptId: String(id()),
      processingStartedAt: new Date(),
      providerCompletedAt: new Date(),
      outboundDataClasses: [...OUTBOUND_DATA_CLASSES],
      outboundPayloadHash: hash("payload"),
      externalProcessingConsentAt: new Date(),
      externalProcessingConsentBy: user,
      creationMutationKey: `create-${Date.now()}-${Math.random()}`,
      creationRequestHash: hash("request"),
      createdBy: user,
      updatedBy: user,
      ...extra,
    });
    const decide = (doc, index, decision) => {
      const p = doc.proposals[index];
      p.disposition.decision = decision;
      p.disposition.note = "Reviewed against the ageing report.";
      p.disposition.decidedBy = user;
      p.disposition.decidedAt = new Date();
      doc.revision += 1;
      doc.updatedBy = user;
    };

    try {
      await check("a decision saves on an analysis loaded the default way (without the hidden field)", async () => {
        const created = await Analysis.create(record());
        const loaded = await Analysis.findById(created._id);
        assert.equal(loaded.isSelected("processingAttemptId"), false, "the default load leaves it out");
        decide(loaded, 0, "ACCEPTED");
        await loaded.save();
        const again = await Analysis.findById(created._id).select("+processingAttemptId").lean();
        assert.equal(again.proposals[0].disposition.decision, "ACCEPTED");
        assert.equal(again.processingAttemptId, created.processingAttemptId, "the unloaded field is untouched");
      });

      await check("a decision saves on an analysis loaded whole, as the service now loads it", async () => {
        const created = await Analysis.create(record());
        const loaded = await Analysis.findById(created._id).select("+processingAttemptId");
        decide(loaded, 1, "REJECTED");
        await loaded.save();
        const again = await Analysis.findById(created._id).lean();
        assert.equal(again.proposals[1].disposition.decision, "REJECTED");
      });

      await check("an analysis still cannot be created without its admission record", async () => {
        for (const missing of ["processingAttemptId", "processingStartedAt", "outboundPayloadHash"]) {
          await assert.rejects(
            Analysis.create(record({ [missing]: missing === "processingAttemptId" ? "" : null })),
            /admission metadata is incomplete/,
            `created without ${missing}`,
          );
        }
        await assert.rejects(Analysis.create(record({ outboundDataClasses: OUTBOUND_DATA_CLASSES.slice(1) })), /admission metadata is incomplete/);
      });

      await check("the service loads the analysis whole before saving a decision", async () => {
        const { readFileSync } = await import("node:fs");
        const source = readFileSync(new URL("../src/services/audit-working-paper.service.js", import.meta.url), "utf8");
        const start = source.indexOf("async function dispositionAuditFindingProposal(");
        const body = source.slice(start, source.indexOf("\nasync function ", start + 10));
        assert.match(body, /AuditWorkingPaperAnalysis\.findOne\(\{[\s\S]*?\}\)\s*(\/\/[^\n]*\n\s*)?\.select\("\+processingAttemptId"\)/);
      });
    } finally {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    }
  }
}

console.log(`\nworking-paper-decision-save-contract: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
