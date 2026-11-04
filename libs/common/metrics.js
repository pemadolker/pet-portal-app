'use strict';
// Prometheus metrics. Every service exposes the same RED metrics so one Grafana
// dashboard works for all 15, and KEDA can scale adoption on
//   sum(rate(http_requests_total{service="adoption"}[1m]))
// The `service`, `namespace` and `pod` labels are added by Prometheus from the
// ServiceMonitor target, so the metrics themselves do not repeat them.

const client = require('prom-client');
const { service } = require('./config');

const registry = new client.Registry();
registry.setDefaultLabels({ app_version: service.version });
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled, by route template and status code.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by route template.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const httpInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being handled.',
  registers: [registry],
});

const eventsPublished = new client.Counter({
  name: 'events_published_total',
  help: 'Events written to Redis Streams.',
  labelNames: ['stream'],
  registers: [registry],
});

const eventsConsumed = new client.Counter({
  name: 'events_consumed_total',
  help: 'Events read from Redis Streams, by outcome (processed, duplicate, failed, dead_lettered).',
  labelNames: ['stream', 'outcome'],
  registers: [registry],
});

const eventLag = new client.Gauge({
  name: 'event_consumer_lag',
  help: 'Entries in the stream not yet delivered to this consumer group.',
  labelNames: ['stream', 'group'],
  registers: [registry],
});

const eventPending = new client.Gauge({
  name: 'event_consumer_pending',
  help: 'Entries delivered to this consumer group but not yet acknowledged.',
  labelNames: ['stream', 'group'],
  registers: [registry],
});

function counter(name, help, labelNames = []) {
  return new client.Counter({ name, help, labelNames, registers: [registry] });
}
function gauge(name, help, labelNames = []) {
  return new client.Gauge({ name, help, labelNames, registers: [registry] });
}
function histogram(name, help, labelNames = [], buckets) {
  return new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });
}

module.exports = {
  registry, httpRequests, httpDuration, httpInFlight,
  eventsPublished, eventsConsumed, eventLag, eventPending,
  counter, gauge, histogram,
};
