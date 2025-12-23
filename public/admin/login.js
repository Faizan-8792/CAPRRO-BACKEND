// login.js - sirf index.html ke liye

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
  const headers = Object.assign({
    'Content-Type': 'application/json',
  }, opts?.headers);

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
    // ignore
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
  return user.role === 'SUPERADMIN' || user.email === 'saifullahfaizan786@gmail.com';
}

// ---------- Login page (index.html) ----------
async function initLoginPage() {
  const sendOtpBtn = document.getElementById('sendOtp');
  if (!sendOtpBtn) return;

  const emailEl = document.getElementById('email');
  const otpEl = document.getElementById('otp');
  const statusEl = document.getElementById('status');
  const otpBlock = document.getElementById('otpBlock');
  const goVerify = document.getElementById('goVerify');
  const verifyBtn = document.getElementById('verifyOtp');

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
      if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to send OTP');
      otpBlock.style.display = 'block';
      statusEl.textContent = 'OTP sent. Check your email.';
    } catch (e) {
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
      if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to verify OTP');
      saveToken(data.token);
      const me = await api('/auth/me');
      const user = me.user;

      if (isSuperAdmin(user)) {
        statusEl.innerHTML = '<strong>Super Admin login successful</strong>';
        setTimeout(() => window.location.href = './super.html', 1000);
        return;
      }

      if (user.role === 'FIRM_ADMIN' && user.isActive === true) {
        statusEl.innerHTML = '<strong>Firm Admin login successful</strong>';
        setTimeout(() => window.location.href = './admin.html#dashboard', 1000);
        return;
      }

      if (user.role === 'FIRM_ADMIN' && user.isActive === false) {
        statusEl.innerHTML = '<strong>Successfully signed up for Firm Admin!</strong><br><small class="text-muted">Your request is now pending Super Admin approval. Check back later or contact Super Admin [saifullahfaizan786@gmail.com](mailto:saifullahfaizan786@gmail.com).</small>';
        setTimeout(() => window.location.href = './admin.html#dashboard', 3000);
        return;
      }

      clearToken();
      statusEl.innerHTML = '<strong>Admin request submitted</strong><br><small class="text-muted">To become Firm Admin, create a firm from Chrome extension first, then return here.</small>';
    } catch (e) {
      statusEl.textContent = e.message || 'Login failed.';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initLoginPage();
});
