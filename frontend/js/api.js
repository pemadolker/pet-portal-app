// The ONLY place the frontend talks to the backend.
// Pages call api.get('/pets/123') etc. Every call goes to the api-gateway at
// `${apiBase}` (for example /api/pets/123), which the Ingress routes to the
// api-gateway Service.
//
// Sessions: login returns a short-lived access token (1 h) and a refresh token.
// When a call gets 401 and we have a refresh token, we swap it for a new pair
// once (POST /login/refresh) and retry the call. Parallel 401s share one refresh.

import { getSession, setSession, clearSession } from './auth.js';

const cfg = window.__PORTAL_CONFIG__ || { apiBase: '/api', environment: 'unknown' };

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

/* request log, shown in the footer drawer: which service and pod answered each call */
const log = [];
const listeners = new Set();
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLog() { return log; }
function push(entry) { log.unshift({ at: Date.now(), ...entry }); if (log.length > 100) log.pop(); listeners.forEach((f) => f(log)); }

async function send(method, path, body, token) {
  const started = performance.now();
  let res;
  try {
    const r = await fetch(cfg.apiBase + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    if (r.status !== 204) { try { data = await r.json(); } catch { data = null; } }
    res = { status: r.status, data, service: r.headers.get('X-Served-By') || 'api-gateway', pod: r.headers.get('X-Pod') || '' };
  } catch {
    res = { status: 0, data: { error: 'Cannot reach the server. Check your connection and try again.' }, service: 'api-gateway', pod: '' };
  }
  push({ type: 'call', method, path, status: res.status, service: res.service, pod: res.pod, ms: Math.round(performance.now() - started) });
  return res;
}

let refreshing = null;
function refresh() {
  const s = getSession();
  if (!s?.refreshToken) return Promise.resolve(false);
  refreshing ||= send('POST', '/login/refresh', { refreshToken: s.refreshToken })
    .then((r) => {
      if (r.status === 200) { setSession(r.data.token, r.data.user, r.data.refreshToken); return true; }
      return false;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function request(method, path, body) {
  let res = await send(method, path, body, getSession()?.token);
  const isAuthCall = path.startsWith('/login');
  if (res.status === 401 && getSession() && !isAuthCall) {
    if (await refresh()) res = await send(method, path, body, getSession()?.token);
    if (res.status === 401) {
      clearSession();
      window.dispatchEvent(new Event('session-changed'));
    }
  }
  if (res.status === 0 || res.status >= 400) {
    throw new ApiError(res.status, res.data?.error || `Request failed (${res.status})`, res.data);
  }
  return res.data;
}

export async function logout() {
  const s = getSession();
  clearSession();
  if (s?.refreshToken) await send('POST', '/login/logout', { refreshToken: s.refreshToken }).catch(() => {});
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b || {}),
  put: (p, b) => request('PUT', p, b || {}),
  patch: (p, b) => request('PATCH', p, b || {}),
  del: (p) => request('DELETE', p),
};

export const config = cfg;
