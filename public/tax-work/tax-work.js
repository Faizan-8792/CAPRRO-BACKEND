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

const selector = document.getElementById("serviceSelector");
const checklistEl = document.getElementById("checklist");
const progressBox = document.getElementById("progressBox");

selector.addEventListener("change", loadChecklist);

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