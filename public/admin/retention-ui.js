// retention-ui.js — Accounting Intelligence Snapshot Creator
// ✅ Firm-aware
// ✅ Uses latest token from chrome.storage
// ✅ No API_BASE_URL redeclaration

// ---------------- TOKEN (FIXED) ----------------
async function getToken() {
  const { caproAuth } = await chrome.storage.local.get("caproAuth");
  return caproAuth?.token || null;
}

// ---------------- RETENTION ----------------
function getRetentionDays() {
  const el = document.getElementById("retention");
  return parseInt(el?.value || "30", 10);
}

// ---------------- CSV PARSER ----------------
async function parseCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const rows = reader.result.split("\n").filter(Boolean);
        let totalDebit = 0;
        let totalCredit = 0;

        for (let i = 1; i < rows.length; i++) {
          const [, debit, credit] = rows[i].split(",");
          totalDebit += Number(debit || 0);
          totalCredit += Number(credit || 0);
        }

        resolve({
          totalEntries: rows.length - 1,
          totalDebit,
          totalCredit,
        });
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ---------------- INTELLIGENCE ENGINE ----------------
function analyzeAccounting(metrics) {
  let score = 100;
  const flags = [];

  if (metrics.totalEntries < 5) {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  if (Math.abs(metrics.totalDebit - metrics.totalCredit) > 1) {
    flags.push("IMBALANCE");
    score -= 40;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: Math.max(score, 0),
    flags,
  };
}

// ---------------- CREATE SNAPSHOT ----------------
async function createSnapshot() {
  const token = await getToken();
  if (!token) {
    alert("Authentication missing. Please login again.");
    return;
  }

  const clientName = document.getElementById("clientName")?.value.trim();
  const periodKey = document.getElementById("periodKey")?.value.trim();
  const file = document.getElementById("csvFile")?.files?.[0];

  if (!clientName || !periodKey) {
    alert("Client name and period are required.");
    return;
  }

  let metrics = {
    totalEntries: 0,
    totalDebit: 0,
    totalCredit: 0,
  };

  let source = "MANUAL";

  if (file) {
    metrics = await parseCSV(file);
    source = "CSV";
  }

  const intelligence = analyzeAccounting(metrics);

  const payload = {
    clientName,
    periodKey,
    source,
    metrics,
    intelligence,
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

    if (!res.ok || !data.ok) {
      throw new Error(data?.error || "Failed to save accounting snapshot");
    }

    alert("✅ Accounting snapshot saved");

    if (typeof loadRecords === "function") {
      loadRecords();
    }
  } catch (err) {
    console.error("Snapshot error:", err);
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
