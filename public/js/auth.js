'use strict';

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.getElementById('alert-msg').classList.add('hidden');
}

function showAlert(msg, type = 'error') {
  const el = document.getElementById('alert-msg');
  el.textContent = msg;
  el.className = `alert alert-${type}`;
  el.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  // Already signed in → go to dashboard
  if (localStorage.getItem('authToken')) {
    window.location.href = '/dashboard.html';
    return;
  }

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  /* ── Login ── */
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn      = e.target.querySelector('button[type="submit"]');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    btn.disabled    = true;
    btn.textContent = 'Signing in…';

    try {
      const res  = await fetch('/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('authToken', data.token);
      localStorage.setItem('authUser',  data.username);
      window.location.href = '/dashboard.html';
    } catch (err) {
      showAlert(err.message);
      btn.disabled    = false;
      btn.textContent = 'Sign In';
    }
  });

  /* ── Register ── */
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn       = e.target.querySelector('button[type="submit"]');
    const username  = document.getElementById('reg-username').value.trim();
    const email     = document.getElementById('reg-email').value.trim();
    const password  = document.getElementById('reg-password').value;
    const confirmPw = document.getElementById('reg-confirm').value;

    if (password !== confirmPw) { showAlert('Passwords do not match'); return; }
    if (password.length < 8)   { showAlert('Password must be at least 8 characters'); return; }

    btn.disabled    = true;
    btn.textContent = 'Creating account…';

    try {
      const res  = await fetch('/auth/register', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      showAlert('Account created! You can now sign in.', 'success');
      switchTab('login');
      document.getElementById('login-username').value = username;
      e.target.reset();
    } catch (err) {
      showAlert(err.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Create Account';
    }
  });
});
