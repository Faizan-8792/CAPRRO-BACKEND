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
let checklistDraft = {};
let isChecklistOpen = false;
let isDirty = false;

const selector = document.getElementById("serviceSelector");
const checklistEl = document.getElementById("checklist");
const progressBox = document.getElementById("progressBox");

// B) Service select hone par checklist nahi, client UI dikhao
selector.addEventListener("change", loadClientsForService);

// ➕ ADD NEW FUNCTION (loadClientsForService)
async function loadClientsForService() {
  // If checklist is open, confirm and close it
  if (isChecklistOpen) {
    if (isDirty) {
      const ok = confirm("Do you want to discard changes?");
      if (!ok) return;
    }
    // force close checklist
    checklistDraft = {};
    activeClientId = null;
    isChecklistOpen = false;
    isDirty = false;
    checklistEl.innerHTML = "";
    document.getElementById("doneBtn").classList.add("hidden");
  }

  const service = selector.value;
  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  if (!service) return;

  document.getElementById("clientForm").classList.remove("hidden");
  document.getElementById("clientList").classList.remove("hidden");

  const token = getToken();
  try {
    if (window.caproShowLoader) window.caproShowLoader('Loading clients...');
    const res = await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/clients/${service}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    var clients = await res.json();
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }
  const list = document.getElementById("clientList");
  list.innerHTML = "";

  // SAFETY CHECK: Clear list and guard against empty records
  clients.forEach(c => {
    if (!c || !c.clientName) return;  // VERY IMPORTANT

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

// DELETE CLIENT FUNCTION
window.deleteClient = async function (clientId) {
  if (!confirm("Are you sure you want to delete this client?")) return;

  const token = getToken();
  try {
    if (window.caproShowLoader) window.caproShowLoader('Deleting client...');
    await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/client/${clientId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }

  // refresh list
  loadClientsForService();
};

// 🔹 C) Add Client button ka logic add karo
document.getElementById("addClientBtn").addEventListener("click", async () => {
  const name = document.getElementById("clientName").value;
  const dueDate = document.getElementById("dueDate").value;
  const service = selector.value;

  if (!name || !dueDate) return alert("Fill all fields");
  try {
    if (window.caproShowLoader) window.caproShowLoader('Creating client...');
    await fetch("https://caprro-backend-1.onrender.com/api/tax-work/client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify({ clientName: name, dueDate, serviceType: service })
    });
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }

  loadClientsForService();
});


// 🔹 D) Client open karne par CLIENT-WISE checklist load karo
window.openClient = async function (clientId) {
  // TOGGLE: agar same client open hai
  if (isChecklistOpen && activeClientId === clientId) {
    if (isDirty) {
      const ok = confirm("Do you want to discard changes?");
      if (!ok) return;
    }

    // CLOSE checklist
    checklistDraft = {};
    activeClientId = null;
    isChecklistOpen = false;
    isDirty = false;

    checklistEl.innerHTML = "";
    document.getElementById("doneBtn").classList.add("hidden");
    loadClientsForService();
    return;
  }

  activeClientId = clientId;

  // hide client UI
  document.getElementById("clientForm").classList.add("hidden");
  document.getElementById("clientList").classList.add("hidden");

  // show checklist + done
  document.getElementById("doneBtn").classList.remove("hidden");

  // Load client-specific checklist instead of service-based
  isChecklistOpen = true;
  isDirty = false;
  loadClientChecklist(clientId);
};

// NEW FUNCTION: Load client-specific checklist
async function loadClientChecklist(clientId) {
  checklistDraft = {};

  const token = getToken();
  try {
    if (window.caproShowLoader) window.caproShowLoader('Loading checklist...');
    const res = await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/client/${clientId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    var saved = await res.json();
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }

  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  const service = selector.value;
  const steps = checklistMap[service] || [];
  
  let completed = 0;

  steps.forEach(step => {
    const checked = saved.checklist ? saved.checklist[step] : false;
    checklistDraft[step] = checked;
    if (checked) completed++;

    const li = document.createElement("li");
    if (checked) li.classList.add("completed");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;

    cb.addEventListener("change", () => {
      checklistDraft[step] = cb.checked;
      li.classList.toggle("completed", cb.checked);
      isDirty = true;

      // 🔽 ADD THIS (progress recalc)
      const doneCount = Object.values(checklistDraft).filter(Boolean).length;
      let status = "NOT STARTED";
      if (doneCount > 0 && doneCount < steps.length) status = "IN PROGRESS";
      if (doneCount === steps.length) status = "COMPLETED";
      progressBox.innerText = `Progress: ${doneCount}/${steps.length} — ${status}`;
    });

    li.appendChild(cb);
    li.appendChild(document.createTextNode(step));
    checklistEl.appendChild(li);
  });

  // Update progress
  let status = "NOT STARTED";
  if (completed > 0 && completed < steps.length) status = "IN PROGRESS";
  if (completed === steps.length) status = "COMPLETED";
  progressBox.innerText = `Progress: ${completed}/${steps.length} — ${status}`;
}

// Keep old loadChecklist function but it won't be used for client mode
async function loadChecklist() {
  const service = selector.value;
  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  if (!service) return;

  const token = getToken();
  if (!token) {
    progressBox.innerHTML =
      "⚠ Authentication missing. Please reopen from extension.";
    return;
  }

  let res;
  try {
    if (window.caproShowLoader) window.caproShowLoader('Loading checklist...');
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
      // CHANGE TO local state only
      checklistDraft[step] = e.target.checked;
    });

    checklistEl.appendChild(li);
  });

  let status = "NOT STARTED";
  if (completed > 0 && completed < steps.length) status = "IN PROGRESS";
  if (completed === steps.length) status = "COMPLETED";

  progressBox.innerText = `Progress: ${completed}/${steps.length} — ${status}`;
}

// DONE button logic
document.getElementById("doneBtn").addEventListener("click", async () => {
  if (!activeClientId) return;

  const token = getToken();

  try {
    if (window.caproShowLoader) window.caproShowLoader('Saving checklist...');
    await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/client/${activeClientId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ checklist: checklistDraft })
      }
    );
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }

  // reset UI
  checklistDraft = {};
  activeClientId = null;
  checklistEl.innerHTML = "";
  document.getElementById("doneBtn").classList.add("hidden");
  isChecklistOpen = false;
  isDirty = false;

  // clear client form fields
  document.getElementById("clientName").value = "";
  document.getElementById("dueDate").value = "";

  // show client list again
  loadClientsForService();
});

async function updateStep(service, step, completed) {
  // C) Update POST fetch - Check token first
  const token = getToken();
  if (!token) {
    alert("Authentication missing.");
    return;
  }

  try {
    if (window.caproShowLoader) window.caproShowLoader('Updating step...');
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
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }
}