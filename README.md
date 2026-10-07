# mosqai-backend

The central source of truth for MosqAI Shield. It authenticates users and
devices, ingests device telemetry over MQTT, sends commands and records their
**confirmed** results, receives images, dispatches AI jobs, stores results,
computes analytics and alerts, and serves the mobile app and authority web over
REST and WebSockets.

Owners: both developers. See the
[architecture](https://github.com/MosqAI/mosqai-docs/blob/develop/architecture.md).

## Technology

Node.js 22 · NestJS · TypeScript · PostgreSQL · Prisma · MQTT (mqtt.js) · REST · WebSockets · Jest

## Setup

> Not scaffolded yet. This is the first M1 issue ("Initialize backend").

Planned:

```bash
pnpm install
cp .env.example .env          # fill in local values
docker compose -f ../mosqai-infrastructure/compose.dev.yml up -d   # postgres + mosquitto
pnpm prisma migrate dev
pnpm start:dev
```

## Environment variables

See [`.env.example`](.env.example). Never commit `.env`.

## Development

Code is organised as NestJS feature modules: `auth`, `users`, `devices`,
`telemetry`, `commands`, `images`, `ai`, `alerts`, `analytics`, `areas`,
`audit`. Each Prisma schema change ships as its own small PR with a new
migration. Destructive DB commands (`migrate reset`, `db push --force-reset`)
need explicit team approval.

## Testing

Unit tests are Jest. Integration tests run against Postgres + Mosquitto from the
dev compose file. Priority coverage: auth, device registration, heartbeat,
offline detection, command acknowledgement and timeout, permissions.

## Deployment

Docker image built by CI and deployed via `mosqai-infrastructure`. Migrations run
as a separate release step (`prisma migrate deploy`).

## Contribution workflow

Branch from `develop` (`feature/…`, `fix/…`, `refactor/…`), use Conventional
Commits, open a PR into `develop`, one approval. Full rules:
[mosqai-docs/workflow.md](https://github.com/MosqAI/mosqai-docs/blob/develop/workflow.md).
