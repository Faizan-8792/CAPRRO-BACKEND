// public/admin/login.js
// Used by public/index.html

const API_BASE = window.location.hostname === 'localhost' ? '/api' : '/capro/api';
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

  // ---------- AUTO LOGIN (if token already exists) ----------
  (async () => {
    const token = getToken();
    if (!token) return;

    const path = window.location.pathname || '';
    // Login page is "/" or "/index.html" at site root
    const isLoginPage =
      path === '/' ||
      path === '' ||
      path.endsWith('/index.html');

    // If already on login page, DO NOT redirect again → prevents reload loop
    if (isLoginPage) {
      console.log('On login page; skipping auto-login redirect');
      return;
    }

    try {
      console.log('Auto-login: calling /auth/me');
      const me = await api('/auth/me');
      const user = me.user;

      if (isSuperAdmin(user)) {
        window.location.href = '/admin/super.html';
        return;
      } else if (user.role === 'FIRM_ADMIN' && user.isActive === true) {
        window.location.href = '/admin/admin.html#dashboard';
        return;
      }

      // Unknown role → clear and stay
      clearToken();
    } catch (e) {
      console.error('Auto-login /auth/me failed:', e);
      clearToken();
    }
  })();

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

      statusEl.textContent = 'Sending OTP...';

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

      statusEl.textContent = 'Verifying OTP...';

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
      const user = me.user;
      console.log('Login successful user:', user);

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

      if (user.role === 'FIRM_ADMIN' && user.isActive === false) {
        statusEl.innerHTML =
          'Successfully signed up for Firm Admin! ' +
          'Your request is now pending Super Admin approval. ' +
          'Check back later or contact Super Admin at saifullahfaizan786@gmail.com.';
        setTimeout(() => {
          window.location.href = '/admin/admin.html#dashboard';
        }, 2500);
        return;
      }

      clearToken();
      // Either fully hide:
      statusEl.textContent = '';  // no message
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