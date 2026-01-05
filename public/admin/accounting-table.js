// ---------------- TOKEN ----------------
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// ---------------- LOAD RECORDS ----------------
async function loadRecords() {
  const token = getToken();
  const container = document.getElementById("recordsTable");

  if (!container) return;

  if (!token) {
    container.innerHTML = `<p class="muted">Authentication missing.</p>`;
    return;
  }

  try {
    if (window.caproShowLoader) window.caproShowLoader('Loading accounting records...');
    try {
      const res = await fetch(`${API_BASE_URL}/api/accounting`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      var data = await res.json();
    } finally {
      if (window.caproHideLoader) window.caproHideLoader();
    }

    if (!res.ok || !data.ok) {
      container.innerHTML = `<p class="muted">Failed to load accounting records.</p>`;
      return;
    }

    if (!data.records || !data.records.length) {
      container.innerHTML = `<p class="muted">No accounting records found.</p>`;
      return;
    }

    container.innerHTML = data.records
      .map(
        (r) => `
        <div class="record-card">
          <div>
            <b>${r.clientName}</b> | ${r.periodKey}
          </div>
          <div class="muted">
            Health: ${r.health} · Score: ${r.readinessScore}%
          </div>
          
          <div class="muted">
            Source: ${r.source || "MANUAL"}
            ${r.csvExtractionMeta ? `· Confidence: ${r.csvExtractionMeta.extractionConfidence}` : ""}
          </div>

          <div class="record-actions">
            <button class="btn-view" data-id="${r._id}">View</button>
            <button class="btn-delete" data-id="${r._id}">Delete</button>
          </div>
        </div>
      `
      )
      .join("");

    // View handlers
    container.querySelectorAll(".btn-view").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id && typeof viewDetail === "function") {
          viewDetail(id);
        }
      });
    });

    // Delete handlers
    container.querySelectorAll(".btn-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) deleteRecord(id);
      });
    });
  } catch (err) {
    console.error("Load records failed:", err);
    container.innerHTML = `<p class="muted">Error loading records.</p>`;
  }
}

// ---------------- DELETE ----------------
async function deleteRecord(id) {
  if (!confirm("Delete this accounting snapshot permanently?")) return;

  const token = getToken();
  if (!token) return;

  try {
    if (window.caproShowLoader) window.caproShowLoader('Deleting record...');
    try {
      await fetch(`${API_BASE_URL}/api/accounting/${id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } finally {
      if (window.caproHideLoader) window.caproHideLoader();
    }

    loadRecords();
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

// ---------------- INIT ----------------
loadRecords();