async function loadRecords() {
  const res = await fetch("/api/accounting", {
    headers: {
      Authorization: `Bearer ${getToken()}`
    }
  });
  const data = await res.json();

  const div = document.getElementById("recordsTable");
  div.innerHTML = data.records.map(r => `
    <div>
      <b>${r.clientName}</b> | ${r.periodKey}
      | ${r.health} | ${r.readinessScore}%
      <button onclick="viewDetail('${r._id}')">View</button>
      <button onclick="deleteRecord('${r._id}')">Delete</button>
    </div>
  `).join("");
}

async function deleteRecord(id) {
  await fetch(`/api/accounting/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  loadRecords();
}

loadRecords();
