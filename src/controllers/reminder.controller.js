// src/controllers/reminder.controller.js

import Reminder from "../models/Reminder.js";
import User from "../models/User.js";
import { sendComplianceReminderEmail } from "../services/reminder.service.js";
import { sendReminderEmail } from "../config/email.js";

// ---- CREATE REMINDER ----

export async function createReminder(req, res) {
  try {
    const { typeId, clientLabel, dueDateISO, offsets, meta = {} } = req.body;
    const userId = req.user.id;

    // Free vs Premium offsets logic
    const user = await User.findById(userId).lean();

    let finalOffsets =
      offsets ||
      (user?.plan === "PREMIUM" ? [-7, -3, -1, 0] : [-1, 0]);

    // Normalize due date and compute daysLeft
    const dueDate = new Date(dueDateISO);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const oneDayMs = 1000 * 60 * 60 * 24;
    const daysLeft = Math.floor((dueDate - today) / oneDayMs);

    const reminder = new Reminder({
      userId,
      firmId: user?.firmId,
      typeId,
      clientLabel,
      dueDateISO: dueDate.toISOString(),
      offsets: finalOffsets,
      meta: { source: meta.source || "web", ...meta },
      isActive: true,
      sentImmediate: false,
    });

    // Save first so we have _id
    await reminder.save();

    // If due date is within next 0–2 days, send immediate email once
    if (daysLeft >= 0 && daysLeft <= 2) {
      try {
        await sendComplianceReminderEmail({
          toEmail: user?.email,
          title: typeId,
          clientLabel,
          dueDateISO: reminder.dueDateISO,
          daysLeft,
        });

        reminder.sentImmediate = true;
        await reminder.save();

        console.log(
          `[REMINDER] Immediate email sent for ${reminder._id} (daysLeft=${daysLeft})`
        );
      } catch (e) {
        console.error(
          `[REMINDER] Failed to send immediate email for ${reminder._id}:`,
          e
        );
      }
    }

    res.json({ ok: true, reminder });
  } catch (err) {
    console.error("Create reminder error:", err);
    res.status(500).json({ error: "Failed to create reminder" });
  }
}

// ---- LIST REMINDERS ----

export async function listReminders(req, res) {
  try {
    const userId = req.user.id;

    const reminders = await Reminder.find({
      $or: [{ userId }, { firmId: req.user.firmId }],
    })
      .sort({ dueDateISO: 1 })
      .limit(100);

    res.json({ ok: true, reminders });
  } catch (err) {
    console.error("List reminders error:", err);
    res.status(500).json({ error: "Failed to list reminders" });
  }
}

// ---- KAL DUE REMINDERS (UI ke liye) ----

export async function getTodayReminders(req, res) {
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const nextDayEnd = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);

    const reminders = await Reminder.find({
      // Kal due reminders (offset -1)
      dueDateISO: {
        $gte: tomorrow.toISOString(),
        $lt: nextDayEnd.toISOString(),
      },
      isActive: true,
      $or: [{ userId: req.user.id }, { firmId: req.user.firmId }],
    })
      .sort({ dueDateISO: 1 })
      .limit(50);

    res.json({
      ok: true,
      reminders: reminders.map((r) => ({
        id: r._id,
        typeId: r.typeId,
        clientLabel: r.clientLabel,
        dueDateISO: r.dueDateISO,
        status: r.firedOffsets?.includes(-1) ? "📧 Sent" : "⏳ Pending",
      })),
    });
  } catch (err) {
    console.error("Get today reminders error:", err);
    res.status(500).json({ error: "Failed to fetch reminders" });
  }
}

// ---- UPDATE REMINDER ----

export async function updateReminder(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;

    const reminder = await Reminder.findOneAndUpdate(
      { _id: id, $or: [{ userId: req.user.id }, { firmId: req.user.firmId }] },
      updates,
      { new: true }
    );

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    res.json({ ok: true, reminder });
  } catch (err) {
    console.error("Update reminder error:", err);
    res.status(500).json({ error: "Failed to update reminder" });
  }
}

// ---- SCHEDULER PROCESSING ----

export async function processReminderForNow(reminderDoc, nowUtc) {
  const dueDate = new Date(reminderDoc.dueDateISO);
  const today = new Date(nowUtc);
  today.setHours(0, 0, 0, 0);

  const oneDayMs = 1000 * 60 * 60 * 24;
  const dayDiff = Math.floor((dueDate - today) / oneDayMs);

  const shouldSend = reminderDoc.offsets.includes(dayDiff);

  if (!shouldSend || reminderDoc.firedOffsets?.includes(dayDiff)) {
    return; // No action needed
  }

  try {
    // Mark as sent for this offset
    reminderDoc.firedOffsets = [
      ...(reminderDoc.firedOffsets || []),
      dayDiff,
    ];
    reminderDoc.sentAt = new Date();
    await reminderDoc.save();

    // Send basic reminder email
    const user = await User.findById(reminderDoc.userId);

    const subject = `Reminder: ${reminderDoc.typeId} for ${reminderDoc.clientLabel}`;
    const text = `Dear ${user?.name || "User"},\n\nReminder: ${
      reminderDoc.clientLabel || "Client"
    }\nTask: ${
      reminderDoc.typeId
    }\nDue: ${dueDate.toLocaleDateString(
      "en-IN"
    )}\n\nPlease complete this compliance task.\n\nCA PRO Toolkit`;

    await sendReminderEmail(user?.email, subject, text);

    console.log(
      `[REMINDER] Email sent for ${reminderDoc._id} (offset: ${dayDiff})`
    );
  } catch (err) {
    console.error(`[REMINDER] Failed to process ${reminderDoc._id}:`, err);
  }
}
