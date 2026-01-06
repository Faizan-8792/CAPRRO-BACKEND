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
const exportWordBtn = document.getElementById("exportWordBtn");

// B) Service select hone par checklist nahi, client UI dikhao
selector.addEventListener("change", loadClientsForService);

// Export button
if (exportWordBtn) {
  exportWordBtn.addEventListener("click", exportServiceToWord);
}

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

  // show/hide export button based on service selection
  if (exportWordBtn) {
    if (service) exportWordBtn.classList.remove("hidden");
    else exportWordBtn.classList.add("hidden");
  }

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

// ---------------- EXPORT TO WORD ----------------
async function exportServiceToWord() {
  const service = selector.value;
  if (!service) return alert("Please choose a service first.");

  // Ensure docx lib is available
  if (!window.docx) {
    alert("Word export library failed to load. Please refresh and try again.");
    return;
  }

  const token = getToken();
  if (!token) {
    alert("Authentication missing. Please reopen from extension.");
    return;
  }

  try {
    if (window.caproShowLoader) window.caproShowLoader('Exporting to Word...');

    // 1) fetch clients for service
    const res = await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/clients/${service}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      alert("Failed to load clients for export.");
      return;
    }

    const clients = await res.json();
    const safeClients = Array.isArray(clients)
      ? clients.filter((c) => c && (c.clientName || c._id))
      : [];

    if (!safeClients.length) {
      alert(`No clients found under ${service}.`);
      return;
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = window.docx;

    const now = new Date();
    const title = `Tax Work Export — ${service}`;

    const children = [];
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
      })
    );
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Generated on: ${now.toLocaleString()}`, italics: true }),
        ],
      })
    );
    children.push(new Paragraph({ text: "" }));

    const steps = checklistMap[service] || [];

    // 2) For each client, fetch details so checklist comes too
    for (let i = 0; i < safeClients.length; i++) {
      const c = safeClients[i];

      let detail = null;
      try {
        const dres = await fetch(
          `https://caprro-backend-1.onrender.com/api/tax-work/client/${c._id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (dres.ok) detail = await dres.json();
      } catch (e) {
        // ignore per-client fetch failures; export whatever we can
      }

      const clientName = (detail && detail.clientName) || c.clientName || `Client ${i + 1}`;
      const dueDateISO = (detail && detail.dueDate) || c.dueDate;
      const dueText = dueDateISO ? new Date(dueDateISO).toDateString() : "";
      const checklist = (detail && detail.checklist) || {};

      // Heading
      children.push(
        new Paragraph({
          text: `${i + 1}. ${clientName}`,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 120 },
        })
      );

      if (dueText) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "Due Date: ", bold: true }),
              new TextRun({ text: dueText }),
            ],
          })
        );
      }

      // Table rows
      const rows = [];
      rows.push(
        new TableRow({
          tableHeader: true,
          children: [
            new TableCell({
              children: [new Paragraph({ text: "Checklist Step", bold: true })],
            }),
            new TableCell({
              children: [new Paragraph({ text: "Status", bold: true })],
            }),
          ],
        })
      );

      steps.forEach((step) => {
        const done = !!checklist[step];
        rows.push(
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ text: step })],
              }),
              new TableCell({
                children: [new Paragraph({ text: done ? "Completed" : "Pending" })],
              }),
            ],
          })
        );
      });

      const table = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
      });
      children.push(table);
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    const fileName = `TaxWork_${service}_${now.toISOString().slice(0, 10)}.docx`;
    downloadBlob(blob, fileName);
  } catch (err) {
    console.error("exportServiceToWord error:", err);
    alert("Export failed. Check console for details.");
  } finally {
    if (window.caproHideLoader) window.caproHideLoader();
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}