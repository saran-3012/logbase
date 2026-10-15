'use strict';

const $ = (id) => document.getElementById(id);

function notice(message, kind = 'err') {
  const cls = kind === 'ok' ? 'note-ok' : kind === 'warn' ? 'note-warn' : 'note-err';
  $('auth-notice').innerHTML = `<div class="note ${cls}" style="margin-bottom:16px">
    <span>${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>
  </div>`;
}

function clearNotice() { $('auth-notice').innerHTML = ''; }

function switchTab(tab) {
  document.querySelectorAll('.auth-tabs button').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('register-form').classList.toggle('hidden', tab !== 'register');
  clearNotice();
}

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('authToken')) {
    window.location.href = '/dashboard.html';
    return;
  }

  document.querySelectorAll('.auth-tabs button')
    .forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ── Sign in ─────────────────────────────────────────────────────────── */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    clearNotice();

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('login-username').value.trim(),
          password: $('login-password').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign in failed');

      localStorage.setItem('authToken', data.token);
      localStorage.setItem('authUser', data.username);
      window.location.href = '/dashboard.html';
    } catch (err) {
      notice(err.message);
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  /* ── Register ────────────────────────────────────────────────────────── */
  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('reg-password').value;

    if (password !== $('reg-confirm').value) return notice('Passwords do not match');
    if (password.length < 8)                 return notice('Password must be at least 8 characters');

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Creating account…';
    clearNotice();

    try {
      const res = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('reg-username').value.trim(),
          email:    $('reg-email').value.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      const username = $('reg-username').value.trim();
      e.target.reset();
      switchTab('login');
      $('login-username').value = username;
      notice('Account created — sign in to continue.', 'ok');
    } catch (err) {
      notice(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Create account';
    }
  });
});
