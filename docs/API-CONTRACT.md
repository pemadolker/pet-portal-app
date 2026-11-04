# API contract (frontend ↔ api-gateway ↔ services)

This is the agreement between the website and the 13 backend services behind the
api-gateway. The services in `services/` implement it and `tests/integration/journey.test.js`
checks it end to end.

All ids are UUIDs. Times are ISO 8601 strings.

**Rules for every service**

- Base path through the gateway: `/api`. Example: the browser calls `/api/pets/pet-tashi`,
  the gateway forwards `GET /pets/pet-tashi` to `pet` service.
- JSON in, JSON out. Errors are always `{ "error": "Message a user can read" }` with the right HTTP status.
- Auth: `Authorization: Bearer <JWT>`. The **gateway** verifies it once and forwards
  `X-User-Id`, `X-User-Role`, `X-Shelter-Id` headers. Services trust those headers (design decision D5),
  so NetworkPolicy must stop anything except the gateway from calling them.
- Every response carries `X-Served-By: <service>` and `X-Pod: <pod>`; the website's request log shows them.
- Every service also exposes `GET /health` (liveness), `GET /ready` (database and Redis reachable)
  and `GET /metrics` (Prometheus). The gateway does not route these, and it refuses any `/internal/*` path.
- The gateway answers `429` when a rate limit is hit (per user, or per IP when logged out; stricter for
  `/login` and `/signup`) and `503` when the portal is in read-only maintenance mode.

JWT (RS256, 1 hour): `{ sub: userId, role: "adopter" | "staff" | "admin", shelter_id: uuid | null, iss: "pet-portal-login", aud: "pet-portal", exp, jti }`.

Status codes used: 200 OK, 201 Created, 204 No Content, 400 bad input, 401 not logged in,
403 wrong role, 404 not found, 409 conflict, 413 body too large, 429 too many requests,
502/503/504 a service is unavailable or slow.

---

## Gateway routing table

| Path prefix | Service | # |
|---|---|---|
| `/signup` | signup | 3 |
| `/login` | login | 4 |
| `/profile` | profile | 5 |
| `/pets` | pet | 6 |
| `/search` | search | 7 |
| `/shelters` | shelter | 8 |
| `/favorites` | favorites | 9 |
| `/adoptions` | adoption | 10 |
| `/reviews` | review | 11 |
| `/history` | history | 12 |
| `/notifications` | notification | 13 |
| (none, consumes `email.queue`) | email-worker | 14 |
| `/reports` | reporting | 15 |

frontend (1) and api-gateway (2) complete the 15.

---

## 3. signup

### `POST /signup` (public)
```json
{ "name": "Karma Wangmo", "email": "k@x.bt", "password": "min 8 chars",
  "role": "adopter" | "staff", "district": "Thimphu", "shelterName": "only when role=staff" }
```
201 → `{ "user": { "id", "email", "role", "shelterId", "name" } }`
409 if email exists. Passwords: 8 to 128 characters. A staff signup also creates a shelter with
`status: "pending"`. signup runs a saga over internal calls (shelter, then login, then profile)
and undoes the earlier steps if a later one fails.

## 4. login

### `POST /login` (public)
`{ "email", "password" }` → 200 `{ "token": "<JWT>", "refreshToken", "expiresIn": 3600, "user": { "id", "email", "role", "shelterId", "name" } }`
401 `That email and password do not match.` 429 after 5 wrong passwords (locked for 15 minutes).

### `POST /login/refresh` (public)
`{ "refreshToken" }` → 200, same shape as login, with a NEW refresh token (rotation).
Presenting an already-used refresh token revokes every token of that session (401).

### `POST /login/logout` (public)
`{ "refreshToken" }` → 204; the session's refresh tokens are revoked.

## 5. profile

### `GET /profile` (logged in)
→ `{ "userId", "name", "phone", "district", "homeType", "hasYard", "otherPets", "about", "email", "role" }`

### `PUT /profile` (logged in)
Body: any of `name, phone, district, homeType, hasYard, otherPets, about` → the updated profile.

## 6. pet

Pet object:
```json
{ "id", "name", "species": "dog|cat|rabbit|bird", "breed", "sex": "male|female",
  "ageMonths": 26, "size": "small|medium|large", "coat": "#b07a45", "description",
  "vaccinated": true, "neutered": true, "goodWith": ["adults","children","dogs","cats"],
  "imageUrl": "", "shelterId", "createdAt",
  "status": "available|pending|adopted", "shelterName": "joined for display" }
```
`status` and `shelterName` are not stored by pet: pet adds them from adoption and shelter when it
answers (`status` is `unknown` if adoption cannot be reached). `imageUrl` must be an https link or empty.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/pets?shelterId=` | public | list |
| GET | `/pets/:id` | public | 404 if missing |
| POST | `/pets` | staff of an approved shelter | 201, publishes **`pet.created`** `{petId, shelterId}` |
| PUT | `/pets/:id` | staff, own shelter | |
| DELETE | `/pets/:id` | staff, own shelter | 409 if an application is pending, 204 on success; publishes **`pet.deleted`** |

PUT publishes **`pet.updated`**.

## 7. search

### `GET /search` (public)
Query: `q, species, sex, size, age (young|adult|senior), shelterId, goodWith, status (default available, or all), sort (newest|youngest|oldest|name), limit`
→ `{ "total": 12, "items": [Pet, ...] }`
Built only from events: `pet.created`, `pet.updated`, `pet.deleted`, `availability.changed`, `shelter.updated`.
Pets of a rejected shelter are hidden. `limit` defaults to 60, at most 200.

## 8. shelter

Shelter: `{ "id", "name", "district", "address", "phone", "email", "about", "status": "pending|approved|rejected", "createdAt" }`

| Method | Path | Who |
|---|---|---|
| GET | `/shelters` | public, approved only |
| GET | `/shelters?status=pending` or `?status=all` | admin |
| GET | `/shelters/:id` | public |
| PUT | `/shelters/:id` | staff of that shelter |
| PATCH | `/shelters/:id/approval` `{status: "approved"|"rejected"}` | admin |

## 9. favorites

| Method | Path | Body / result |
|---|---|---|
| GET | `/favorites` | `["pet-tashi", ...]` |
| POST | `/favorites` | `{ "petId" }` → updated list |
| DELETE | `/favorites/:petId` | updated list |

## 10. adoption (hot path, the one-winner rule)

Application: `{ "id", "petId", "shelterId", "userId", "status": "submitted|approved|rejected", "message", "homeType", "hasYard", "otherPets", "experience", "createdAt", "decidedAt", "decisionNote" }`

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/adoptions/availability/:petId` | public | `{ petId, status, applicationId }` |
| POST | `/adoptions` | adopter | body `{ petId, message (≥20 chars), homeType (house, apartment, farm, other), hasYard, otherPets, experience }`; at most 5 open applications per adopter |
| GET | `/adoptions/mine` | adopter | applications, each with a joined `pet` |
| GET | `/adoptions/shelter` | staff | applications for own shelter, with `pet` and `applicant {name,email,phone}` |
| POST | `/adoptions/:id/decision` | staff | `{ decision: "approved"|"rejected", note }`, publishes **`application.decided`** |

`POST /adoptions` must run in ONE transaction:
```sql
UPDATE availability SET status = 'pending', application_id = $2
WHERE pet_id = $1 AND status = 'available';
-- 1 row  -> INSERT the application, return 201
-- 0 rows -> return 409 { "error": "...", "code": "PET_TAKEN" }
```
The website shows the "already has an application" screen on 409 with `code: "PET_TAKEN"`. This is what experiment E2 tests.
A partial unique index (one submitted or approved application per pet) guards the rule in the database too.

Decision: approved → availability `adopted`; rejected → back to `available`. Deciding twice → 409.
Availability values: `available`, `pending`, `adopted`, `removed` (the pet was deleted).

`application.decided` payload:
`{ applicationId, petId, petName, shelterId, shelterName, userId, userEmail, userName, decision, note, createdAt, decidedAt }`

## 11. review

| Method | Path | Who | Result |
|---|---|---|---|
| GET | `/reviews?shelterId=` | public | `{ average: 4.5, count: 2, items: [{id, shelterId, userId, authorName, rating, comment, createdAt}] }` |
| POST | `/reviews` | adopter | `{ shelterId, rating 1-5, comment }` → 201 review. One review per adopter per shelter: posting again updates it. Author shown as first name and initial. |

## 12. history

### `GET /history` (logged in)
→ `[{ id, userId, applicationId, petId, petName, shelterId, shelterName, outcome, at }]`
Built only from `application.decided` events.

## 13. notification

| Method | Path | Result |
|---|---|---|
| GET | `/notifications` | `{ unread: 1, items: [{ id, userId, title, body, link, read, createdAt }] }` |
| POST | `/notifications/:id/read` | the notification |
| POST | `/notifications/read-all` | `{ unread: 0 }` |

Consumes `application.decided`, writes an in-app message and adds `{to, subject, body}` to **`email.queue`**.

## 14. email-worker

No HTTP API (only `/health`, `/ready` and `/metrics`). Reads `email.queue`, sends to Mailpit over SMTP at most
`SMTP_RATE_PER_SECOND` per pod, retries on failure, publishes `email.sent`. KEDA scales it on the consumer group's lag.

## 15. reporting

### `GET /reports/summary` (staff: own shelter, admin: everything)
```json
{ "scope": "Thimphu Animal Rescue",
  "pets": { "total": 6, "byStatus": { "available": 5, "pending": 1 }, "bySpecies": { "dog": 4, "cat": 2 } },
  "applications": { "total": 2, "byStatus": { "submitted": 1, "approved": 1 }, "averageDecisionDays": 2.5 },
  "shelters": { "approved": 3, "pending": 1 },
  "emailsSent": 3 }
```
`shelters` only for admin. Built only from events (pet.*, availability.changed, application.submitted,
application.decided, shelter.updated, email.sent).

---

## Event streams (Redis Streams)

| Stream | Producer | Consumers (one consumer group each) |
|---|---|---|
| `pet.created` | pet | search, adoption, reporting |
| `pet.updated` | pet | search, reporting |
| `pet.deleted` | pet | search, adoption, favorites, reporting |
| `shelter.updated` | shelter | search, reporting |
| `availability.changed` | adoption | search, reporting |
| `application.submitted` | adoption | reporting |
| `application.decided` | adoption | notification, history, reporting |
| `email.queue` | notification | email-worker |
| `email.sent` | email-worker | reporting |

Each entry has the fields `id`, `type`, `data` (the JSON envelope `{ id, type, occurredAt, producer, data }`)
and `traceparent` (so the trace continues in the consumer). Delivery is at least once: producers use a
transactional outbox, consumers record processed ids in the same transaction as their own writes, and a
message that fails 5 times moves to `<stream>.dlq`. `availability.changed` carries a `version`; read
models ignore versions older than the one they hold, so events may arrive in any order.

## Internal routes (service to service only; the gateway refuses them)

| Service | Route | Caller |
|---|---|---|
| login | `POST /internal/credentials`, `DELETE /internal/credentials/:userId` | signup |
| profile | `POST /internal/profiles`, `GET /internal/profiles/:userId`, `GET /internal/profiles?ids=` | signup, login, adoption, review |
| shelter | `POST /internal/shelters`, `DELETE /internal/shelters/:id` (pending only), `GET /internal/shelters?ids=` | signup, pet, adoption, review |
| pet | `GET /internal/pets?ids=` | adoption |
| adoption | `GET /internal/availability?petIds=` | pet |
