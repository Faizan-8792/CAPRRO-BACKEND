// retention-ui.js — Accounting Intelligence Snapshot Creator
// SAFE: no chrome APIs, no duplicate globals

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

  rows.forEach(r => {
    const [, debit, credit] = r.split(",");
    const d = Number(debit || 0);
    const c = Number(credit || 0);

    totalDebit += d;
    totalCredit += c;

    if (d % 1000 === 0 || c % 1000 === 0) {
      roundFigureCount++;
    }
  });

  return {
    totalEntries: rows.length,
    totalDebit,
    totalCredit,
    roundFigureCount,
    lastEntryDate: rows[rows.length - 1]?.split(",")[0] || null,
  };
}

// ---------------- CREATE SNAPSHOT ----------------
async function createSnapshot() {
  const token = getToken();
  if (!token) return;

  const clientName = document.getElementById("clientName")?.value.trim();
  const periodKey = document.getElementById("periodKey")?.value.trim();
  const file = document.getElementById("csvFile")?.files?.[0];

  if (!clientName || !periodKey) return;

  // 🔹 NEW MANUAL METRICS
  let metrics = {
    totalEntries: document.getElementById("totalEntries")?.value || null,
    roundFigureLevel: document.getElementById("roundFigures")?.value || null,
    monthEndLoad: document.getElementById("monthEnd")?.value || null,
    lastEntryDate: document.getElementById("lastEntryDate")?.value || null,
    maturity: document.getElementById("maturity")?.value || null,
  };

  let source = "MANUAL";

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
    if (!res.ok || !data.ok) throw new Error(data?.error);

    if (typeof loadRecords === "function") loadRecords();
  } catch (err) {
    console.error("Snapshot save failed:", err);
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("saveSnapshotBtn")
    ?.addEventListener("click", createSnapshot);
});
