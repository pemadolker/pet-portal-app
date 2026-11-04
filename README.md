# pet-portal-app

The Pet Adoption Portal's code: the website and the 14 backend containers (13
services and the api-gateway). 15 microservices in all, each a small container with
`/health`, `/ready` and `/metrics`, JSON logs carrying a trace id, and its own
PostgreSQL schema and role.

DSO202 final project, College of Science and Technology. Team: Dechen Wangdra Sherpa,
Tandin Zangmo, Pema Dolker. Deployment (Helm, Argo CD, KEDA, monitoring) lives in
the second repository, **pet-portal-config**.

There is no demo or seed data anywhere. The first admin comes from a Secret;
shelters register through the website and wait for approval; staff list real pets.

## The 15 services

| # | Service | Owns (schema / stream) | Calls | Events |
|---|---|---|---|---|
| 1 | frontend | static site (nginx) | api-gateway (through the Ingress) | |
| 2 | api-gateway | rate-limit counters (Redis) | all 12 routed services, via the etcd registry | |
| 3 | signup | `signup.registrations` (audit) | shelter, login, profile (saga with compensation) | |
| 4 | login | `login.credentials`, `login.refresh_tokens` | profile | |
| 5 | profile | `profile.profiles` | | |
| 6 | pet | `pet.pets` | adoption, shelter | publishes pet.created / pet.updated / pet.deleted |
| 7 | search | `search.*` read model | | consumes pet.*, availability.changed, shelter.updated |
| 8 | shelter | `shelter.shelters` | | publishes shelter.updated |
| 9 | favorites | `favorites.favorites` | | consumes pet.deleted |
| 10 | adoption | `adoption.availability`, `adoption.applications` | pet, shelter, profile | publishes availability.changed, application.submitted, application.decided; consumes pet.created, pet.deleted |
| 11 | review | `review.reviews` | shelter, profile | |
| 12 | history | `history.entries` | | consumes application.decided |
| 13 | notification | `notification.notifications` | | consumes application.decided; publishes email.queue |
| 14 | email-worker | (Redis only) | Mailpit over SMTP | consumes email.queue; publishes email.sent |
| 15 | reporting | `reporting.*` read model | | consumes pet.*, availability.changed, application.*, shelter.updated, email.sent |

The routes are in `docs/API-CONTRACT.md`.

## How it is built

* **One template, 14 times.** `libs/common/` gives every service the same HTTP layer
  (routing, JSON errors, 64 KB body limit, probes, metrics, graceful shutdown), the
  PostgreSQL pool and migrations, Redis Streams, the etcd registry client, tracing
  and logging. A service is one `src/server.js` plus `migrations/*.sql`. One
  `Dockerfile` builds any of them: `--build-arg SERVICE=<name>`.
* **The one-winner rule** (`services/adoption/src/server.js`): applying is one
  conditional `UPDATE availability ... WHERE status = 'available'` in a transaction.
  PostgreSQL serialises updates of the same row, so exactly one wins however many pods
  run. A partial unique index on applications is a second guard in the database itself.
* **No lost or doubled events.** Producers write events into an `outbox` table in the
  same transaction as the change; a relay sends them to Redis. Consumers record
  processed event ids in the same transaction as their own writes, so redelivery does
  nothing. Failing messages retry, then go to `<stream>.dlq`.
* **Security.** The gateway is the only door: it strips client-sent identity headers,
  verifies RS256 JWTs (it holds only the public key), applies rate limits shared in
  Redis, and refuses `/internal/*`. Passwords are scrypt (OWASP parameters), refresh
  tokens rotate and reuse revokes the session family, five wrong passwords lock the
  account for 15 minutes. All SQL is parameterised. The website has a strict
  Content-Security-Policy. Containers run as non-root with read-only filesystems.
* **Registry.** Services register their pod address in etcd with a 15 s lease; the
  gateway watches it and routes round-robin, falling back to Kubernetes Service DNS if
  etcd is unavailable. The gateway also watches live settings (rate limits, read-only
  maintenance mode) in etcd.
* **Telemetry.** Every request is a trace (OpenTelemetry: http, fetch, pg, ioredis,
  and across Redis Streams through a `traceparent` field on each event); every log line
  carries its trace id; every service exposes the same RED metrics.

## Run it locally

With Docker:
```bash
./local/setup.sh                                   # passwords + JWT keys into local/.secrets (git-ignored)
docker compose -f local/docker-compose.yml --env-file local/.secrets/.env up --build
# website  http://localhost:8000     mail inbox  http://localhost:8025
# admin login: see local/.secrets/.env (ADMIN_EMAIL / ADMIN_PASSWORD)
```

## Tests

```bash
npm ci
npm test                                           # unit tests (shared library)
BASE_URL=http://localhost:8000/api ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:integration
node tests/load/one-winner.mjs --base http://localhost:8000/api --users 2000 --pets 10   # E2 without k6
node tests/e2e/browser.mjs --url http://localhost:8000 --out shots/                       # browser journey + screenshots (needs playwright)
```
`tests/integration/journey.test.js` walks the whole adoption journey through the
gateway (12 checks, including forged headers, refresh-token reuse and compensation on
a failed signup). CI runs unit tests, the journey test and a 300-user one-winner race
against docker compose on every push, then builds, scans and pushes the images and
updates pet-portal-config (`.github/workflows/ci.yml`).

## Layout

```
frontend/              service 1: the website (no build step; nginx-unprivileged image)
services/<name>/       src/server.js and migrations/*.sql for services 2-15
libs/common/           shared library (http, db, migrate, events, registry, client, metrics, tracing, logger)
db/bootstrap.sh        creates the 12 roles and schemas (also used by the cluster's db-bootstrap Job)
local/                 docker compose for development and CI
tests/                 unit, integration (journey), load (one-winner), e2e (browser)
scripts/build-images.sh  build all 15 images; load them into Kind or push them
Dockerfile             one image recipe for every Node service
```

## Configuration (environment variables)

| Variable | Used by | Meaning |
|---|---|---|
| `SERVICE_NAME`, `PORT`, `DEPLOY_ENV`, `LOG_LEVEL` | all | identity, port (8080), environment, log level |
| `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `DB_SCHEMA`, `DB_POOL_MAX` | services with a schema | own role and schema only |
| `REDIS_URL` | services with events, gateway | Redis Streams and rate limits |
| `ETCD_ENDPOINTS` | all | registry members (comma separated) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG` | all | where traces go; ratio of new traces |
| `<SERVICE>_URL` | callers | for example `SHELTER_URL=http://shelter:8080` |
| `JWT_PRIVATE_KEY_FILE` / `JWT_PUBLIC_KEY_FILE` | login / gateway | RS256 key pair |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | signup | first admin, created once |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_RATE_PER_SECOND` | email-worker | mail server and per-pod send limit |
| `SCRYPT_LOG_N`, `SCRYPT_P` | login | password hashing cost (defaults: 13, 10) |
