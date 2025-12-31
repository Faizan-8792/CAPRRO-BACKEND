const checklistMap = {
  GST: [
    "Collect sales invoices",
    "Collect purchase invoices",
    "Match GSTR-2B",
    "Prepare GSTR-1",
    "Prepare GSTR-3B",
    "Review data",
    "File return"
  ],
  ITR: [
    "Collect documents",
    "Verify Form 26AS",
    "Verify AIS",
    "Compute income",
    "Client confirmation",
    "File return",
    "Download acknowledgement"
  ],
  AUDIT: [
    "Trial balance review",
    "Voucher checking",
    "Ledger scrutiny",
    "Compliance check",
    "Final review"
  ],
  ROC: [
    "Collect statutory data",
    "Prepare forms",
    "Internal verification",
    "File ROC",
    "Download SRN"
  ]
};

// A) Add token helper (TOP OF FILE)
function getToken() {
  return new URLSearchParams(window.location.search).get("token");
}

// A) TOP OF FILE — VARIABLES ADD KARO
let activeClientId = null;

const selector = document.getElementById("serviceSelector");
const checklistEl = document.getElementById("checklist");
const progressBox = document.getElementById("progressBox");

// B) Service select hone par checklist nahi, client UI dikhao
// 🔁 MODIFY THIS LINE:
// selector.addEventListener("change", loadChecklist);
// 🔁 CHANGE TO:
selector.addEventListener("change", loadClientsForService);

// ➕ ADD NEW FUNCTION (loadClientsForService)
async function loadClientsForService() {
  const service = selector.value;
  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  if (!service) return;

  document.getElementById("clientForm").classList.remove("hidden");
  document.getElementById("clientList").classList.remove("hidden");

  const token = getToken();
  const res = await fetch(
    `https://caprro-backend-1.onrender.com/api/tax-work/clients/${service}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const clients = await res.json();
  const list = document.getElementById("clientList");
  list.innerHTML = "";

  clients.forEach(c => {
    const div = document.createElement("div");
    div.className = "client-row";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = c.clientName;

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View / Edit";
    viewBtn.addEventListener("click", () => openClient(c._id));

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteClient(c._id));

    const btnWrap = document.createElement("div");
    btnWrap.appendChild(viewBtn);
    btnWrap.appendChild(delBtn);

    div.innerHTML = "";
    div.appendChild(nameSpan);
    div.appendChild(btnWrap);
    list.appendChild(div);
  });
}

// 🔹 C) Add Client button ka logic add karo
document.getElementById("addClientBtn").addEventListener("click", async () => {
  const name = document.getElementById("clientName").value;
  const dueDate = document.getElementById("dueDate").value;
  const service = selector.value;

  if (!name || !dueDate) return alert("Fill all fields");

  await fetch("https://caprro-backend-1.onrender.com/api/tax-work/client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`
    },
    body: JSON.stringify({ clientName: name, dueDate, serviceType: service })
  });

  loadClientsForService();
});

// 🔹 D) Client open karne par EXISTING checklist load karo
window.openClient = async function (clientId) {
  activeClientId = clientId;
  loadChecklist(); // EXISTING FUNCTION REUSED
};

async function loadChecklist() {
  const service = selector.value;
  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  if (!service) return;

  // B) Update GET fetch - Check token first
  const token = getToken();
  if (!token) {
    progressBox.innerHTML =
      "⚠ Authentication missing. Please reopen from extension.";
    return;
  }

  let res;
  try {
    res = await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/${service}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
  } catch (e) {
    progressBox.innerText = "Network error. Please try again.";
    return;
  }

  // 🔴 AUTH FAILURE HANDLING (VERY IMPORTANT)
  if (res.status === 401) {
    progressBox.innerHTML = `
      <span style="color:#f59e0b">
        ⚠ You are not logged in.  
        Please login in CA PRO Toolkit first, then reopen this page.
      </span>
    `;
    return;
  }

  let saved;
  try {
    saved = await res.json();
  } catch {
    progressBox.innerText = "Unexpected server response.";
    return;
  }

  // 🛑 SAFETY: backend must return array
  if (!Array.isArray(saved)) {
    progressBox.innerText = "Unable to load checklist data.";
    return;
  }

  const steps = checklistMap[service];
  let completed = 0;

  steps.forEach(step => {
    const record = saved.find(r => r.checklistStep === step);
    const isDone = record?.completed || false;
    if (isDone) completed++;

    const li = document.createElement("li");
    if (isDone) li.classList.add("completed");

    li.innerHTML = `
      <input type="checkbox" ${isDone ? "checked" : ""} />
      <span>${step}</span>
    `;

    li.querySelector("input").addEventListener("change", e => {
      updateStep(service, step, e.target.checked);
    });

    checklistEl.appendChild(li);
  });

  let status = "NOT STARTED";
  if (completed > 0 && completed < steps.length) status = "IN PROGRESS";
  if (completed === steps.length) status = "COMPLETED";

  progressBox.innerText = `Progress: ${completed}/${steps.length} — ${status}`;
}

async function updateStep(service, step, completed) {
  // C) Update POST fetch - Check token first
  const token = getToken();
  if (!token) {
    alert("Authentication missing.");
    return;
  }

  const res = await fetch(
    "https://caprro-backend-1.onrender.com/api/tax-work",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        serviceType: service,
        checklistStep: step,
        completed
      })
    }
  );

  if (res.status === 401) {
    alert("You are not logged in. Please login and try again.");
    return;
  }

  loadChecklist();
}