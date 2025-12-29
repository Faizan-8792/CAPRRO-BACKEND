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

    ${r.intelligence?.conclusion ? `
      <div class="audit-conclusion-box">
        <h4>Audit Conclusion & Recommended Next Steps</h4>
        <p>${r.intelligence.conclusion}</p>
      </div>
    ` : ""}

    ${r.csvExtractionMeta ? `
      <hr/>
      <b>CSV Extraction Details</b>
      <p>Date column used: ${r.csvExtractionMeta.extractedColumns?.date?.header || "Not detected"}</p>
      <p>Debit column used: ${r.csvExtractionMeta.extractedColumns?.debit?.header || "Not detected"}</p>
      <p>Credit column used: ${r.csvExtractionMeta.extractedColumns?.credit?.header || "Not detected"}</p>
      <p>Confidence: ${r.csvExtractionMeta.extractionConfidence}</p>
    ` : ""}

    <div class="score-box">
      <b>Score Breakdown</b>
      ${(r.flags || []).length
        ? r.flags.map(f => `<div class="flag">• ${f.replaceAll("_"," ")}</div>`).join("")
        : "<div>No major risk detected</div>"
      }
    </div>

    ${r.csvExtractionMeta ? `
      <hr/>

      <div class="csv-extraction-box">
        <h4>CSV Extraction Summary</h4>

        <div class="csv-meta-row">
          <span>Total columns in CSV:</span>
          <b>${r.csvExtractionMeta.totalColumns || "N/A"}</b>
        </div>

        <div class="csv-meta-row">
          <span>Extracted columns:</span>
          <ul>
            <li>Date → ${r.csvExtractionMeta.extractedColumns?.date?.header || "Not detected"}</li>
            <li>Debit → ${r.csvExtractionMeta.extractedColumns?.debit?.header || "Not detected"}</li>
            <li>Credit → ${r.csvExtractionMeta.extractedColumns?.credit?.header || "Not detected"}</li>
          </ul>
        </div>

        <div class="csv-meta-row">
          <span>Ignored columns:</span>
          <div class="ignored-columns">
            ${r.csvExtractionMeta.ignoredColumns && r.csvExtractionMeta.ignoredColumns.length
              ? r.csvExtractionMeta.ignoredColumns.map(col => `<span class="badge">${col}</span>`).join("")
              : "None"
            }
          </div>
        </div>

        <div class="csv-confidence ${r.csvExtractionMeta.extractionConfidence}">
          Confidence: ${r.csvExtractionMeta.extractionConfidence}
        </div>
      </div>
    ` : ""}
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