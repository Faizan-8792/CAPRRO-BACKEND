// public/admin/login.js
// Used by public/index.html
// Same-origin base -- see public/admin/super.js for why this must never be absolute.
const API_BASE = "/api";

const TOKEN_KEY = "caproadminjwt";

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, opts) {
  const token = getToken();
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts?.headers,
  );

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts?.method || "GET",
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore parse failure
  }

  if (!res.ok) {
    const msg = data?.error || data?.message || "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function isSuperAdmin(user) {
  return (
    user.role === "SUPER_ADMIN" || user.email === "saifullahfaizan786@gmail.com"
  );
}

// ---------------- LOGIN PAGE (public/index.html) ----------------

async function initLoginPage() {
  const sendOtpBtn = document.getElementById("sendOtp");
  if (!sendOtpBtn) return; // not on login page

  const emailEl = document.getElementById("email");
  const otpEl = document.getElementById("otp");
  const statusEl = document.getElementById("status");
  const otpBlock = document.getElementById("otpBlock");
  const goVerify = document.getElementById("goVerify");
  const verifyBtn = document.getElementById("verifyOtp");

  // One status line, in the tone of what happened; always text, never markup (DS25).
  const say = (text, tone = "") => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  // ---------- UI handlers ----------

  goVerify?.addEventListener("click", () => {
    otpBlock.style.display = "block";
    say("Enter the OTP from your email, then verify.");
    otpEl.focus();
  });

  sendOtpBtn.addEventListener("click", async () => {
    try {
      const email = emailEl.value.trim();
      if (!email) {
        say("Enter your email first.", "critical");
        emailEl.focus();
        return;
      }

      say("Sending the OTP...");

      const res = await fetch(`${API_BASE}/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || data?.message || "Failed to send OTP");
      }

      otpBlock.style.display = "block";
      say("OTP sent. Check your email.", "success");
      otpEl.focus();
    } catch (e) {
      console.error("Send OTP error:", e);
      say(e.message || "The OTP could not be sent. Try again.", "critical");
    }
  });

  verifyBtn.addEventListener("click", async () => {
    try {
      const email = emailEl.value.trim();
      const otpCode = otpEl.value.trim();

      if (!email || !otpCode) {
        say("Enter your email and the OTP.", "critical");
        return;
      }

      say("Checking the OTP...");

      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otpCode }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || data?.message || "Failed to verify OTP");
      }

      // Save JWT
      saveToken(data.token);

      // The login response already carries role, firmId, and isActive. An
      // inactive account cannot call /auth/me (it returns 403), so re-fetching
      // first would throw and hide the pending-approval message below.
      const loginUser = data.user || null;
      const user =
        loginUser && loginUser.isActive === false
          ? loginUser
          : (await api("/auth/me")).user;
      console.log("Login successful user:", user);

      if (isSuperAdmin(user)) {
        say("Signed in as the super admin. Opening the panel...", "success");
        setTimeout(() => {
          window.location.href = "/admin/super.html";
        }, 800);
        return;
      } else if (user.role === "FIRM_ADMIN" && user.isActive === true) {
        say("Signed in as a firm admin. Opening the panel...", "success");
        setTimeout(() => {
          window.location.href = "/admin/admin.html#dashboard";
        }, 800);
        return;
      }

      // 1) Account is not active on the server. That covers both an unapproved
      //    firm-admin request and a suspension, and the API refuses every call
      //    either way, so do not claim success and do not open the dashboard.
      if (user.isActive === false) {
        say(
          "This account is not active on the server, so the admin panel cannot load. " +
          "If you asked to become a Firm Admin, the request is waiting for Super Admin approval at " +
          "saifullahfaizan786@gmail.com.",
          "critical",
        );
        clearToken();
        return;
      }

      // 2) USER with NO firm → truly new person
      if (user.role === "USER" && !user.firmId) {
        say("First create a firm from the admin panel, then come back to this page to sign in as Firm Admin.", "critical");
        clearToken();
        return;
      }

      // 3) USER already linked to a firm → yahan se admin request create karenge
      if (user.role === "USER" && user.firmId && user.isActive === true) {
        try {
          say("Creating Firm Admin request...");
          const resp = await api("/firms/request-admin", { method: "POST" });

          if (resp.ok && resp.alreadyPending) {
            say("A Firm Admin request for this account is already waiting for Super Admin approval.", "success");
          } else if (resp.ok) {
            say("Firm Admin request sent. It is waiting for Super Admin approval.", "success");
          } else {
            say(resp.error || "The Firm Admin request could not be created. Try again.", "critical");
          }
        } catch (err) {
          console.error("request-admin error:", err);
          say(err.message || "The Firm Admin request could not be created. Try again.", "critical");
        }

        clearToken();
        return;
      }

      // 4) General case: linked firm + already pending
      if (
        (user.role === "USER" || user.role === "FIRM_ADMIN") &&
        user.firmId &&
        user.isActive === false
      ) {
        say("Request as Firm Admin has been successfully sent. Please wait for approval from your existing admin.", "success");
        return;
      }

      // fallback
      clearToken();
      say("");
    } catch (e) {
      console.error("Login / verify OTP error:", e);
      say(e.message || "Signing in did not work. Try again.", "critical");
      clearToken();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initLoginPage();
});
