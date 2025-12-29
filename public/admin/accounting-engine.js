function analyzeAccounting(metrics) {
  let score = 100;
  let flags = [];

  if (metrics.roundFigureCount > metrics.totalEntries * 0.4) {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  if (metrics.totalEntries < 10) {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: score,
    riskFlags: flags,
    summaryNotes: flags.join(", ") || "No major risk detected",
  };
}
