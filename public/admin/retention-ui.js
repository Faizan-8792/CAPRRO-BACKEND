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
    console.warn("Auth token missing");
    return;
  }

  const clientName = document.getElementById("clientName")?.value.trim();
  const periodKey = document.getElementById("periodKey")?.value.trim();
  const file = document.getElementById("csvFile")?.files?.[0];

  if (!clientName || !periodKey) {
    console.warn("Client name or period missing");
    return;
  }

  let source = "MANUAL";

  // ---------------- MANUAL METRICS (SAFE DEFAULTS) ----------------
  let metrics = {
    totalEntries:
      document.getElementById("totalEntries")?.value || null,
    roundFigureLevel:
      document.getElementById("roundFigures")?.value || null,
    monthEndLoad:
      document.getElementById("monthEnd")?.value || null,
    lastEntryDate:
      document.getElementById("lastEntryDate")?.value || null,
    maturity:
      document.getElementById("maturity")?.value || null,

    // backend-consistency placeholders
    totalDebit: null,
    totalCredit: null,
    roundFigureCount: null,
  };

  // ---------------- CSV MODE OVERRIDE ----------------
  if (file) {
    metrics = await parseCSV(file);
    source = "CSV";
  }

  const payload = {
    clientName,
    periodKey,
    source,
    metrics,
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

    // Refresh list safely
    if (typeof loadRecords === "function") {
      loadRecords();
    }
  } catch (err) {
    console.error("Snapshot save failed:", err);
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("saveSnapshotBtn");
  if (btn) {
    btn.addEventListener("click", createSnapshot);
  }
});
