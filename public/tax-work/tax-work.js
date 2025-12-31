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

const selector = document.getElementById("serviceSelector");
const checklistEl = document.getElementById("checklist");
const progressBox = document.getElementById("progressBox");

selector.addEventListener("change", loadChecklist);

async function loadChecklist() {
  const service = selector.value;
  checklistEl.innerHTML = "";
  progressBox.innerHTML = "";

  if (!service) return;

  let res;
  try {
    res = await fetch(
      `https://caprro-backend-1.onrender.com/api/tax-work/${service}`,
      { credentials: "include" }
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
  const res = await fetch(
    "https://caprro-backend-1.onrender.com/api/tax-work",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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