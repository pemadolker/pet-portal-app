// Runtime configuration for the frontend.
//   apiBase     where the api-gateway is reached (the Ingress sends /api to it)
//   environment shown in the footer badge (dev / prod)
//   mailUrl     optional link to the Mailpit inbox for the admin page
// In Kubernetes a ConfigMap is mounted over /usr/share/nginx/html/config.js, so the
// same image runs in pet-portal-dev and pet-portal-prod without a rebuild.
window.__PORTAL_CONFIG__ = window.__PORTAL_CONFIG__ || {
  apiBase: '/api',
  environment: 'local',
  mailUrl: '',
};
