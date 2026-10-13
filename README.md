# mosqai-backend

The central source of truth for MosqAI Shield. It authenticates users and
devices, ingests device telemetry over MQTT, sends commands and records their
**confirmed** results, receives images, dispatches AI jobs, stores results,
computes analytics and alerts, and serves the mobile app and authority web over
REST and WebSockets.

Owner: `@MosqAI/core` team (RavynX0, Hope664). The `ai` module is co-owned with `@MosqAI/ai`. See the
[architecture](https://github.com/MosqAI/mosqai-docs/blob/develop/architecture.md).

## Technology

Node.js 22 · NestJS 12 (ESM) · TypeScript · PostgreSQL · Prisma 7 · MQTT (mqtt.js) · REST · Vitest

## Setup

```bash
pnpm install                  # also runs prisma generate
cp .env.example .env
```

Then start Postgres and an MQTT broker, either way:

| | With Docker (planned) | Without Docker |
| --- | --- | --- |
| Postgres | `docker compose -f ../mosqai-infrastructure/compose.dev.yml up -d` | `pnpm dev:db`, put its **TCP** URL in `DATABASE_URL`, set `DATABASE_POOL_MAX=1` |
| MQTT | same compose file | `pnpm dev:broker` (in-process Aedes, localhost only, no TLS) |

```bash
pnpm db:migrate               # apply migrations
pnpm db:seed                  # dev data: wipes the database first
pnpm start:dev                # API on PORT, routes under /v1, health at /health
pnpm simulate --fleet         # simulated devices: heartbeats + command acks
```

Seeded accounts all use the dev password `MosqAI-dev-2026`: `admin@rha.gov.rw`
(ADMIN), `jean@rha.gov.rw` (AUTHORITY_ADMIN), `aline@rha.gov.rw` (AUTHORITY_VIEWER),
and `owner@example.com` (OWNER of MSQ-001 and MSQ-002, for the mobile app).

## API (prefix `/v1`)

| Route | Who | Notes |
| --- | --- | --- |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | anyone / signed in | JWT access token + rotating refresh token; reusing a revoked refresh token revokes all of that user's tokens |
| `GET /devices`, `/devices/:id`, `/devices/:id/syncs` | all roles | Owners see only their devices; owner identity is never returned |
| `POST`, `GET /devices/:id/commands` | the device's owner, ADMIN | `SENT` is not success: only a device ack makes a command `CONFIRMED` |
| `GET /areas`, `/analytics/summary`, `/analytics/trend`, `/analytics/area-days`, `/analytics/hourly`, `/analytics/insights?days=7` | authority roles | Area-days with no reporting device are `captures: null` (NO_DATA), never 0 |
| `GET /alerts`, `POST /alerts/:id/acknowledge`, `/alerts/:id/dismiss` | authority roles (changes: AUTHORITY_ADMIN, ADMIN) | |
| `GET /reports` | authority roles | |
| `GET /users` | AUTHORITY_ADMIN, ADMIN | Staff only |

Response shapes match `mosqai-authority-web/src/lib/types.ts`. The insight rules in
`src/analytics/insights.ts` are a copy of the web's `src/lib/analytics.ts` and must
stay in sync until they move to a shared package.

## Devices and MQTT

Topics and payloads follow `mosqai-docs/contracts/mqtt.md`, **which is still a v0
DRAFT**. The backend subscribes to `status`, `heartbeat`, `state` and
`commands/ack`, and publishes to `commands`.

- A heartbeat marks the device ONLINE. No heartbeat for `DEVICE_HEARTBEAT_TIMEOUT_S`
  marks it OFFLINE, raises an alert and sets the battery to unknown (`null`).
- Commands go PENDING → SENT → CONFIRMED / FAILED / REJECTED, or TIMED_OUT after
  `COMMAND_ACK_TIMEOUT_S`. The device's reported `actual_state` becomes the
  confirmed state; the backend never assumes a command worked.
- Messages are processed one at a time, in arrival order.
- Not yet built: per-device MQTT credentials and ACLs, image upload, AI dispatch,
  the capture rollup job (the seed writes `capture_days` directly), WebSockets.

## Camera traps and the AI service (Phase A)

Phase A traps are an ESP32-CAM only: it posts a frame to `mosqai-ai` about every
hour and has no MQTT link. The AI service logs every frame to Supabase
(`trap_analytics_log`), and `src/ai-import` polls that log every
`AI_IMPORT_INTERVAL_S`:

- A device is linked to a camera by `cameraId` (the camera's `trap_id`). The seed
  links MSQ-001 to `TRAP-PROTOTYPE-01`.
- Frames keep the device ONLINE; none for `CAMERA_OFFLINE_AFTER_S` marks it OFFLINE.
  The MQTT heartbeat sweep skips camera-linked devices.
- Frames with new mosquitoes become captures. The model counts but doesn't identify
  species, so the count goes to `capture_days.unidentified`: part of every total,
  never shown as a species. Photos link to Cloudinary (`CLOUDINARY_CLOUD_NAME`).
- Remote control (power, fan, UV, schedules) needs a controller board that Phase A
  doesn't have; the apps show those features as under development.

## Environment variables

See [`.env.example`](.env.example). Never commit `.env`.

## Development

Code is organised as NestJS feature modules (`auth`, `devices`, `telemetry`,
`commands`, `analytics`, `alerts`, …). Each Prisma schema change ships as its own
small PR with a new migration. Destructive DB commands (`migrate reset`,
`db push --force-reset`) need explicit team approval.

## Testing

`pnpm test` runs unit tests. `pnpm test:e2e` runs the full device loop against the
database in `DATABASE_URL` with an in-process MQTT broker: auth and token rotation,
access control, heartbeat ingestion, offline detection, command confirmation and
timeout, and NO_DATA analytics. E2E fixtures use `E2E-` ids and are removed
afterwards.

## Deployment

[`render.yaml`](render.yaml) deploys the API to Render (free plan) from a Blueprint.
The database is Postgres on Supabase: use the **Session pooler** connection string
with `?schema=backend` appended, so our tables stay out of Supabase's API-exposed
`public` schema. Migrations run at start (`prisma migrate deploy`).

## Contribution workflow

Branch from `develop` (`feature/…`, `fix/…`, `refactor/…`), use Conventional
Commits, open a PR into `develop`, one approval. Full rules:
[mosqai-docs/workflow.md](https://github.com/MosqAI/mosqai-docs/blob/develop/workflow.md).
