'use strict';
// OpenTelemetry tracing. Loaded before anything else with `node --require`,
// so the http, undici (fetch), pg, ioredis and pino modules are patched when
// the service first requires them.
//
// Spans are sent over OTLP/HTTP to the OpenTelemetry Collector, which samples
// and forwards them to Tempo. If OTEL_EXPORTER_OTLP_ENDPOINT is not set (for
// example in unit tests) tracing stays off and costs nothing.

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') {
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
  const { PinoInstrumentation } = require('@opentelemetry/instrumentation-pino');

  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG || '1');
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.SERVICE_NAME || 'unknown',
      [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION || 'dev',
      'deployment.environment.name': process.env.DEPLOY_ENV || 'local',
      'k8s.namespace.name': process.env.POD_NAMESPACE || 'local',
      'k8s.pod.name': process.env.POD_NAME || require('node:os').hostname(),
    }),
    // Respect the caller's decision; sample new root traces at OTEL_TRACES_SAMPLER_ARG.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }))],
  });
  provider.register();

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // Probes and scrapes would drown the real traffic in Tempo.
        ignoreIncomingRequestHook: (req) => /^\/(health|ready|metrics)/.test(req.url || ''),
      }),
      new UndiciInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({
        // XREADGROUP BLOCK polls every few seconds; tracing them is noise.
        requireParentSpan: true,
      }),
      new PinoInstrumentation(),
    ],
  });

  const shutdown = () => provider.shutdown().catch(() => {});
  process.once('beforeExit', shutdown);
  module.exports = { enabled: true, shutdown };
} else {
  module.exports = { enabled: false, shutdown: async () => {} };
}
