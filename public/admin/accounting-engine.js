// accounting-engine.js
// Qualitative scoring for MANUAL snapshots

function analyzeAccounting(metrics) {
  let score = 100;
  let flags = [];

  // LOW ACTIVITY
  if (metrics.totalEntries === "0-50") {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  // ROUND FIGURE OVERUSE
  if (metrics.roundFigureLevel === "high") {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  // MONTH END PRESSURE
  if (metrics.monthEndLoad === "high") {
    flags.push("YEAR_END_PRESSURE");
    score -= 25;
  }

  // ACCOUNTING MATURITY
  if (metrics.maturity === "basic") {
    flags.push("LOW_MATURITY");
    score -= 15;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: score,
    flags,
    summaryNotes: flags.length
      ? flags.join(", ")
      : "No major risk detected",
  };
}

// 🔑 expose to window so retention-ui.js can use it
window.analyzeAccounting = analyzeAccounting;
