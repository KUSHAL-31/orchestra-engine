# 00 — System Overview & Architecture

> **Claude Code Instruction**: This document is the master reference. Read this first before any other doc. Every architectural rule defined here is a hard constraint. Never violate the rules in the RULES section.

---

## What We Are Building

**Forge Engine** — a self-hostable, open-source **Distributed Job Scheduler & Workflow Engine** written entirely in **TypeScript** (Node.js). It is the developer-friendly middle ground between simple queues (BullMQ) and heavyweight orchestrators (Temporal).

**Core capabilities:**
- Submit background jobs via REST API or a typed Node.js SDK
- Chain jobs into multi-step **workflows** with sequential and parallel (fan-out/fan-in) execution
- Schedule jobs via **cron** expressions or **one-shot** timestamps
- Monitor everything in real time via a **React dashboard** connected through SSE
- Self-host with `docker-compose up` in minutes

---

## Language & Stack (HARD CONSTRAINTS)

| Layer | Technology | Why |
|---|---|---|
| All services + SDK | **TypeScript / Node.js** | Single language; I/O-heavy async fits perfectly |
| HTTP API framework | **Fastify** | Lower overhead than Express; built-in JSON schema validation |
| Message bus | **Apache Kafka** via **KafkaJS** | Consumer groups for load balancing; event log for replay/audit |
| Distributed locking + cache | **Redis** via **ioredis + redlock** | Fast cross-process mutex; job state cache; pub/sub for SSE |
| Persistent store | **PostgreSQL** via **Prisma ORM** | ACID guarantees; relational step dependencies; type-safe queries |
| Dashboard UI | **React** (Vite) | SPA; SSE-driven live updates; no SSR needed |
| Local dev infra | **Docker Compose** | Postgres + Kafka + Zookeeper + Redis |
| Production | **Kubernetes** via Helm chart | Independent horizontal scaling per service |

> **DO NOT** add: Python, Go, Prometheus, Grafana, GraphQL, WebSockets, managed SaaS features.

---

## System Architecture — Four Services + Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│                     FORGE ENGINE                            │
│                                                             │
│  [SDK / Developer]                                          │
│        │  HTTP REST                                         │
│        ▼                                                    │
│  ┌──────────────┐   writes    ┌────────────┐               │
│  │  API Service │ ──────────▶ │ PostgreSQL │               │
│  │  (Fastify)   │             └────────────┘               │
│  └──────┬───────┘                                          │
│         │  produces                                         │
│         ▼                                                   │
│      [Kafka]                                                │
│         │                                                   │
│    ┌────┴─────────────────────┐                            │
│    │                          │                            │
│    ▼  consumes                ▼  consumes                 │
│  ┌──────────────┐       ┌──────────────┐                  │
│  │ Orchestrator │       │    Worker    │                   │
│  │  (stateless) │       │  (Kafka CG)  │                  │
│  └──────┬───────┘       └──────┬───────┘                  │
│         │  reads/writes         │  lock/progress/logs      │
│         ▼                       ▼                          │
│    [PostgreSQL]             [Redis]                        │
│    [Redis locks]                                           │
│         │  produces             │  produces               │
│         └────────────┬──────────┘                         │
│                      ▼                                     │
│                   [Kafka]  ◀─────────────────────         │
│                      │  events back to API+Orchestrator   │
│                                                            │
│  ┌──────────────┐   polls  ┌────────────┐                 │
│  │  Scheduler   │ ────────▶│ PostgreSQL │                 │
│  │              │   locks  │ (schedules)│                 │
│  │              │ ────────▶│   Redis    │                 │
│  └──────┬───────┘   HTTP   └────────────┘                 │
│         │  POST /jobs ──────▶ API Service                  │
│                                                            │
│  [Dashboard React] ──SSE/HTTP──▶ API Service              │
│   (API subscribes to Redis pub/sub → forwards SSE)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Canonical Data Flow Rules (NEVER VIOLATE)

| Rule | Description |
|---|---|
| **RULE-1** | The API Service **never** directly triggers workers. It writes to Postgres, then emits to Kafka. That is all. |
| **RULE-2** | Workers **never** directly update Postgres. They emit Kafka events. The Orchestrator handles Postgres writes for workflow step state. |
| **RULE-3** | The Orchestrator is the **only** service that writes workflow step state to Postgres. |
| **RULE-4** | Every Redis lock **must** have a TTL. A lock without TTL is a bug. |
| **RULE-5** | Always write to Postgres **before** producing to Kafka (durability guarantee). |
| **RULE-6** | Kafka consumer groups ensure only one worker processes each job message. Redlock provides a second layer of safety. |

---

## Job Lifecycle State Machine

```
pending ──▶ running ──▶ completed
                │
                └──▶ failed ──▶ retrying ──▶ running  (retry loop)
                                     │
                                     └──▶ dead  (exhausted max_attempts → DLQ)
```

## Workflow Step State Machine

```
pending ──▶ running ──▶ completed
                │
                └──▶ failed
                └──▶ skipped  (when a prior step failed and workflow halts)
```

---

## Kafka Topics (Complete List)

| Topic | Producer | Consumer(s) |
|---|---|---|
| `job.submitted` | API, Orchestrator (next step), Scheduler | Worker (CG: "workers") |
| `job.retry` | Orchestrator | Worker (CG: "workers") |
| `job.started` | Worker | Orchestrator (audit); API (→ Redis pub/sub → SSE) |
| `job.completed` | Worker | Orchestrator (next step); API (→ SSE) |
| `job.failed` | Worker | Orchestrator (retry/DLQ); API (→ SSE) |
| `job.dlq` | Orchestrator | API (writes to dead_letter_queue table) |
| `workflow.created` | API | Orchestrator (initialize first steps) |
| `workflow.step.done` | Orchestrator | API (→ SSE) |
| `workflow.completed` | Orchestrator | API (→ SSE) |
| `schedule.tick` | Scheduler | API (audit log) |

> **Do not** invent new Kafka topics. Use only the ones listed above.

---

## Redis Key Patterns (Complete List)

| Key Pattern | TTL | Purpose |
|---|---|---|
| `lock:job:{jobId}` | 30s | Worker holds while executing |
| `lock:workflow:{workflowId}` | 10s | Orchestrator holds during transitions |
| `lock:scheduler:tick` | 70s | One scheduler instance per poll cycle |
| `job:state:{jobId}` | 7d | String: current job status |
| `job:progress:{jobId}` | 7d | Integer: 0–100 |
| `job:logs:{jobId}` | 7d | List: appended log lines |
| `workflow:{id}:group:{group}:total` | — | Integer: total parallel jobs in group |
| `workflow:{id}:group:{group}:completed` | — | Integer: INCR on each job done |
| `ratelimit:{apiKeyId}` | 60s | Integer counter (max 1000/min) |
| `job.events` | — | Pub/sub channel: all job status changes |
| `workflow.events` | — | Pub/sub channel: all workflow/step changes |
| `heartbeat:{workerId}` | 30s | SET every 10s; expiry signals dead worker |

---

## Reliability Invariants

| Invariant | Rule |
|---|---|
| INVARIANT-001 | Postgres write **before** Kafka produce |
| INVARIANT-002 | Worker must acquire Redlock before executing; skip if lock fails |
| INVARIANT-003 | Orchestrator must acquire Redlock on workflow ID before any state transition |
| INVARIANT-004 | Idempotency keys prevent duplicate job creation at API layer |
| INVARIANT-005 | Scheduler holds distributed lock before polling |
| INVARIANT-006 | Every status transition is written to `audit_log` |
| INVARIANT-007 | All Redis locks MUST have a TTL |

---

## Monorepo Folder Structure

```
/forge-engine                          ← root (npm workspaces)
  package.json                         ← root workspace config
  tsconfig.base.json                   ← base TS config (all services extend this)
  turbo.json                           ← Turborepo pipeline (optional but recommended)
  .env.example                         ← root environment variable template
  /apps
    /api                               ← Fastify REST API service
    /orchestrator                      ← Kafka consumer: workflow state machine
    /worker                            ← Kafka consumer: job execution engine
    /scheduler                         ← Poll-based cron/one-shot scheduler
    /dashboard                         ← React + Vite SPA
  /packages
    /sdk                               ← Node.js/TypeScript client SDK
    /prisma                            ← Shared Prisma schema + generated client
    /kafka                             ← KafkaJS factory + topic name constants
    /redis                             ← ioredis client + Redlock + key constants
    /types                             ← Shared TypeScript types for all events/payloads
  /infra
    docker-compose.yml                 ← Postgres + Kafka + Zookeeper + Redis
    /helm                              ← Helm chart for Kubernetes deployment
    /dockerfiles                       ← One Dockerfile per service
  /docs                                ← This documentation folder
```

---

## API Surface (All Endpoints)

| Method | Path | Description |
|---|---|---|
| `POST` | `/jobs` | Submit a new job |
| `GET` | `/jobs/:id` | Get job status (Redis cache → Postgres fallback) |
| `POST` | `/workflows` | Submit a workflow definition |
| `GET` | `/workflows/:id` | Get workflow + all step statuses |
| `POST` | `/workflows/:id/resume` | Resume a failed workflow |
| `GET` | `/dlq` | List dead letter queue entries |
| `POST` | `/dlq/:id/replay` | Resubmit a DLQ job as a fresh job |
| `DELETE` | `/dlq/:id` | Permanently delete a DLQ entry |
| `GET` | `/schedules` | List all schedules |
| `POST` | `/schedules` | Create a cron or one-shot schedule |
| `PATCH` | `/schedules/:id` | Update or pause a schedule |
| `DELETE` | `/schedules/:id` | Delete a schedule |
| `GET` | `/workers` | List registered workers + heartbeat status |
| `GET` | `/events` | SSE stream — live job/workflow events |
| `GET` | `/health` | Health check (no auth required) |

---

## Non-Functional Targets

| Concern | Target |
|---|---|
| Throughput | 1000 job submissions/second on a single API instance |
| Latency | Job pickup (submitted → execution start) under 500ms |
| Dashboard freshness | Job state changes reflected within 1 second via SSE |
| Durability | No job lost after successful `POST /jobs` response |
| Horizontal scaling | All four services independently scalable |
| Observability | All services emit structured JSON logs; all expose `GET /health` |

---

## Out of Scope — Never Build

- Python or Go components
- Prometheus metrics or Grafana dashboards
- Drag-and-drop workflow UI builder
- GraphQL API
- WebSockets (SSE only)
- Email/Slack alerting
- Secret management
- Job payloads exceeding 1MB
- Managed SaaS mode
