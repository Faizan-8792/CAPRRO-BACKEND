function analyzeAccounting(metrics) {
  let score = 100;
  let flags = [];

  const totalEntries = Number(metrics.totalEntries || 0);
  const roundFigureCount = Number(metrics.roundFigureCount || 0);

  if (totalEntries > 0 && roundFigureCount > totalEntries * 0.4) {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  if (totalEntries < 10) {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: Math.max(score, 0),
    flags, // ✅ BACKEND EXPECTS THIS KEY
    summaryNotes: flags.length
      ? flags.join(", ")
      : "No major risk detected",
  };
}
