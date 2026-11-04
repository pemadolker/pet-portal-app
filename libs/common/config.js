'use strict';
// Reads configuration from environment variables (set by the Helm chart from
// ConfigMaps and Secrets). A missing required value stops the process at start-up,
// so a bad release fails its readiness probe instead of serving errors.

const fs = require('node:fs');

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function envInt(name, fallback) {
  const v = Number.parseInt(env(name, fallback === undefined ? undefined : String(fallback)), 10);
  if (Number.isNaN(v)) throw new Error(`Environment variable ${name} must be a number`);
  return v;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// Secrets can be given as NAME or as NAME_FILE (a path to a mounted Secret file).
function secret(name, fallback) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env(name, fallback);
}

const service = {
  name: env('SERVICE_NAME'),
  version: env('SERVICE_VERSION', 'dev'),
  port: envInt('PORT', 8080),
  environment: env('DEPLOY_ENV', 'local'),
  podName: env('POD_NAME', require('node:os').hostname()),
  podIp: env('POD_IP', '127.0.0.1'),
  namespace: env('POD_NAMESPACE', 'local'),
};

module.exports = { env, envInt, envBool, secret, service };
