// retention-ui.js — Accounting Intelligence Snapshot Creator
// SAFE: no chrome APIs, no duplicate globals, backend-aligned

// ---------------- TOKEN ----------------
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// ---------------- RETENTION ----------------
function getRetentionDays() {
  const el = document.getElementById("retention");
  return parseInt(el?.value || "30", 10);
}

// ---------------- QUALITATIVE ACCOUNTING ANALYSIS ----------------
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

// ---------------- CSV PARSER ----------------
async function parseCSV(file) {
  const text = await file.text();
  const rows = text.split("\n").slice(1).filter(Boolean);

  let totalDebit = 0;
  let totalCredit = 0;
  let roundFigureCount = 0;

  rows.forEach((r) => {
    const cols = r.split(",");
    const debit = Number(cols[1] || 0);
    const credit = Number(cols[2] || 0);

    totalDebit += debit;
    totalCredit += credit;

    if (
      (debit !== 0 && debit % 1000 === 0) ||
      (credit !== 0 && credit % 1000 === 0)
    ) {
      roundFigureCount++;
    }
  });

  return {
    totalEntries: rows.length,
    totalDebit,
    totalCredit,
    roundFigureCount,
    lastEntryDate: rows.length
      ? rows[rows.length - 1].split(",")[0]
      : null,
  };
}

// ---------------- CREATE SNAPSHOT ----------------
async function createSnapshot() {
  const token = getToken();
  if (!token) {
    alert("Authentication missing. Please reopen from extension.");
    return;
  }

  const clientName = document.getElementById("clientName")?.value.trim();
  const periodKey = document.getElementById("periodKey")?.value.trim();
  const file = document.getElementById("csvFile")?.files?.[0];

  if (!clientName || !periodKey) {
    alert("Client name and period are required.");
    return;
  }

  let source = "MANUAL";

  // ---------------- MANUAL METRICS (BACKEND SAFE) ----------------
  let metrics = {
    totalEntries: Number(
      document.getElementById("totalEntries")?.value || 0
    ),
    totalDebit: 0,
    totalCredit: 0,
    roundFigureCount: Number(
      document.getElementById("roundFigures")?.value || 0
    ),
    lastEntryDate:
      document.getElementById("lastEntryDate")?.value || null,
  };

  // ---------------- CSV OVERRIDE ----------------
  if (file) {
    const csvMetrics = await parseCSV(file);
    source = "CSV";

    // Convert CSV quantitative metrics to qualitative format
    metrics = {
      totalEntries: csvMetrics.totalEntries <= 50 ? "0-50" : "50+",
      roundFigureLevel: csvMetrics.roundFigureCount / csvMetrics.totalEntries > 0.4
        ? "high"
        : "low",
      monthEndLoad: "low", // CSV doesn't have month-end data, default to low
      maturity: "basic", // CSV assumed basic unless ERP data exists
      // Keep original metrics for backend payload
      totalDebit: csvMetrics.totalDebit,
      totalCredit: csvMetrics.totalCredit,
      roundFigureCount: csvMetrics.roundFigureCount,
      lastEntryDate: csvMetrics.lastEntryDate,
    };
  } else {
    // For manual entries, convert to qualitative format
    metrics = {
      totalEntries: metrics.totalEntries <= 50 ? "0-50" : "50+",
      roundFigureLevel: metrics.roundFigureCount > metrics.totalEntries * 0.4 ? "high" : "low",
      monthEndLoad: "high", // Default assumption for manual entries
      maturity: "basic", // Default assumption for manual entries
      // Keep original metrics for backend payload
      totalDebit: metrics.totalDebit,
      totalCredit: metrics.totalCredit,
      roundFigureCount: metrics.roundFigureCount,
      lastEntryDate: metrics.lastEntryDate,
    };
  }

  // ---------------- INTELLIGENCE (REQUIRED BY BACKEND) ----------------
  // Use analyzeAccounting for both MANUAL and CSV modes
  const intelligence = analyzeAccounting(metrics);

  // ---------------- PAYLOAD ----------------
  const payload = {
    clientName,
    periodKey,
    source,
    metrics, // This now contains both qualitative and quantitative metrics
    intelligence,
    remarks: document.getElementById("remarks")?.value || "",
    retentionDays: getRetentionDays(),
  };

  try {
    const res = await fetch(`${API_BASE_URL}/api/accounting`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Snapshot save failed");
    }

    alert("✅ Accounting snapshot saved successfully");

    if (typeof loadRecords === "function") {
      loadRecords();
    }
  } catch (err) {
    console.error("Snapshot save failed:", err);
    alert("❌ " + err.message);
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("saveSnapshotBtn");
  if (btn) {
    btn.addEventListener("click", createSnapshot);
  }
});