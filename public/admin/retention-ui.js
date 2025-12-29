// ---------------- TOKEN HELPER ----------------
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// ---------------- RETENTION ----------------
function getRetentionValue() {
  return document.getElementById("retention").value;
}

// ---------------- CREATE SNAPSHOT ----------------
async function createSnapshot() {
  const token = getToken();
  if (!token) {
    alert("Auth token missing.");
    return;
  }

  const clientName = document.getElementById("clientName").value.trim();
  const periodKey = document.getElementById("periodKey").value.trim();
  const file = document.getElementById("csvFile").files[0];

  if (!clientName || !periodKey) {
    alert("Client name and period are required");
    return;
  }

  let metrics = {};
  let source = "MANUAL";

  if (file) {
    metrics = await parseCSV(file);
    source = "CSV";
  }

  const intelligence = analyzeAccounting(metrics);

  await fetch("/api/accounting", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      clientName,
      periodKey,
      source,
      metrics,
      intelligence,
      retentionDays: getRetentionValue()
    })
  });

  loadRecords();
}

// ---------------- BIND BUTTON (CSP SAFE) ----------------
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("saveSnapshotBtn");
  if (btn) {
    btn.addEventListener("click", createSnapshot);
  }
});
