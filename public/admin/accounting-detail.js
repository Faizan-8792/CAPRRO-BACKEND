async function viewDetail(id) {
  const token = getToken();

  const res = await fetch(`${API_BASE_URL}/api/accounting/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json();
  if (!data.ok) return;

  const r = data.record;

  const modal = document.getElementById("viewModal");
  const content = document.getElementById("modalContent");
  const compareBox = document.getElementById("compareSection");

  content.innerHTML = `
    <p><b>Client:</b> ${r.clientName}</p>
    <p><b>Period:</b> ${r.periodKey}</p>
    <p><b>Health:</b> ${r.health}</p>
    <p><b>Score:</b> ${r.readinessScore}%</p>
    <p><b>Source:</b> ${r.source || "MANUAL"}</p>

    ${r.csvExtractionMeta ? `
      <hr/>
      <b>CSV Extraction Details</b>
      <p>Date column used: ${r.csvExtractionMeta.dateColumn || "Not detected"}</p>
      <p>Debit column used: ${r.csvExtractionMeta.debitColumn || "Not detected"}</p>
      <p>Credit column used: ${r.csvExtractionMeta.creditColumn || "Not detected"}</p>
      <p>Confidence: ${r.csvExtractionMeta.extractionConfidence}</p>
    ` : ""}

    <div class="score-box">
      <b>Score Breakdown</b>
      ${(r.flags || []).length
        ? r.flags.map(f => `<div class="flag">• ${f.replaceAll("_"," ")}</div>`).join("")
        : "<div>No major risk detected</div>"
      }
    </div>
  `;

  // -------- PERIOD COMPARE --------
  compareBox.classList.add("hidden");

  if (r.previousSnapshot) {
    const diff = r.readinessScore - r.previousSnapshot.readinessScore;
    compareBox.innerHTML = `
      <b>Compared with previous period (${r.previousSnapshot.periodKey})</b><br/>
      Score change:
      <span class="${diff >= 0 ? "compare-up" : "compare-down"}">
        ${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}%
      </span>
    `;
    compareBox.classList.remove("hidden");
  }

  modal.classList.remove("hidden");
}

// Close modal
document.getElementById("closeModal")?.addEventListener("click", () => {
  document.getElementById("viewModal").classList.add("hidden");
});