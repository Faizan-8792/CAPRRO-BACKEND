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
    metrics = await parseCSV(file);
    source = "CSV";
  }

  // ---------------- INTELLIGENCE (REQUIRED BY BACKEND) ----------------
  let readinessScore = 100;
  const flags = [];

  if (metrics.totalEntries < 10) {
    flags.push("LOW_ACTIVITY");
    readinessScore -= 20;
  }

  if (Math.abs(metrics.totalDebit - metrics.totalCredit) > 1) {
    flags.push("DEBIT_CREDIT_MISMATCH");
    readinessScore -= 40;
  }

  if (metrics.roundFigureCount > metrics.totalEntries * 0.4) {
    flags.push("ROUND_FIGURE_OVERUSE");
    readinessScore -= 20;
  }

  let health = "GREEN";
  if (readinessScore < 70) health = "AMBER";
  if (readinessScore < 40) health = "RED";

  const intelligence = {
    health,
    readinessScore,
    flags,
  };

  // ---------------- PAYLOAD ----------------
  const payload = {
    clientName,
    periodKey,
    source,
    metrics,
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
