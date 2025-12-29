// retention-ui.js — Accounting Intelligence Snapshot Creator
// FIXED: stable metrics, CSV scoring works, backend-safe

// ---------------- TOKEN ----------------
function getToken() {
  return new URLSearchParams(window.location.search).get("token");
}

// ---------------- RETENTION ----------------
function getRetentionDays() {
  const el = document.getElementById("retention");
  return parseInt(el?.value || "30", 10);
}

// ---------------- QUALITATIVE ENGINE ----------------
function analyzeAccounting(q) {
  let score = 100;
  let flags = [];

  if (q.totalEntries === "0-50") {
    flags.push("LOW_ACTIVITY");
    score -= 20;
  }

  if (q.roundFigureLevel === "HIGH") {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  if (q.monthEndLoad === "HIGH") {
    flags.push("YEAR_END_PRESSURE");
    score -= 25;
  }

  if (q.maturity === "BASIC") {
    flags.push("LOW_MATURITY");
    score -= 15;
  }

  let health = "GREEN";
  if (score < 70) health = "AMBER";
  if (score < 40) health = "RED";

  return {
    health,
    readinessScore: score,
    riskFlags: flags,
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
  let monthEndCount = 0;

  rows.forEach((r) => {
    const [date, , , debit, credit] = r.split(",");
    const d = Number(debit || 0);
    const c = Number(credit || 0);

    totalDebit += d;
    totalCredit += c;

    if ((d && d % 1000 === 0) || (c && c % 1000 === 0)) {
      roundFigureCount++;
    }

    if (date?.endsWith("-28") || date?.endsWith("-29") || date?.endsWith("-30") || date?.endsWith("-31")) {
      monthEndCount++;
    }
  });

  return {
    totalEntries: rows.length,
    totalDebit,
    totalCredit,
    roundFigureCount,
    monthEndRatio: rows.length ? monthEndCount / rows.length : 0,
    lastEntryDate: rows.length ? rows[rows.length - 1].split(",")[0] : null,
  };
}

// ---------------- CLEAR FORM FUNCTION ----------------
function clearFormFields() {
  // Clear all form fields except retention
  document.getElementById("clientName").value = "";
  document.getElementById("periodKey").value = "";
  document.getElementById("totalEntries").selectedIndex = 0;
  document.getElementById("roundFigures").selectedIndex = 0;
  document.getElementById("monthEnd").selectedIndex = 0;
  document.getElementById("lastEntryDate").value = "";
  document.getElementById("maturity").selectedIndex = 0;
  document.getElementById("remarks").value = "";
  
  // Clear CSV file input and hide remove button
  const csvFileInput = document.getElementById("csvFile");
  csvFileInput.value = "";
  document.getElementById("removeCsvBtn").style.display = "none";
  
  // Retention field remains unchanged as per requirement
}

// ---------------- REMOVE CSV FUNCTION ----------------
function removeCSV() {
  const csvFileInput = document.getElementById("csvFile");
  csvFileInput.value = "";
  document.getElementById("removeCsvBtn").style.display = "none";
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
  let rawMetrics = {};
  let qualitativeMetrics = {};

  // ---------------- CSV MODE ----------------
  if (file) {
    source = "CSV";
    const csv = await parseCSV(file);

    rawMetrics = csv;

    qualitativeMetrics = {
      totalEntries: csv.totalEntries <= 50 ? "0-50" : "50+",
      roundFigureLevel:
        csv.roundFigureCount / csv.totalEntries > 0.4 ? "HIGH" : "LOW",
      monthEndLoad: csv.monthEndRatio > 0.4 ? "HIGH" : "LOW",
      maturity: "BASIC",
    };
  }

  // ---------------- MANUAL MODE ----------------
  else {
    rawMetrics = {
      totalEntries: Number(document.getElementById("totalEntries")?.value || 0),
      roundFigureCount: 0,
      totalDebit: 0,
      totalCredit: 0,
      lastEntryDate: document.getElementById("lastEntryDate")?.value || null,
    };

    qualitativeMetrics = {
      totalEntries:
        rawMetrics.totalEntries <= 50 ? "0-50" : "50+",
      roundFigureLevel:
        document.getElementById("roundFigures")?.value === "many"
          ? "HIGH"
          : "LOW",
      monthEndLoad:
        document.getElementById("monthEnd")?.value === ">50"
          ? "HIGH"
          : "LOW",
      maturity:
        document.getElementById("maturity")?.value === "basic"
          ? "BASIC"
          : "ADVANCED",
    };
  }

  const intelligence = analyzeAccounting(qualitativeMetrics);

  const payload = {
    clientName,
    periodKey,
    source,
    metrics: rawMetrics,
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
      throw new Error(data?.error || "Failed to create record");
    }

    alert("✅ Accounting snapshot saved");
    
    // Clear form fields after successful submission
    clearFormFields();
    
    if (typeof loadRecords === "function") loadRecords();
  } catch (err) {
    console.error("Snapshot save failed:", err);
    alert("❌ " + err.message);
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  const saveBtn = document.getElementById("saveSnapshotBtn");
  const csvFileInput = document.getElementById("csvFile");
  const removeCsvBtn = document.getElementById("removeCsvBtn");
  
  if (saveBtn) {
    saveBtn.addEventListener("click", createSnapshot);
  }
  
  if (csvFileInput && removeCsvBtn) {
    // Show remove button when file is selected
    csvFileInput.addEventListener("change", () => {
      if (csvFileInput.files.length > 0) {
        removeCsvBtn.style.display = "inline-flex";
      } else {
        removeCsvBtn.style.display = "none";
      }
    });
    
    // Remove CSV when button is clicked
    removeCsvBtn.addEventListener("click", removeCSV);
  }
});