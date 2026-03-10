# 13 — README.md Template

> **Claude Code Instruction**: Generate the root `README.md` file for this project using the exact structure defined here. Fill in every section completely. This is the public face of the project — make it thorough, professional, and impressive. Place the final file at the repository root as `README.md`.

---

## Instructions for Claude Code

Generate a `README.md` at the project root with the following sections in order. Use the content guidelines for each section.

---

## Section 1: Header + Badges

```markdown
# ⚡ Forge Engine

> A self-hostable, open-source **Distributed Job Scheduler & Workflow Engine** built entirely in TypeScript.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](infra/docker-compose.yml)
```

---

## Section 2: One-Line Summary + GIF/Screenshot placeholder

```markdown
**Forge Engine** is the developer-friendly middle ground between basic queues (BullMQ) and heavyweight orchestrators (Temporal).
Submit jobs, chain them into multi-step workflows, schedule them, and watch them execute in real time — all with a clean REST API, a typed SDK, and a live dashboard.

> 🚀 Get started in 5 minutes with `docker compose up`
```

---

## Section 3: Problem Statement

Write 3–4 paragraphs covering:
- Modern apps need background work (emails, reports, payments, data sync)
- Three bad options: simple queues (no workflows), enterprise engines (too heavy), DIY (fragile)
- The gap: no self-hostable, Node.js-native, workflow-first engine with real observability
- What Forge Engine solves

---

## Section 4: Feature Overview (bullet list)

```markdown
## ✨ Features

### Job Management
- Submit background jobs via REST API or typed Node.js SDK
- Configurable retries with `fixed | linear | exponential` backoff
- Job priority: `low | normal | high | critical`
- Delayed job execution (delay before first attempt)
- Idempotency keys — safe to submit the same job twice
- Live progress reporting (`ctx.progress(0–100)`) and logging (`ctx.log(msg)`)

### Workflow Orchestration
- Multi-step workflows with a clean JSON definition or fluent SDK builder
- Sequential steps with `dependsOn` — step B only starts after step A completes
- Parallel fan-out — multiple steps run simultaneously in a `parallelGroup`
- Fan-in — a downstream step waits for all parallel steps to finish (Redis counters)
- `onFailure` handler — automatic cleanup job when a workflow fails
- Resume failed workflows without re-running completed steps

### Scheduling
- Cron schedules (standard 5-part cron syntax)
- One-shot scheduled jobs (fire once at a datetime)
- Distributed lock ensures exactly one scheduler fires across all replicas

### Dead Letter Queue
- Automatic DLQ when a job exhausts all retries
- Full error history stored for every failed attempt
- Replay jobs from DLQ with one API call
- Permanent deletion from DLQ

### Real-Time Observability
- Server-Sent Events (SSE) stream for live job/workflow state changes
- Dashboard with real-time step graph (colors: grey→blue→green/red)
- Worker heartbeat monitoring — see which workers are alive or dead
- Full audit log of every status transition in Postgres

### Security
- API key authentication with SHA-256 hashing (plaintext never stored)
- Rate limiting: 1000 requests/minute per API key via Redis

### Developer Experience
- Fully typed TypeScript SDK with `JobEngine` and `Worker` classes
- Fluent workflow builder: `.step().parallel().onFailure().submit()`
- One-command local setup: `docker compose up`
- Kafka UI included for debugging message flow
```

---

## Section 5: Architecture — System Diagram (Mermaid)

````markdown
## 🏗️ Architecture

```mermaid
graph TD
    Dev["👨‍💻 Developer / SDK"] -->|HTTP REST| API["🌐 API Service\n(Fastify)"]
    API -->|writes| PG[("🐘 PostgreSQL\n(Prisma)")]
    API -->|produces| K1["📨 Kafka"]

    K1 -->|workflow.created| ORC["🧠 Orchestrator"]
    K1 -->|job.submitted\njob.retry| WRK["⚙️ Worker\n(Consumer Group)"]

    ORC -->|reads/writes| PG
    ORC -->|lock/fanin| RD[("🔴 Redis")]
    ORC -->|job.submitted| K2["📨 Kafka"]

    WRK -->|Redlock| RD
    WRK -->|progress/logs| RD
    WRK -->|job.started\njob.completed\njob.failed| K3["📨 Kafka"]

    K3 -->|job events| ORC
    K3 -->|forward| API
    API -->|pub/sub| RD

    SCH["⏰ Scheduler"] -->|polls| PG
    SCH -->|lock| RD
    SCH -->|POST /jobs| API

    DASH["📊 Dashboard\n(React + Vite)"] -->|SSE + HTTP| API
    RD -->|pub/sub → SSE| DASH
```
````

---

## Section 6: Kafka Event Flow (Mermaid Sequence Diagram)

````markdown
## 📨 Event Flow

```mermaid
sequenceDiagram
    participant C as Client/SDK
    participant A as API Service
    participant K as Kafka
    participant O as Orchestrator
    participant W as Worker
    participant R as Redis
    participant DB as PostgreSQL

    C->>A: POST /jobs {type, payload}
    A->>DB: INSERT job (status=PENDING)
    A->>K: produce job.submitted
    A-->>C: {jobId}

    K->>W: consume job.submitted
    W->>R: acquire Redlock (lock:job:{id})
    W->>K: produce job.started
    W->>R: SET job:state:{id} = running
    W->>W: execute handler(ctx)
    W->>R: SET job:progress:{id} = 50
    W->>R: RPUSH job:logs:{id}
    W->>K: produce job.completed {result}
    W->>R: release Redlock

    K->>A: consume job.completed
    A->>R: publish job.events (→ SSE)
    K->>O: consume job.completed
    O->>DB: UPDATE job status=COMPLETED
```
````

---

## Section 7: Workflow Lifecycle (Mermaid State Diagram)

````markdown
## 🔄 Job State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /jobs
    PENDING --> RUNNING: Worker picks up
    RUNNING --> COMPLETED: Handler succeeds
    RUNNING --> FAILED: Handler throws
    FAILED --> RETRYING: attempt < maxAttempts
    RETRYING --> RUNNING: After backoff delay
    FAILED --> DEAD: attempt === maxAttempts
    DEAD --> [*]: Moved to DLQ
```
````

---

## Section 8: Quick Start

```markdown
## 🚀 Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+

### 1. Clone & Install
```bash
git clone https://github.com/YOUR_USERNAME/forge-engine.git
cd forge-engine
npm install
```

### 2. Start everything
```bash
docker compose -f infra/docker-compose.yml up -d
```
This starts: Postgres, Redis, Kafka, Zookeeper, API, Orchestrator, Worker, Scheduler, Dashboard, Kafka UI.

### 3. Submit your first job
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"type":"send-email","payload":{"to":"you@example.com","subject":"Hello from Forge!"}}'
```

### 4. Open the Dashboard
```
http://localhost:5173
```

### 5. Open Kafka UI (optional)
```
http://localhost:8080
```
```

---

## Section 9: SDK Usage Examples

Show:
1. Submitting a standalone job
2. Checking job status
3. Submitting a sequential workflow
4. Submitting a parallel fan-out workflow
5. Registering a worker handler

---

## Section 10: API Reference Table

```markdown
## 📡 API Reference

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/jobs` | Submit a background job | ✅ |
| `GET` | `/jobs/:id` | Get job status, progress, logs | ✅ |
| `POST` | `/workflows` | Submit a workflow definition | ✅ |
| `GET` | `/workflows/:id` | Get workflow + all step statuses | ✅ |
| `POST` | `/workflows/:id/resume` | Resume a failed workflow | ✅ |
| `GET` | `/dlq` | List dead letter queue entries | ✅ |
| `POST` | `/dlq/:id/replay` | Replay a DLQ job | ✅ |
| `DELETE` | `/dlq/:id` | Delete a DLQ entry | ✅ |
| `GET` | `/schedules` | List all schedules | ✅ |
| `POST` | `/schedules` | Create a cron or one-shot schedule | ✅ |
| `PATCH` | `/schedules/:id` | Update or pause a schedule | ✅ |
| `DELETE` | `/schedules/:id` | Delete a schedule | ✅ |
| `GET` | `/workers` | List workers + heartbeat status | ✅ |
| `GET` | `/events` | SSE stream of live events | ✅ |
| `GET` | `/health` | Health check | ❌ |

All authenticated requests require: `Authorization: Bearer {apiKey}`
```

---

## Section 11: Tech Stack

```markdown
## 🛠️ Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Language | TypeScript 5 / Node.js 20 | Single language across all services |
| API Framework | Fastify | Lower overhead than Express; built-in JSON schema validation |
| Message Bus | Apache Kafka (KafkaJS) | Consumer groups for load balancing; event retention for replay |
| Distributed Locks | Redis + Redlock | Fast cross-process mutex; handles horizontal scale correctly |
| Job State Cache | Redis (ioredis) | Sub-millisecond reads for progress/logs without hitting Postgres |
| Pub/Sub (SSE) | Redis pub/sub | Push events to SSE clients instantly |
| Database | PostgreSQL (Prisma) | ACID guarantees; durable source of truth; relational step deps |
| Dashboard | React + Vite | SPA; SSE-driven updates; no SSR needed |
| Local Dev | Docker Compose | One command to run entire stack |
| Production | Kubernetes + Helm | Independent scaling; HPA for workers |
```

---

## Section 12: Project Structure

Show the full folder tree from `docs/00_overview_and_architecture.md`.

---

## Section 13: FAQ

```markdown
## ❓ FAQ

**Q: How is this different from BullMQ?**
BullMQ handles isolated jobs with no concept of chaining, fan-out/fan-in, or workflow-level observability. Forge Engine adds workflow orchestration, distributed locking, and a live dashboard on top of a Kafka-backed architecture.

**Q: How is this different from Temporal?**
Temporal is powerful but operationally heavy — it requires a dedicated cluster and has a steep learning curve. Forge Engine is self-hostable with docker-compose and can be adopted in an afternoon.

**Q: What happens if a worker crashes mid-job?**
The Kafka consumer group rebalances. The job message is re-delivered to another worker. The Redlock TTL (30s) ensures the crashed worker's lock expires, so the new worker can acquire it and execute the job without duplicate execution.

**Q: What happens if Kafka goes down?**
Because we write to Postgres before producing to Kafka (INVARIANT-001), the job record already exists. On Kafka recovery, the API can requeue unprocessed jobs from Postgres.

**Q: Can I run multiple worker instances?**
Yes. Kafka consumer groups automatically distribute `job.submitted` messages across all worker replicas. Redlock provides a second layer of safety — only one worker can execute a given job at a time even if multiple workers consume the same message.

**Q: How do I add a new job type?**
Register a handler in `apps/worker/src/handlers/` and add it to the handlers Map in `apps/worker/src/index.ts`. Or using the SDK: `worker.register('my-type', async (ctx) => { ... })`.

**Q: Can I host this on Kubernetes?**
Yes. The `infra/helm/` chart deploys all services with a HorizontalPodAutoscaler for the worker. Redis and Postgres should use managed cloud services in production.

**Q: What's the maximum job payload size?**
1MB. For larger data (files, images, large datasets), store the data in object storage and pass a reference URL in the payload.

**Q: Is there a Python or Go SDK?**
No. This project is intentionally Node.js/TypeScript only. See `docs/00_overview_and_architecture.md` for the reasoning.
```

---

## Section 14: Contributing

```markdown
## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Follow the commit convention: `feat(scope): description`
4. Submit a Pull Request

Please read the docs/ folder before contributing — especially `00_overview_and_architecture.md` for the architectural rules that must never be violated.
```

---

## Section 15: License

```markdown
## 📄 License

MIT — see [LICENSE](LICENSE)
```

---

## Claude Code: Final Instructions for README.md

- Place the generated file at: `/forge-engine/README.md` (project root)
- Use all Mermaid diagrams exactly as specified in sections 5, 6, and 7
- The FAQ section must have at least the 9 questions listed above
- The SDK Usage section must show all 5 code examples with real TypeScript code
- Do not skip any section
- After writing README.md, commit it: `git add README.md && git commit -m "docs: add comprehensive README with system architecture, Mermaid diagram, and FAQ"`
