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

  if (q.roundFigureLevel === "high") {
    flags.push("ROUND_FIGURE_OVERUSE");
    score -= 25;
  }

  if (q.monthEndLoad === "high") {
    flags.push("YEAR_END_PRESSURE");
    score -= 25;
  }

  if (q.maturity === "basic") {
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

// ---------------- CSV CELL CLEANER ----------------
function cleanCSVValue(v) {
  if (v == null) return "";
  return v.toString().replace(/^"|"$/g, "").trim();
}

// ---------------- FILE READER ----------------
async function readFileAsTextRows(file) {
  // CSV
  if (file.name.toLowerCase().endsWith(".csv")) {
    const text = await file.text();
    return text.split("\n").filter(Boolean);
  }

  // XLSX
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const csvText = XLSX.utils.sheet_to_csv(sheet);
    return csvText.split("\n").filter(Boolean);
  }

  throw new Error("Unsupported file type. Please upload CSV or XLSX.");
}

// ---------------- CSV PARSER ----------------
async function parseCSV(file) {
  const rows = await readFileAsTextRows(file);
  
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

    const date = cols.date
      ? cleanCSVValue(columns[cols.date.index])
      : null;

    const debit = cols.debit
      ? parseFloat(cleanCSVValue(columns[cols.debit.index])) || 0
      : 0;

    const credit = cols.credit
      ? parseFloat(cleanCSVValue(columns[cols.credit.index])) || 0
      : 0;

    totalDebit += debit;
    totalCredit += credit;

    if ((debit && debit % 1000 === 0) || (credit && credit % 1000 === 0)) {
      roundFigureCount++;
    }

    if (date && /-(28|29|30|31)$/.test(date)) {
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

// ---------------- RESET FORM FUNCTION ----------------
function resetForm() {
  const form = document.querySelector('.form-card');
  const inputs = form.querySelectorAll('input, select, textarea');
  inputs.forEach(input => {
    if (input.type === 'file') {
      input.value = '';
      document.getElementById('removeCsvBtn').style.display = 'none';
    } else if (input.type === 'select-one') {
      // Keep retention value as 30 (default)
      if (input.id === 'retention') {
        input.value = '30';
      } else {
        input.selectedIndex = 0;
      }
    } else {
      input.value = '';
    }
  });
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

  // File extension guard
  if (file && !file.name.match(/\.(csv|xlsx)$/i)) {
    alert("Please upload a CSV or Excel (.xlsx) file only.");
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
        csv.totalEntries > 0 && (csv.roundFigureCount / csv.totalEntries) > 0.2 ? "high" : "low",
      monthEndLoad: csv.monthEndRatio > 0.25 ? "high" : "low",
      maturity: csv.totalEntries > 200
        ? "advanced"
        : csv.totalEntries > 50
          ? "intermediate"
          : "basic",
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
          ? "high"
          : "low",
      monthEndLoad:
        document.getElementById("monthEnd")?.value === "high"
          ? "high"
          : "low",
      maturity:
        document.getElementById("maturity")?.value === "basic"
          ? "basic"
          : "advanced",
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