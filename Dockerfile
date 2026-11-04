# syntax=docker/dockerfile:1.7
# One Dockerfile for all 14 Node services (13 backend services + api-gateway).
# Every service shares one template (proposal section 10), so one chart and one
# image recipe fit all of them:
#
#   docker build --build-arg SERVICE=adoption --build-arg VERSION=$(git rev-parse --short HEAD) \
#                -t ghcr.io/<team>/pet-portal/adoption:$(git rev-parse --short HEAD) .
#
# The frontend has its own Dockerfile in frontend/.
# Pin the base image by digest in CI (Renovate/Dependabot keeps it current).

ARG NODE_IMAGE=node:22-alpine

# ---- dependencies (production only, no install scripts) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE}
ARG SERVICE
ARG VERSION=dev
RUN test -n "${SERVICE}" || (echo "build with --build-arg SERVICE=<name>" && false)

LABEL org.opencontainers.image.title="pet-portal/${SERVICE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/<team>/pet-portal-app"

ENV NODE_ENV=production \
    SERVICE_NAME=${SERVICE} \
    SERVICE_VERSION=${VERSION} \
    PORT=8080 \
    MIGRATIONS_DIR=/app/service/migrations

WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root libs ./libs
COPY --chown=root:root services/${SERVICE} ./services/${SERVICE}
# A fixed path so the chart does not need to know the service's folder name.
RUN ln -s /app/services/${SERVICE} /app/service

# Files are owned by root and read-only to the app user; the root filesystem is
# also mounted read-only in Kubernetes (securityContext in the chart).
USER node
EXPOSE 8080
# For docker compose; Kubernetes uses the chart's probes instead.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tracing.js is preloaded so http, fetch, pg, ioredis and pino are instrumented.
ENTRYPOINT ["node", "--require", "/app/libs/common/tracing.js"]
CMD ["/app/service/src/server.js"]
# Migrations (Helm PreSync Job):  command: ["node", "/app/libs/common/migrate.js"]
