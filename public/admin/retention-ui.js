function getRetentionValue() {
  return document.getElementById("retention").value;
}

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

async function createSnapshot() {
  const file = document.getElementById("csvFile").files[0];
  let metrics = {};

  if (file) {
    metrics = await parseCSV(file);
  }

  const intelligence = analyzeAccounting(metrics);

  await fetch("/api/accounting", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`
    },
    body: JSON.stringify({
      clientName: document.getElementById("clientName").value,
      periodKey: document.getElementById("periodKey").value,
      source: file ? "CSV" : "MANUAL",
      metrics,
      intelligence,
      retentionDays: getRetentionValue()
    })
  });

  loadRecords();
}
