// priority-engine.js (Admin)

export function computePriority(task) {
  const now = new Date();
  const due = task.dueDateISO ? new Date(task.dueDateISO) : null;

  let score = 0;

  if (!due) return { level: 'LOW', score };

  const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));

  // Overdue
  if (diffDays < 0) score += 100;

  // Due today / tomorrow
  if (diffDays === 0) score += 70;
  if (diffDays === 1) score += 50;

  // Service importance
  if (task.serviceType === 'GST') score += 20;
  if (task.serviceType === 'TDS') score += 15;
  if (task.serviceType === 'AUDIT') score += 25;

  // Status risk
  if (task.status === 'WAITING_DOCS') score += 30;
  if (task.status === 'NOT_STARTED') score += 15;

  if (score >= 90) return { level: 'CRITICAL', score };
  if (score >= 60) return { level: 'HIGH', score };
  if (score >= 30) return { level: 'MEDIUM', score };
  return { level: 'LOW', score };
}
