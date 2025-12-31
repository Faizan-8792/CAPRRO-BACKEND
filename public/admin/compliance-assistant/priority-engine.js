// priority-engine.js (Admin) — DATE BASED PRIORITY ONLY

export function computePriority(task) {
  if (!task?.dueDateISO) {
    return { level: 'LOW' };
  }

  const now = new Date();
  const due = new Date(task.dueDateISO);

  // difference in days
  const diffMs = due - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  // 🔴 Overdue
  if (diffDays < 0) {
    return { level: 'CRITICAL' };
  }

  // 🔴 Due within 7 days
  if (diffDays <= 7) {
    return { level: 'CRITICAL' };
  }

  // 🟠 Due in 8–30 days
  if (diffDays <= 30) {
    return { level: 'HIGH' };
  }

  // 🟡 Due in 31–120 days (~4 months)
  if (diffDays <= 120) {
    return { level: 'MEDIUM' };
  }

  // 🟢 More than 4 months away
  return { level: 'LOW' };
}
