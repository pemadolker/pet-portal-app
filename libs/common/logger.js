'use strict';
// JSON logs on stdout. Alloy ships them to Loki. The pino OpenTelemetry
// instrumentation (loaded in tracing.js) adds trace_id and span_id to every line,
// which is what lets Grafana jump from a log line to its trace in Tempo.

const pino = require('pino');
const { service } = require('./config');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: service.name, version: service.version, env: service.environment, pod: service.podName },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['password', '*.password', 'req.headers.authorization', 'token', 'refreshToken', '*.token', '*.refreshToken'],
    censor: '[redacted]',
  },
});

module.exports = { logger };
