// Log in. Data: login-service (POST /login returns a JWT and the user).
import { api } from '../api.js';
import { setSession } from '../auth.js';
import { $ } from '../ui.js';
import { resetFavorites } from '../favorites.js';

export default async function login({ main, query }) {
  const next = query.next && query.next.startsWith('#/') ? query.next : '';
  main.innerHTML = `<div class="auth">
    <div class="auth-side">
      <div>
        <h2>Welcome back</h2>
        <p>Log in to save pets, apply to adopt and follow your applications.</p>
      </div>
    </div>
    <div class="auth-form"><div class="inner">
      <h1 style="font-size:2rem">Log in</h1>
      <form id="loginForm" novalidate>
        <p class="form-error" id="err"></p>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required autofocus></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" type="submit" style="width:100%">Log in</button>
      </form>
      <p class="muted" style="margin-top:20px">New here? <a href="#/signup${next ? '?next=' + encodeURIComponent(next) : ''}">Create an account</a></p>
    </div></div>
  </div>`;

  const form = $('#loginForm', main);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err', main);
    err.textContent = '';
    if (!form.email.value || !form.password.value) { err.textContent = 'Enter your email and password.'; return; }
    try {
      const { token, user, refreshToken } = await api.post('/login', { email: form.email.value, password: form.password.value });
      setSession(token, user, refreshToken);
      resetFavorites();
      const home = { staff: '#/staff', admin: '#/admin' }[user.role] || '#/pets';
      location.hash = next || home;
      window.dispatchEvent(new Event('session-changed'));
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}
