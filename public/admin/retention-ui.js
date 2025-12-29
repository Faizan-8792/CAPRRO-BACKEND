// retention-ui.js — Accounting Intelligence Snapshot Creator
// ✅ Fully aligned with backend AccountingRecord schema



// ---------------- TOKEN ----------------
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// ---------------- RETENTION ----------------
// Backend expects retentionDays (NUMBER)
function getRetentionDays() {
  const el = document.getElementById("retention");
  if (!el) return 30;
  return parseInt(el.value, 10) || 30;
}

// ---------------- CSV PARSER (BASIC) ----------------
async function parseCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lines = reader.result.split("\n").filter(Boolean);
        let debit = 0;
        let credit = 0;

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          debit += Number(cols[1] || 0);
          credit += Number(cols[2] || 0);
        }

        resolve({
          entryCount: lines.length - 1,
          totalDebit: debit,
          totalCredit: credit,
        });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ---------------- INTELLIGENCE ENGINE ----------------
// MUST return { health, readinessScore, flags }
function analyzeAccounting(metrics) {
  const flags = [];
  let score = 100;

  if (metrics.entryCount < 5) {
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
    readinessScore: score,
    flags,
  };
}

// ---------------- CREATE SNAPSHOT ----------------
async function createSnapshot() {
  const token = getToken();
  if (!token) {
    alert("Authentication missing. Please reopen from extension.");
    return;
  }

  const clientName = document.getElementById("clientName").value.trim();
  const periodKey = document.getElementById("periodKey").value.trim();
  const file = document.getElementById("csvFile").files[0];

  if (!clientName || !periodKey) {
    alert("Client name and period are required.");
    return;
  }

  let metrics = {
    entryCount: 0,
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
      throw new Error(data?.error || "Failed to save snapshot");
    }

    alert("✅ Accounting snapshot saved");

    if (typeof loadRecords === "function") {
      loadRecords();
    }
  } catch (err) {
    console.error(err);
    alert("❌ " + err.message);
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("saveSnapshotBtn");
  if (btn) btn.addEventListener("click", createSnapshot);
});
