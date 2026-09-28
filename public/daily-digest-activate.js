// The daily-digest activation page's behaviour. External file, not an inline
// script: the app's Content-Security-Policy (script-src 'self') blocks inline
// scripts, so the button in daily-digest-activate.html silently did nothing
// when this logic lived in the page (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).
(() => {
  const query = new URLSearchParams(location.search);
  const user = query.get("u");
  const token = query.get("t");
  const button = document.getElementById("activate");
  const message = document.getElementById("message");
  if (!user || !token) {
    button.disabled = true;
    message.textContent = "This activation link is invalid or incomplete.";
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    message.textContent = "Activating your daily digest…";
    try {
      const response = await fetch("/api/digests/activate-daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ u: user, t: token }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || "Activation could not be completed.");
      message.innerHTML = "";
      const text = document.createElement("p");
      text.textContent = "Daily digest is active.";
      const link = document.createElement("a");
      link.href = "/admin/admin.html#digests";
      link.textContent = "Open your digest inbox";
      message.append(text, link);
      button.remove();
    } catch (error) {
      message.textContent = error.message || "Activation could not be completed. Please try again.";
      button.disabled = false;
    }
  });
})();
