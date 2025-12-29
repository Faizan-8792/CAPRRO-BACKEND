function analyzeAccounting(metrics) {
  let score = 100;
  const flags = [];

  // -------- ENTRY VOLUME --------
  if (metrics.totalEntries === "0-50") {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  // -------- ROUND FIGURE PATTERN --------
  if (metrics.roundFigureLevel === "high") {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  // -------- MONTH END RUSH --------
  if (metrics.monthEndLoad === "high") {
    flags.push("MONTH_END_DUMPING");
    score -= 15;
  }

  // -------- ACCOUNTING MATURITY --------
  if (metrics.maturity === "basic") {
    flags.push("WEAK_ACCOUNTING_PRACTICE");
    score -= 20;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: Math.max(score, 0),
    flags,
    summaryNotes: flags.length
      ? flags.join(", ")
      : "Accounting appears stable",
  };
}
