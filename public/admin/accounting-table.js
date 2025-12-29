// ---------------- CONFIG ----------------
const API_BASE_URL = "https://caprro-backend-1.onrender.com";

// ---------------- TOKEN ----------------
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// ---------------- LOAD RECORDS ----------------
async function loadRecords() {
  const token = getToken();
  if (!token) {
    alert("Auth token missing. Please open from extension.");
    return;
  }

  const res = await fetch(`${API_BASE_URL}/api/accounting`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await res.json();
  const div = document.getElementById("recordsTable");

  if (!data.ok) {
    div.innerHTML = "<p>Error loading records</p>";
    return;
  }

  if (!data.records.length) {
    div.innerHTML = "<p>No accounting records found.</p>";
    return;
  }

  div.innerHTML = data.records.map(r => `
    <div style="border:1px solid #334155; padding:8px; margin-bottom:6px;">
      <b>${r.clientName}</b> | ${r.periodKey}<br/>
      Health: ${r.health} | Score: ${r.readinessScore}%
      <div style="margin-top:6px;">
        <button onclick="viewDetail('${r._id}')">View</button>
        <button onclick="deleteRecord('${r._id}')">Delete</button>
      </div>
    </div>
  `).join("");
}

// ---------------- DELETE ----------------
async function deleteRecord(id) {
  if (!confirm("Delete this record permanently?")) return;

  const token = getToken();
  await fetch(`${API_BASE_URL}/api/accounting/${id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  loadRecords();
}

// Auto load
loadRecords();
