// Session handling. The access token (JWT from login) and the refresh token are
// kept in sessionStorage, so they are gone when the tab closes. The access token
// is sent as "Authorization: Bearer <token>"; the api-gateway is the only
// component that verifies it (design decision D5).

const KEY = 'pap.session';

export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; }
}
export function getToken() { return getSession()?.token || null; }
export function currentUser() { return getSession()?.user || null; }
export function setSession(token, user, refreshToken) {
  const keep = refreshToken ?? getSession()?.refreshToken ?? null;
  try { sessionStorage.setItem(KEY, JSON.stringify({ token, user, refreshToken: keep })); } catch { /* storage blocked */ }
}
export function updateUser(patch) {
  const s = getSession();
  if (s) setSession(s.token, { ...s.user, ...patch }, s.refreshToken);
}
export function clearSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
export const is = {
  loggedIn: () => !!currentUser(),
  adopter: () => currentUser()?.role === 'adopter',
  staff: () => currentUser()?.role === 'staff',
  admin: () => currentUser()?.role === 'admin',
};
