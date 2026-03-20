# CLAUDE.md — Forge Engine Implementation Guide

> **Read this file first before reading any other file in this project.**
> This is the master index for all implementation documentation.

---

## Project: Forge Engine

A self-hostable **Distributed Job Scheduler & Workflow Engine** built entirely in **TypeScript / Node.js**.

**Stack**: TypeScript, Fastify, KafkaJS, ioredis, Redlock, Prisma, PostgreSQL, React (Vite)

---

## CRITICAL RULES — NEVER VIOLATE

1. **RULE-1**: API Service never directly triggers workers. Write to Postgres → emit to Kafka. That is all.
2. **RULE-2**: Workers never directly update Postgres. They emit Kafka events only.
3. **RULE-3**: Orchestrator is the **only** service that writes workflow step state to Postgres.
4. **RULE-4**: Every Redis lock **must** have a TTL. A lock without TTL is a bug.
5. **RULE-5**: Always write to Postgres **before** producing to Kafka (durability guarantee).
6. **RULE-6**: Kafka consumer groups + Redlock together prevent duplicate job execution.

**DO NOT** add: Python, Go, Prometheus, Grafana, GraphQL, WebSockets, drag-and-drop UI.

---

## Implementation Order (Follow Exactly)

> **IMPORTANT**: After completing each step, run the corresponding `git commit` command from `docs/12_git_workflow.md` before moving to the next step. Do NOT batch commits.

```
Step 0   →  docs/12_git_workflow.md          Read this first — git init + commit order
Step 1   →  docs/01_project_setup.md         Monorepo, tsconfig, docker-compose
Step 2   →  docs/02_database_and_prisma.md   Prisma schema, all 8 models, seed
Step 3   →  docs/03_shared_packages.md       packages/types, packages/kafka, packages/redis
Step 4   →  docs/04_api_service.md           apps/api — all 15 routes + SSE + consumers
Step 5   →  docs/05_orchestrator_service.md  apps/orchestrator — workflow state machine
Step 6   →  docs/06_worker_service.md        apps/worker — job execution + heartbeat
Step 7   →  docs/07_scheduler_service.md     apps/scheduler — cron poll + distributed lock
Step 8   →  docs/08_sdk_package.md           packages/sdk — JobEngine + Worker classes
Step 9   →  docs/09_dashboard.md             apps/dashboard — React Vite SPA
Step 10  →  docs/10_infra_and_deployment.md  Dockerfiles, docker-compose, Helm chart
Step 11  →  docs/11_testing_strategy.md      Jest unit + integration tests
Step 12  →  docs/13_readme.md               Generate root README.md, then commit it
```

---

## Documentation Index

| File | Contents |
|---|---|
| [00_overview_and_architecture.md](./docs/00_overview_and_architecture.md) | System architecture, data flow rules, Kafka topics, Redis keys, API surface, reliability invariants |
| [01_project_setup.md](./docs/01_project_setup.md) | npm workspaces, Turborepo, TypeScript config, ESLint, Docker Compose infra, env vars |
| [02_database_and_prisma.md](./docs/02_database_and_prisma.md) | All 8 Prisma models with exact field names and types, seed script, audit log helper |
| [03_shared_packages.md](./docs/03_shared_packages.md) | `packages/types` (Kafka event payloads, API types, logger), `packages/kafka` (client, topics, producer), `packages/redis` (client, Redlock, key builders) |
| [04_api_service.md](./docs/04_api_service.md) | All 15 Fastify routes with full implementation, auth middleware + rate limiter, SSE endpoint, Kafka → pub/sub event bridge consumers |
| [05_orchestrator_service.md](./docs/05_orchestrator_service.md) | Workflow state machine (workflow.created, job.completed, job.failed consumers), fan-in/fan-out with Redis counters, backoff calculation, Redlock usage |
| [06_worker_service.md](./docs/06_worker_service.md) | Kafka consumer with Redlock, JobContext class (progress/log), heartbeat registration, example handlers, graceful shutdown |
| [07_scheduler_service.md](./docs/07_scheduler_service.md) | Poll loop with `lock:scheduler:tick`, cron and one-shot schedule handling, HTTP submission to API service |
| [08_sdk_package.md](./docs/08_sdk_package.md) | `JobEngine` HTTP client class, `Worker` Kafka consumer class, full TypeScript types, usage examples |
| [09_dashboard.md](./docs/09_dashboard.md) | React + Vite SPA, SSE hook, Zustand stores, all 7 views (Jobs, JobDetail, Workflows, WorkflowDetail, Schedules, DLQ, Workers), step graph component |
| [10_infra_and_deployment.md](./docs/10_infra_and_deployment.md) | Multi-stage Dockerfiles for all services, full docker-compose.yml, Helm chart skeleton with HPA, env var reference |
| [11_testing_strategy.md](./docs/11_testing_strategy.md) | Jest config, Redis/Kafka mocks, unit tests for orchestrator/API/worker, integration test scaffold |
| [12_git_workflow.md](./docs/12_git_workflow.md) | 30 atomic git commits in order using Conventional Commits, push instructions |
| [13_readme.md](./docs/13_readme.md) | Template for root README.md — problem statement, Mermaid diagrams (arch + sequence + state), FAQ, quick start, API reference |

---

## Key Architectural Decisions

- **Kafka over RabbitMQ**: Multiple services consume the same events independently via consumer groups. Kafka retains events for replay.
- **Redlock over Postgres row locks**: Postgres locks are per-connection and fail across network partitions. Redlock is fast and battle-tested for distributed mutex.
- **Postgres before Kafka**: Write durability first. If Kafka is unavailable, the job record exists in Postgres and can be requeued.
- **SSE over WebSockets**: Simpler for one-directional server→client event streaming. No need for bidirectional communication.
- **Fastify over Express**: Lower overhead, built-in JSON schema validation, native async/await.

---

## Quick Start (After Implementation)

```bash
# 1. Install dependencies
npm install

# 2. Start infrastructure
docker compose -f infra/docker-compose.yml up -d postgres redis zookeeper kafka

# 3. Run database migrations + seed
npm run db:migrate && npm run db:seed

# 4. Start all services in dev mode
npm run dev

# 5. Open dashboard
open http://localhost:5173

# 6. Submit a test job
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"type":"send-email","payload":{"to":"test@example.com","subject":"Hello"}}'
```
