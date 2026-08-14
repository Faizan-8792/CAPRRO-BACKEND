// public/unsubscribe.js
// Used by public/unsubscribe.html - the public, no-login digest-email
// unsubscribe confirmation page. u/k/t come from the link the recipient
// clicked in their email; this page never asks them to sign in.

const API_BASE = "https://api.caprotoolkit.in/api";

const KIND_LABELS = {
  DAILY_PERSONAL: "Daily personal work digest",
  WEEKLY_FIRM: "Weekly firm operations summary",
};

function show(id) {
  for (const el of document.querySelectorAll(
    "#loading, #form, #result, #error",
  )) {
    el.classList.toggle("hidden", el.id !== id);
  }
}

function setStatus(message, kind) {
  const el = document.getElementById("status");
  if (!message) {
    el.className = "status";
    el.textContent = "";
    return;
  }
  el.className = `status ${kind}`;
  el.textContent = message;
}

function paramsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    u: params.get("u") || "",
    k: params.get("k") || "",
    t: params.get("t") || "",
  };
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore parse failure; handled by !res.ok below
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || "Request failed");
    error.status = res.status;
    error.code = data?.code || "";
    throw error;
  }
  return data;
}

async function main() {
  const { u, k, t } = paramsFromUrl();
  if (!u || !k || !t) {
    show("error");
    return;
  }

  let preview;
  try {
    const query = new URLSearchParams({ u, k, t }).toString();
    preview = await api(`/digests/unsubscribe?${query}`);
  } catch (err) {
    document.getElementById("error-message").textContent =
      err.status === 404
        ? "This account is unavailable."
        : "This link isn't valid or has expired. You can change your email preferences any time from inside CA PRO Toolkit under Settings.";
    show("error");
    return;
  }

  const kindLabel = preview.kindLabel || KIND_LABELS[k] || k;
  document.getElementById("email-value").textContent = preview.email || "—";
  document.getElementById("kind-value").textContent = kindLabel;
  document.getElementById("kind-inline").textContent = kindLabel;
  document.getElementById("account-line").textContent =
    "Choose how much CA PRO Toolkit mail should stop.";
  show("form");

  document.getElementById("confirm-btn").addEventListener("click", async () => {
    const button = document.getElementById("confirm-btn");
    const scope =
      document.querySelector('input[name="scope"]:checked')?.value ||
      "THIS_KIND";
    button.disabled = true;
    setStatus("Working…", "ok");
    try {
      const query = new URLSearchParams({ u, k, t }).toString();
      const result = await api(`/digests/unsubscribe?${query}`, {
        method: "POST",
        body: { scope },
      });
      setStatus("", null);
      document.getElementById("result-title").textContent = "Unsubscribed";
      document.getElementById("result-subtitle").textContent =
        result.scope === "ALL"
          ? "You will no longer receive any CA PRO Toolkit digest emails."
          : `You will no longer receive the ${result.kindLabel || kindLabel}.`;
      show("result");
    } catch (err) {
      button.disabled = false;
      setStatus(
        err.status === 404
          ? "This account is unavailable."
          : "This link isn't valid or has expired.",
        "error",
      );
    }
  });
}

main();
