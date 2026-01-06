// scripts/seed-taxwork-reminders-audit.js
// Seed 5-6 demo records for:
// - Tax Work (clients)
// - Compliance Reminders
// - Audit History (uses TaskDelayLog as the closest "history" model in this repo)
//
// Usage: node scripts/seed-taxwork-reminders-audit.js

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Firm from "../src/models/Firm.js";
import TaxWork from "../src/models/TaxWork.js";
import Reminder from "../src/models/Reminder.js";
import Task from "../src/models/Task.js";
import TaskDelayLog from "../src/models/TaskDelayLog.js";

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function ensureUserAndFirm(email) {
  let user = await User.findOne({ email });

  // If user doesn't exist, create user first (without firm), then create firm with ownerUserId.
  if (!user) {
    user = await User.create({
      name: "Demo User",
      email,
      password: "demo12345", // only for local dev
      plan: "PREMIUM",
      role: "USER",
    });
  }

  let firm = null;
  if (user.firmId) {
    firm = await Firm.findById(user.firmId);
  }

  if (!firm) {
    const handleBase = "demo-ca-firm";
    const suffix = String(Date.now()).slice(-5);
    const handle = `${handleBase}-${suffix}`;

    const joinCode = typeof Firm.generateJoinCode === "function" ? Firm.generateJoinCode() : "DEMO01";

    firm = await Firm.create({
      displayName: "Demo CA Firm",
      handle,
      ownerUserId: user._id,
      joinCode,
      description: "Auto-generated demo firm for seeding",
      planType: "PREMIUM",
      isActive: true,
    });

    user.firmId = firm._id;
    await user.save();
  }

  return { user, firm };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing in environment/.env");
  }

  await mongoose.connect(mongoUri);
  console.log("✅ Connected to MongoDB");

  const { user, firm } = await ensureUserAndFirm("demo.user@capro.local");
  console.log("✅ Using user:", user.email, "firm:", String(firm._id));

  // ----------------------
  // TAX WORK (5-6 clients)
  // ----------------------
  const serviceType = "GST";
  const clients = [
    { clientName: "Apex Traders", dueInDays: 7 },
    { clientName: "Blue Ocean Pvt Ltd", dueInDays: 10 },
    { clientName: "City Hardware", dueInDays: 12 },
    { clientName: "Delta Foods", dueInDays: 15 },
    { clientName: "Evergreen Textiles", dueInDays: 18 },
    { clientName: "FastTrack Logistics", dueInDays: 20 },
  ];

  const taxWorkDocs = [];
  for (const c of clients) {
    const doc = await TaxWork.create({
      firmId: firm._id,
      userId: user._id,
      serviceType,
      clientName: c.clientName,
      dueDate: addDays(new Date(), c.dueInDays).toISOString().slice(0, 10),
      checklist: {
        "Invoice Upload": true,
        "Reconciliation": false,
        "Return Filing": false,
      },
    });
    taxWorkDocs.push(doc);
  }
  console.log(`✅ Inserted Tax Work clients: ${taxWorkDocs.length}`);

  // ----------------------
  // COMPLIANCE REMINDERS (5-6)
  // ----------------------
  const reminderTypes = [
    "GST_GSTR1",
    "GST_GSTR3B",
    "TDS_26Q",
    "ITR_AUDIT",
    "ROC_AOC4",
    "GENERIC",
  ];

  const reminderDocs = [];
  for (let i = 0; i < reminderTypes.length; i++) {
    const due = addDays(new Date(), 3 + i * 2);
    const r = await Reminder.create({
      userId: user._id,
      firmId: firm._id,
      typeId: reminderTypes[i],
      clientLabel: taxWorkDocs[i]?.clientName || `Client ${i + 1}`,
      dueDateISO: due.toISOString(),
      offsets: [-7, -3, -1, 0],
      isActive: true,
      firedOffsets: [],
      sentImmediate: false,
      meta: { source: "seed" },
    });
    reminderDocs.push(r);
  }
  console.log(`✅ Inserted Reminders: ${reminderDocs.length}`);

  // ----------------------
  // AUDIT HISTORY (seed as TaskDelayLog)
  // ----------------------
  // This repo doesn't have a dedicated AuditHistory model.
  // The closest "history" feature is TaskDelayLog (delay reasons / history logs).

  // Create a demo task (for linking delay logs)
  const task = await Task.create({
    firmId: firm._id,
    createdBy: user._id,
    assignedTo: user._id,
    clientName: "Demo Audit Client",
    title: "Audit File Review",
    serviceType: "AUDIT",
    dueDateISO: addDays(new Date(), 5).toISOString(),
    status: "NOT_STARTED",
  });

  const delayReasons = [
    { reason: "CLIENT_DELAY", note: "Client not responded; awaiting bank statements" },
    { reason: "DOCUMENTS_PENDING", note: "Invoice copies needed" },
    { reason: "TECHNICAL", note: "Portal downtime / upload failure" },
    { reason: "STAFF_WORKLOAD", note: "Internal workload; rescheduled" },
    { reason: "DOCUMENTS_PENDING", note: "Final ledger confirmation pending" },
    { reason: "CLIENT_DELAY", note: "Signed confirmation pending" },
  ];

  const auditDocs = [];
  for (const d of delayReasons) {
    const log = await TaskDelayLog.create({
      firmId: firm._id,
      taskId: task._id,
      reason: d.reason,
      note: d.note,
      createdBy: user._id,
    });
    auditDocs.push(log);
  }
  console.log(`✅ Inserted Audit History (TaskDelayLog): ${auditDocs.length}`);

  console.log("\n🎉 Done seeding demo data.");
  console.log("User email:", user.email);
  console.log("(Password only if user was newly created): demo12345");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("❌ Seed failed:", e);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
