import CaseMatter from "../models/CaseMatter.js";
import Client from "../models/Client.js";
import Reminder from "../models/Reminder.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { hashText, httpError, normalizeOffsets } from "./case-validation.service.js";

const INACTIVE_CASE_STATUSES = new Set(["SUBMITTED", "CLOSED", "ARCHIVED"]);
const MAX_RECONCILIATION_ATTEMPTS = 3;

function hasConfirmedResponseDueDate(caseMatter) {
  return Boolean(
    caseMatter?.confirmedFacts?.responseDueDate &&
    caseMatter?.confirmationEvidence?.some((item) => item.field === "responseDueDate")
  );
}

function projectionKeys(caseId) {
  return {
    task: `case:${caseId}:response-task`,
    reminder: `case:${caseId}:response-reminder`,
  };
}

function projectionRevisionFilter(revision) {
  return {
    $or: [
      { "meta.caseRevision": { $exists: false } },
      { "meta.caseRevision": { $lt: revision } },
    ],
  };
}

function documentProjectionRevision(document) {
  const revision = Number(document?.meta?.caseRevision);
  return Number.isSafeInteger(revision) ? revision : 0;
}

function serviceTypeForCase(caseType) {
  if (String(caseType).startsWith("GST_")) return "GST";
  if (String(caseType).startsWith("ROC_")) return "ROC";
  return "ITR";
}

async function createTaskIfMissing({ caseMatter, client, owner, actorUserId, dueDateISO, title, generationKey }) {
  let task = await Task.findOne({ firmId: caseMatter.firmId, generationKey });
  if (task) return task;
  try {
    return await Task.create({
      firmId: caseMatter.firmId,
      createdBy: actorUserId,
      clientName: client.name,
      serviceType: serviceTypeForCase(caseMatter.caseType),
      title,
      dueDateISO,
      assignedTo: owner._id,
      status: "NOT_STARTED",
      source: "CASE",
      clientId: client._id,
      caseId: caseMatter._id,
      isActive: true,
      generationKey,
      meta: {
        caseRevision: caseMatter.revision,
        caseStatus: caseMatter.status,
        casePriority: caseMatter.priority,
        caseTitle: caseMatter.title,
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    task = await Task.findOne({ firmId: caseMatter.firmId, generationKey });
    if (!task) throw error;
    return task;
  }
}

async function reconcileTask({ caseMatter, client, owner, actorUserId, dueDateISO, title, generationKey }) {
  let task = await createTaskIfMissing({
    caseMatter,
    client,
    owner,
    actorUserId,
    dueDateISO,
    title,
    generationKey,
  });
  const currentRevision = documentProjectionRevision(task);
  if (currentRevision > caseMatter.revision) return { task, stale: true };
  if (currentRevision === caseMatter.revision) return { task, stale: false };

  task = await Task.findOneAndUpdate(
    {
      _id: task._id,
      firmId: caseMatter.firmId,
      ...projectionRevisionFilter(caseMatter.revision),
    },
    {
      $set: {
        clientName: client.name,
        serviceType: serviceTypeForCase(caseMatter.caseType),
        title,
        dueDateISO,
        assignedTo: owner._id,
        source: "CASE",
        clientId: client._id,
        caseId: caseMatter._id,
        isActive: true,
        "meta.caseRevision": caseMatter.revision,
        "meta.caseStatus": caseMatter.status,
        "meta.casePriority": caseMatter.priority,
        "meta.caseTitle": caseMatter.title,
      },
    },
    { new: true, runValidators: true }
  );
  if (task) return { task, stale: false };
  task = await Task.findOne({ firmId: caseMatter.firmId, generationKey });
  return { task, stale: documentProjectionRevision(task) > caseMatter.revision };
}

async function createReminderIfMissing({
  caseMatter,
  client,
  owner,
  task,
  dueDateISO,
  offsets,
  scheduleSignature,
  generationKey,
}) {
  let reminder = await Reminder.findOne({ firmId: caseMatter.firmId, generationKey });
  if (reminder) return { reminder, created: false };
  try {
    reminder = await Reminder.create({
      userId: owner._id,
      firmId: caseMatter.firmId,
      typeId: "CASE_RESPONSE_DUE",
      clientLabel: client.name,
      dueDateISO,
      offsets,
      isActive: true,
      source: "CASE",
      clientId: client._id,
      taskId: task._id,
      caseId: caseMatter._id,
      generationKey,
      meta: {
        caseId: String(caseMatter._id),
        caseTitle: caseMatter.title,
        caseStatus: caseMatter.status,
        casePriority: caseMatter.priority,
        caseRevision: caseMatter.revision,
        caseScheduleSignature: scheduleSignature,
        caseProjectionActive: true,
        confirmedDateOnly: true,
      },
    });
    return { reminder, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    reminder = await Reminder.findOne({ firmId: caseMatter.firmId, generationKey });
    if (!reminder) throw error;
    return { reminder, created: false };
  }
}

async function reconcileReminder({
  caseMatter,
  client,
  owner,
  task,
  dueDateISO,
  offsets,
  scheduleSignature,
  generationKey,
}) {
  let { reminder, created } = await createReminderIfMissing({
    caseMatter,
    client,
    owner,
    task,
    dueDateISO,
    offsets,
    scheduleSignature,
    generationKey,
  });
  const currentRevision = documentProjectionRevision(reminder);
  if (currentRevision > caseMatter.revision) {
    return { reminder, scheduleChanged: false, stale: true };
  }
  if (created || currentRevision === caseMatter.revision) {
    return { reminder, scheduleChanged: created, stale: false };
  }

  const normalizedCurrentOffsets = [...(reminder.offsets || [])].sort((a, b) => a - b);
  const scheduleChanged =
    reminder.meta?.caseScheduleSignature !== scheduleSignature ||
    reminder.meta?.caseProjectionActive !== true ||
    reminder.dueDateISO !== dueDateISO ||
    String(reminder.userId) !== String(owner._id) ||
    JSON.stringify(normalizedCurrentOffsets) !== JSON.stringify(offsets);
  const update = {
    $set: {
      userId: owner._id,
      typeId: "CASE_RESPONSE_DUE",
      clientLabel: client.name,
      dueDateISO,
      offsets,
      isActive: true,
      source: "CASE",
      clientId: client._id,
      taskId: task._id,
      caseId: caseMatter._id,
      "meta.caseId": String(caseMatter._id),
      "meta.caseTitle": caseMatter.title,
      "meta.caseStatus": caseMatter.status,
      "meta.casePriority": caseMatter.priority,
      "meta.caseRevision": caseMatter.revision,
      "meta.caseScheduleSignature": scheduleSignature,
      "meta.caseProjectionActive": true,
      "meta.confirmedDateOnly": true,
    },
  };
  if (scheduleChanged) {
    update.$inc = { scheduleVersion: 1 };
    Object.assign(update.$set, {
      firedOffsets: [],
      sentImmediate: false,
      sentAt: null,
    });
  }
  reminder = await Reminder.findOneAndUpdate(
    {
      _id: reminder._id,
      firmId: caseMatter.firmId,
      ...projectionRevisionFilter(caseMatter.revision),
    },
    update,
    { new: true, runValidators: true }
  );
  if (reminder) return { reminder, scheduleChanged, stale: false };
  reminder = await Reminder.findOne({ firmId: caseMatter.firmId, generationKey });
  return {
    reminder,
    scheduleChanged: false,
    stale: documentProjectionRevision(reminder) > caseMatter.revision,
  };
}

async function deactivateDeadlineArtifacts(caseMatter) {
  const keys = projectionKeys(caseMatter._id);
  const projectionMetadata = {
    "meta.caseRevision": caseMatter.revision,
    "meta.caseStatus": caseMatter.status,
    "meta.casePriority": caseMatter.priority,
    "meta.caseTitle": caseMatter.title,
  };
  const [task, reminder] = await Promise.all([
    Task.findOneAndUpdate(
      {
        firmId: caseMatter.firmId,
        generationKey: keys.task,
        ...projectionRevisionFilter(caseMatter.revision),
      },
      { $set: { isActive: false, ...projectionMetadata } },
      { new: true, runValidators: true }
    ),
    Reminder.findOneAndUpdate(
      {
        firmId: caseMatter.firmId,
        generationKey: keys.reminder,
        ...projectionRevisionFilter(caseMatter.revision),
      },
      {
        $set: {
          isActive: false,
          ...projectionMetadata,
          "meta.caseId": String(caseMatter._id),
          "meta.caseProjectionActive": false,
        },
      },
      { new: true, runValidators: true }
    ),
  ]);
  return {
    task,
    reminder,
    active: false,
    deactivated: Boolean(task || reminder),
    scheduleChanged: false,
    stale: false,
  };
}

async function reconcileActiveDeadlineArtifacts(caseMatter, actorUserId) {
  const [client, owner] = await Promise.all([
    Client.findOne({
      _id: caseMatter.clientId,
      firmId: caseMatter.firmId,
      isActive: true,
    })
      .select("_id name")
      .lean(),
    User.findOne({
      _id: caseMatter.ownerUserId || actorUserId,
      firmId: caseMatter.firmId,
      isActive: { $ne: false },
    })
      .select("_id")
      .lean(),
  ]);
  if (!client) throw httpError(409, "Case client is unavailable in the active firm");
  if (!owner) throw httpError(409, "Case owner is unavailable in the active firm");

  const dueDateISO = new Date(caseMatter.confirmedFacts.responseDueDate).toISOString();
  const offsets = normalizeOffsets(caseMatter.reminderOffsets);
  const keys = projectionKeys(caseMatter._id);
  const title = `Respond to ${caseMatter.title}`.slice(0, 500);
  const taskResult = await reconcileTask({
    caseMatter,
    client,
    owner,
    actorUserId,
    dueDateISO,
    title,
    generationKey: keys.task,
  });
  if (!taskResult.task || taskResult.stale) {
    return { ...taskResult, reminder: null, active: true, stale: true };
  }

  const scheduleSignature = hashText(`${dueDateISO}|${offsets.join(",")}|${owner._id}`);
  const reminderResult = await reconcileReminder({
    caseMatter,
    client,
    owner,
    task: taskResult.task,
    dueDateISO,
    offsets,
    scheduleSignature,
    generationKey: keys.reminder,
  });
  if (!reminderResult.reminder || reminderResult.stale) {
    return {
      task: taskResult.task,
      reminder: reminderResult.reminder,
      active: true,
      scheduleChanged: false,
      stale: true,
    };
  }
  if (String(taskResult.task.reminderId || "") !== String(reminderResult.reminder._id)) {
    await Task.updateOne(
      {
        _id: taskResult.task._id,
        firmId: caseMatter.firmId,
        "meta.caseRevision": caseMatter.revision,
      },
      { $set: { reminderId: reminderResult.reminder._id } }
    );
    taskResult.task.reminderId = reminderResult.reminder._id;
  }
  return {
    task: taskResult.task,
    reminder: reminderResult.reminder,
    active: true,
    deactivated: false,
    scheduleChanged: reminderResult.scheduleChanged,
    stale: false,
  };
}

async function applyCaseDeadlineSnapshot(caseMatter, actorUserId) {
  const active =
    hasConfirmedResponseDueDate(caseMatter) && !INACTIVE_CASE_STATUSES.has(caseMatter.status);
  const result = active
    ? await reconcileActiveDeadlineArtifacts(caseMatter, actorUserId)
    : await deactivateDeadlineArtifacts(caseMatter);
  if (result.stale) return result;

  const linkUpdate = await CaseMatter.updateOne(
    {
      _id: caseMatter._id,
      firmId: caseMatter.firmId,
      revision: caseMatter.revision,
    },
    {
      $set: {
        deadlineTaskId: result.task?._id || caseMatter.deadlineTaskId || null,
        deadlineReminderId: result.reminder?._id || caseMatter.deadlineReminderId || null,
      },
    }
  );
  return { ...result, stale: linkUpdate.matchedCount !== 1 };
}

async function syncCaseDeadlineArtifacts({ caseMatter, actorUserId }) {
  const caseId = caseMatter?._id;
  const firmId = caseMatter?.firmId;
  if (!caseId || !firmId) throw httpError(400, "Case identity is required for deadline synchronization");

  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const current = await CaseMatter.findOne({ _id: caseId, firmId });
    if (!current) throw httpError(404, "Case not found", "CASE_NOT_FOUND");
    const result = await applyCaseDeadlineSnapshot(current, actorUserId);
    const latest = await CaseMatter.findOne({ _id: caseId, firmId }).select("revision").lean();
    if (!result.stale && latest?.revision === current.revision) {
      if (caseMatter?.set) {
        caseMatter.set("deadlineTaskId", result.task?._id || current.deadlineTaskId || null);
        caseMatter.set("deadlineReminderId", result.reminder?._id || current.deadlineReminderId || null);
        caseMatter.set("reminderOffsets", current.reminderOffsets);
      }
      return { ...result, caseRevision: current.revision };
    }
  }
  throw httpError(
    409,
    "Case changed while deadline artifacts were being synchronized; retry the request",
    "CASE_DEADLINE_RECONCILIATION_CONFLICT"
  );
}

export { hasConfirmedResponseDueDate, syncCaseDeadlineArtifacts };
