'use strict';
// Errors that turn into JSON responses: { "error": "Message a user can read" }.

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const need = (cond, status, message, extra) => { if (!cond) fail(status, message, extra); };

// The gateway verified the JWT and forwarded the user as headers (design decision D5).
function requireUser(user) {
  need(user, 401, 'Log in to continue.');
  return user;
}
function requireRole(user, ...roles) {
  requireUser(user);
  need(roles.includes(user.role), 403, 'Your account cannot do this.');
  return user;
}

module.exports = { HttpError, fail, need, requireUser, requireRole };
