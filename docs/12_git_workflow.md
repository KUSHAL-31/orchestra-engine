# 12 — Git Workflow

> **Claude Code Instruction**: Initialize a git repository and commit code incrementally as you implement each component. Every commit must be atomic — one logical unit of work per commit. This gives the project a clean, reviewable history that can be pushed to any remote repository.

---

## Initial Setup

```bash
# Run these FIRST before any implementation
git init
git config user.name "Forge Engine"
git config user.email "forge@example.com"

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
dist/
.env
*.env.local
.turbo/
prisma/generated/
*.log
.DS_Store
coverage/
EOF

git add .gitignore
git commit -m "chore: initialize repository with .gitignore"
```

---

## Commit Order — Follow Exactly

After implementing each step, run the corresponding git commands below **before moving to the next step**.

---

### Commit 1 — Root Monorepo Scaffold
*After implementing Step 1 (docs/01_project_setup.md)*
```bash
git add package.json turbo.json tsconfig.base.json .eslintrc.js .prettierrc .env.example
git commit -m "chore: scaffold monorepo with npm workspaces and Turborepo"
```

---

### Commit 2 — Docker Compose Infrastructure
*After creating infra/docker-compose.yml*
```bash
git add infra/docker-compose.yml
git commit -m "infra: add Docker Compose for Postgres, Kafka, Zookeeper, Redis"
```

---

### Commit 3 — Shared Types Package
*After implementing packages/types*
```bash
git add packages/types/
git commit -m "feat(types): add shared TypeScript types — Kafka events, API shapes, logger"
```

---

### Commit 4 — Prisma Schema & Database Setup
*After implementing packages/prisma (docs/02_database_and_prisma.md)*
```bash
git add packages/prisma/
git commit -m "feat(prisma): add schema for jobs, workflows, steps, schedules, DLQ, workers, audit_log"
```

---

### Commit 5 — Kafka Shared Package
*After implementing packages/kafka (docs/03_shared_packages.md)*
```bash
git add packages/kafka/
git commit -m "feat(kafka): add KafkaJS client factory, topic constants, typed producer, topic init"
```

---

### Commit 6 — Redis Shared Package
*After implementing packages/redis*
```bash
git add packages/redis/
git commit -m "feat(redis): add ioredis client, Redlock setup, key builders, pub/sub channels"
```

---

### Commit 7 — API Service: Core Setup + Health
*After setting up Fastify server and health route*
```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/src/index.ts apps/api/src/server.ts apps/api/src/routes/health.ts
git commit -m "feat(api): initialize Fastify server with health endpoint"
```

---

### Commit 8 — API Service: Auth + Rate Limiting
*After implementing auth middleware*
```bash
git add apps/api/src/middleware/
git commit -m "feat(api): add SHA-256 API key auth middleware and Redis rate limiting (1000 req/min)"
```

---

### Commit 9 — API Service: Job Routes
*After implementing POST /jobs and GET /jobs/:id*
```bash
git add apps/api/src/routes/jobs.ts
git commit -m "feat(api): add POST /jobs and GET /jobs/:id with Redis cache-first reads"
```

---

### Commit 10 — API Service: Workflow Routes
*After implementing workflow routes*
```bash
git add apps/api/src/routes/workflows.ts
git commit -m "feat(api): add POST /workflows, GET /workflows/:id, POST /workflows/:id/resume"
```

---

### Commit 11 — API Service: DLQ, Schedules, Workers Routes
```bash
git add apps/api/src/routes/dlq.ts apps/api/src/routes/schedules.ts apps/api/src/routes/workers.ts
git commit -m "feat(api): add DLQ replay/delete, schedule CRUD, worker list endpoints"
```

---

### Commit 12 — API Service: SSE + Kafka Event Bridge
*After implementing SSE and all Kafka consumers*
```bash
git add apps/api/src/routes/events.ts apps/api/src/consumers/
git commit -m "feat(api): add SSE endpoint and Kafka→Redis pub/sub event bridge for real-time updates"
```

---

### Commit 13 — Orchestrator: workflow.created Consumer
```bash
git add apps/orchestrator/src/consumers/workflow-created.ts apps/orchestrator/src/lib/step-resolver.ts
git commit -m "feat(orchestrator): handle workflow.created — resolve and submit first workflow steps"
```

---

### Commit 14 — Orchestrator: job.completed (Fan-in/Fan-out)
```bash
git add apps/orchestrator/src/consumers/job-completed.ts
git commit -m "feat(orchestrator): handle job.completed — advance workflow, fan-in Redis counters, detect completion"
```

---

### Commit 15 — Orchestrator: job.failed (Retry + DLQ)
```bash
git add apps/orchestrator/src/consumers/job-failed.ts apps/orchestrator/src/lib/backoff.ts
git commit -m "feat(orchestrator): handle job.failed — exponential backoff retry and DLQ escalation"
```

---

### Commit 16 — Orchestrator: job.started Audit Consumer
```bash
git add apps/orchestrator/src/consumers/job-started.ts apps/orchestrator/src/index.ts
git commit -m "feat(orchestrator): add job.started consumer for audit log writes, wire all consumers"
```

---

### Commit 17 — Worker Service: Job Execution Engine
```bash
git add apps/worker/src/consumer.ts apps/worker/src/context.ts
git commit -m "feat(worker): implement job execution with Redlock, JobContext (progress/log), Kafka events"
```

---

### Commit 18 — Worker Service: Heartbeat + Registration
```bash
git add apps/worker/src/heartbeat.ts apps/worker/src/index.ts
git commit -m "feat(worker): add worker registration, Redis heartbeat (10s interval), graceful shutdown"
```

---

### Commit 19 — Worker Service: Example Handlers
```bash
git add apps/worker/src/handlers/
git commit -m "feat(worker): add send-email and generate-report example job handlers"
```

---

### Commit 20 — Scheduler Service
```bash
git add apps/scheduler/
git commit -m "feat(scheduler): add poll loop with distributed Redis lock, cron/one-shot support, HTTP job submission"
```

---

### Commit 21 — SDK Package
```bash
git add packages/sdk/
git commit -m "feat(sdk): add JobEngine HTTP client and Worker class with typed handler registration"
```

---

### Commit 22 — Dashboard: Foundation + Routing
```bash
git add apps/dashboard/package.json apps/dashboard/vite.config.ts apps/dashboard/src/main.tsx apps/dashboard/src/App.tsx apps/dashboard/src/api/ apps/dashboard/src/store/
git commit -m "feat(dashboard): scaffold React+Vite SPA with router, API client, Zustand stores"
```

---

### Commit 23 — Dashboard: SSE Hook + Job Views
```bash
git add apps/dashboard/src/hooks/ apps/dashboard/src/views/JobsView.tsx apps/dashboard/src/views/JobDetailView.tsx apps/dashboard/src/components/StatusBadge.tsx apps/dashboard/src/components/ProgressBar.tsx
git commit -m "feat(dashboard): add SSE real-time hook, jobs list view, job detail view with logs"
```

---

### Commit 24 — Dashboard: Workflow, Schedule, DLQ, Workers Views
```bash
git add apps/dashboard/src/views/ apps/dashboard/src/components/StepGraph.tsx apps/dashboard/src/components/Sidebar.tsx
git commit -m "feat(dashboard): add workflow step graph, schedules, DLQ, and workers views"
```

---

### Commit 25 — Dockerfiles + Full docker-compose
```bash
git add infra/dockerfiles/ infra/nginx.conf
git commit -m "infra: add multi-stage Dockerfiles for all services and nginx config for dashboard"
```

---

### Commit 26 — Full docker-compose (all services)
```bash
git add infra/docker-compose.yml
git commit -m "infra: update docker-compose to include all 5 application services with health checks"
```

---

### Commit 27 — Helm Chart
```bash
git add infra/helm/
git commit -m "infra: add Helm chart skeleton with HPA for worker auto-scaling"
```

---

### Commit 28 — Tests
```bash
git add apps/orchestrator/src/__tests__/ apps/api/src/__tests__/ apps/worker/src/__tests__/ jest.config.base.js
git commit -m "test: add unit tests for backoff, step-resolver, auth middleware, job submission, JobContext"
```

---

### Commit 29 — README
*After generating README.md (docs/13_readme.md → root README.md)*
```bash
git add README.md
git commit -m "docs: add comprehensive README with system architecture, Mermaid diagram, and FAQ"
```

---

### Commit 30 — Documentation Folder
```bash
git add docs/
git commit -m "docs: add complete implementation guide for Claude Code (12 docs covering all services)"
```

---

## Push to Remote

```bash
# Add your GitHub/GitLab repo as remote
git remote add origin https://github.com/YOUR_USERNAME/forge-engine.git

# Push all commits
git push -u origin main
```

---

## Commit Message Convention

All commits follow **Conventional Commits** format:
```
<type>(<scope>): <short description>

Types: feat | fix | chore | docs | test | infra | refactor
```

Examples:
- `feat(api): add rate limiting middleware`
- `fix(orchestrator): handle fan-in counter initialization race condition`
- `test(worker): add Redlock acquisition failure test`
- `infra: add Kafka health check to docker-compose`
