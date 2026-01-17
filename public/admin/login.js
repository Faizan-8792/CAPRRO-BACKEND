// public/admin/login.js
// Used by public/index.html
const API_BASE = "https://capro--saifullahfaizan.replit.app/api";


const TOKEN_KEY = 'caproadminjwt';

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
    { 'Content-Type': 'application/json' },
    opts?.headers
  );

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts?.method || 'GET',
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
    const msg = data?.error || data?.message || 'Request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function isSuperAdmin(user) {
  return user.role === 'SUPER_ADMIN' ||
         user.email === 'saifullahfaizan786@gmail.com';
}

function getExtEmailFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const v = params.get('extEmail');
    if (!v) return null;
    const email = String(v).trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
}

// ---------------- LOGIN PAGE (public/index.html) ----------------

async function initLoginPage() {
  const sendOtpBtn = document.getElementById('sendOtp');
  if (!sendOtpBtn) return; // not on login page

  const emailEl = document.getElementById('email');
  const otpEl = document.getElementById('otp');
  const statusEl = document.getElementById('status');
  const otpBlock = document.getElementById('otpBlock');
  const goVerify = document.getElementById('goVerify');
  const verifyBtn = document.getElementById('verifyOtp');

  const extEmail = getExtEmailFromQuery();

  // Default hint (so the status area is never confusing/empty)
  if (statusEl && !statusEl.textContent) {
    if (extEmail) {
      statusEl.innerHTML =
        `You are logged in the Chrome extension as <b>${extEmail}</b>.<br/>` +
        'Please use the <b>same email</b> here to open the Admin Panel.';
    } else {
      statusEl.textContent = 'Enter your email, click “Send OTP”, then verify.';
    }
  }

  // ---------- UI handlers ----------

  goVerify?.addEventListener('click', () => {
    otpBlock.style.display = 'block';
    statusEl.textContent = 'Enter OTP and verify.';
  });

  sendOtpBtn.addEventListener('click', async () => {
    try {
      const email = emailEl.value.trim();
      if (!email) {
        statusEl.textContent = 'Email required.';
        return;
      }

      if (extEmail && String(email).trim().toLowerCase() !== extEmail) {
        statusEl.innerHTML =
          `You are currently logged into the Chrome extension as <b>${extEmail}</b>.<br/>` +
          `Please login here using the <b>same email</b>.`;
        return;
      }

      statusEl.textContent = 'Sending OTP...';
      if (window.caproShowLoader) window.caproShowLoader('Sending OTP...');
      try {
        const res = await fetch(`${API_BASE}/auth/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || data?.message || 'Failed to send OTP');
        }

        otpBlock.style.display = 'block';
        statusEl.textContent = 'OTP sent. Check your email.';
      } finally {
        if (window.caproHideLoader) window.caproHideLoader();
      }
    } catch (e) {
      console.error('Send OTP error:', e);
      statusEl.textContent = e.message || 'Failed to send OTP.';
    }
  });

  verifyBtn.addEventListener('click', async () => {
    try {
      const email = emailEl.value.trim();
      const otpCode = otpEl.value.trim();

      if (!email || !otpCode) {
        statusEl.textContent = 'Email & OTP required.';
        return;
      }

      if (extEmail && String(email).trim().toLowerCase() !== extEmail) {
        statusEl.innerHTML =
          `You are currently logged into the Chrome extension as <b>${extEmail}</b>.<br/>` +
          `Please verify OTP using the <b>same email</b>.`;
        return;
      }

      statusEl.textContent = 'Verifying OTP...';
      if (window.caproShowLoader) window.caproShowLoader('Verifying OTP...');
      
      let user = null;
      
      try {
        const res = await fetch(`${API_BASE}/auth/verify-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, otpCode }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || data?.message || 'Failed to verify OTP');
        }

        // Save JWT
        saveToken(data.token);

        // Fetch user and redirect
        const me = await api('/auth/me');
        user = me.user;
      } finally {
        if (window.caproHideLoader) window.caproHideLoader();
      }
      
      console.log('Login successful user:', user);

      if (!user) {
        clearToken();
        statusEl.textContent = 'Login failed: user profile not found. Please try again.';
        return;
      }

      if (isSuperAdmin(user)) {
        statusEl.textContent = 'Super Admin login successful. Redirecting...';
        setTimeout(() => {
          window.location.href = '/admin/super.html';
        }, 800);
        return;
      } else if (user.role === 'FIRM_ADMIN' && user.isActive === true) {
        statusEl.textContent = 'Firm Admin login successful. Redirecting...';
        setTimeout(() => {
          window.location.href = '/admin/admin.html#dashboard';
        }, 800);
        return;
      }

      // 1) Agar already FIRM_ADMIN hai but pending
      if (user.role === 'FIRM_ADMIN' && user.isActive === false) {
        statusEl.innerHTML =
          'Your Firm Admin account is created, but it is <b>pending Super Admin approval</b>.<br/>' +
          'You can open the Admin Panel in <b>view-only demo mode</b> for now.<br/>' +
          'Please wait until Super Admin approves your request.';
        setTimeout(() => {
          window.location.href = '/admin/admin.html#dashboard';
        }, 2500);
        return;
      }

      // 2) USER with NO firm → truly new person
      if (user.role === 'USER' && !user.firmId) {
        statusEl.innerHTML =
          'You are signed in as a normal user.<br/>' +
          '<b>Step 1:</b> Create your Firm from the <b>Chrome extension</b> (Create Firm).<br/>' +
          '<b>Step 2:</b> Come back here and sign in again using OTP.<br/>' +
          'After that, you will be taken to the Admin Panel (view-only) until Super Admin approves.';
        clearToken();
        return;
      }

      // 3) USER already linked to a firm → yahan se admin request create karenge
      if (user.role === 'USER' && user.firmId && user.isActive === true) {
        try {
          statusEl.textContent = 'Creating Firm Admin request...';
          const resp = await api('/firms/request-admin', { method: 'POST' });

          if (resp.ok) {
            statusEl.textContent =
              'Request as Firm Admin has been successfully sent. Please wait for approval from your existing admin.';
          } else {
            statusEl.textContent =
              resp.error || 'Failed to create Firm Admin request.';
          }
        } catch (err) {
          console.error('request-admin error:', err);
          statusEl.textContent =
            err.message || 'Failed to create Firm Admin request.';
        }

        clearToken();
        return;
      }

      // 4) General case: linked firm + already pending
      if ((user.role === 'USER' || user.role === 'FIRM_ADMIN') &&
          user.firmId && user.isActive === false) {
        statusEl.textContent =
          'Request as Firm Admin has been successfully sent. Please wait for approval from your existing admin.';
        return;
      }

      // fallback
      clearToken();
      statusEl.textContent = '';
    } catch (e) {
      console.error('Login / verify OTP error:', e);
      statusEl.textContent = e.message || 'Login failed.';
      clearToken();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initLoginPage();
});