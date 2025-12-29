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

// ---------------- CSV COLUMN KEYWORDS ----------------
const CSV_COLUMN_KEYWORDS = {
  date: ["date", "txn date", "transaction date", "entry date", "voucher date"],
  debit: ["debit", "dr", "withdrawal", "expense", "paid", "outflow"],
  credit: ["credit", "cr", "deposit", "receipt", "income", "inflow"]
};

// ---------------- CSV PARSER ----------------
async function parseCSV(file) {
  const text = await file.text();
  const rows = text.split("\n").filter(Boolean);
  
  if (rows.length < 2) {
    return {
      totalEntries: 0,
      totalDebit: 0,
      totalCredit: 0,
      roundFigureCount: 0,
      monthEndRatio: 0,
      lastEntryDate: null,
      csvExtractionMeta: {
        totalColumns: 0,
        extractedColumns: {
          date: null,
          debit: null,
          credit: null
        },
        ignoredColumns: [],
        extractionConfidence: "LOW"
      }
    };
  }

  // Read header row
  const headers = rows[0].split(",").map(h => h.trim().toLowerCase());
  const totalColumns = headers.length;
  const headerNames = headers;

  // Detect column indexes
  const detectedColumns = {};

  headers.forEach((header, index) => {
    Object.entries(CSV_COLUMN_KEYWORDS).forEach(([type, keywords]) => {
      if (!detectedColumns[type]) {
        if (keywords.some(k => header.includes(k))) {
          detectedColumns[type] = { 
            header: headerNames[index], 
            index 
          };
        }
      }
    });
  });

  // Process data rows
  const dataRows = rows.slice(1);
  let totalDebit = 0;
  let totalCredit = 0;
  let roundFigureCount = 0;
  let monthEndCount = 0;

  dataRows.forEach((row) => {
    const columns = row.split(",");
    const cols = detectedColumns;

    const date = cols.date ? columns[cols.date.index] : null;
    const debit = cols.debit ? Number(columns[cols.debit.index] || 0) : 0;
    const credit = cols.credit ? Number(columns[cols.credit.index] || 0) : 0;

    totalDebit += debit;
    totalCredit += credit;

    if ((debit && debit % 1000 === 0) || (credit && credit % 1000 === 0)) {
      roundFigureCount++;
    }

    if (date && (date.endsWith("-28") || date.endsWith("-29") || date.endsWith("-30") || date.endsWith("-31"))) {
      monthEndCount++;
    }
  });

  // Calculate extraction confidence
  let extractionConfidence = "LOW";

  if (detectedColumns.date && detectedColumns.debit && detectedColumns.credit) {
    extractionConfidence = "HIGH";
  } else if (detectedColumns.date && (detectedColumns.debit || detectedColumns.credit)) {
    extractionConfidence = "MEDIUM";
  }

  // Identify ignored columns
  const ignoredColumns = [];
  headerNames.forEach((header, index) => {
    let isExtracted = false;
    Object.values(detectedColumns).forEach(col => {
      if (col && col.index === index) {
        isExtracted = true;
      }
    });
    
    if (!isExtracted && header) {
      ignoredColumns.push(header);
    }
  });

  return {
    totalEntries: dataRows.length,
    totalDebit,
    totalCredit,
    roundFigureCount,
    monthEndRatio: dataRows.length ? monthEndCount / dataRows.length : 0,
    lastEntryDate: dataRows.length ? dataRows[dataRows.length - 1].split(",")[0] : null,
    csvExtractionMeta: {
      totalColumns,
      extractedColumns: {
        date: detectedColumns.date || null,
        debit: detectedColumns.debit || null,
        credit: detectedColumns.credit || null
      },
      ignoredColumns,
      extractionConfidence
    }
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

    rawMetrics = {
      totalEntries: csv.totalEntries,
      totalDebit: csv.totalDebit,
      totalCredit: csv.totalCredit,
      roundFigureCount: csv.roundFigureCount,
      monthEndRatio: csv.monthEndRatio,
      lastEntryDate: csv.lastEntryDate
    };

    qualitativeMetrics = {
      totalEntries: csv.totalEntries <= 50 ? "0-50" : "50+",
      roundFigureLevel:
        csv.totalEntries > 0 && (csv.roundFigureCount / csv.totalEntries) > 0.4 ? "HIGH" : "LOW",
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
        document.getElementById("roundFigures")?.value === "high"
          ? "HIGH"
          : "LOW",
      monthEndLoad:
        document.getElementById("monthEnd")?.value === "high"
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

  // Add CSV extraction metadata if available
  if (file) {
    const csv = await parseCSV(file);
    payload.csvExtractionMeta = csv.csvExtractionMeta;
  }

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