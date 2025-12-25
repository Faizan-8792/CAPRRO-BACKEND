// public/admin/login.js
// Used by public/index.html
const API_BASE = "https://caprro-backend-1.onrender.com/api";


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

      // 1) Agar already FIRM_ADMIN hai but pending
      if (user.role === 'FIRM_ADMIN' && user.isActive === false) {
        statusEl.innerHTML =
          'Successfully signed up for Firm Admin! ' +
          'Your request is now pending Super Admin approval. ' +
          'Check back later or contact Super Admin at ' +
          'saifullahfaizan786@gmail.com.';
        setTimeout(() => {
          window.location.href = '/admin/admin.html#dashboard';
        }, 2500);
        return;
      }

      // 2) USER with NO firm → truly new person
      if (user.role === 'USER' && !user.firmId) {
        statusEl.innerHTML =
          'First create a firm from the admin panel, then come back to this page to sign in as Firm Admin.';
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