# 10 — Infrastructure & Deployment

> **Claude Code Instruction**: Create all Dockerfiles, the complete docker-compose.yml, and the Helm chart skeleton. Every service must have its own Dockerfile. The docker-compose.yml must start all 5 services (api, orchestrator, worker, scheduler, dashboard) alongside Postgres, Kafka, Zookeeper, and Redis.

---

## 1. Dockerfiles

### `infra/dockerfiles/Dockerfile.api`

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN npm install -g turbo

FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/kafka/package.json ./packages/kafka/
COPY packages/redis/package.json ./packages/redis/
COPY packages/prisma/package.json ./packages/prisma/
RUN npm ci

FROM deps AS builder
COPY . .
RUN turbo run build --filter=@forge-engine/api...

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/kafka/dist ./packages/kafka/dist
COPY --from=builder /app/packages/redis/dist ./packages/redis/dist
COPY --from=builder /app/packages/prisma/dist ./packages/prisma/dist
COPY --from=builder /app/packages/prisma/prisma ./packages/prisma/prisma
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
```

### Pattern for other services

Use the same multi-stage pattern for these. Only the `--filter` and `EXPOSE`/`CMD` differ:

| Service | `--filter` | `EXPOSE` | `CMD` |
|---|---|---|---|
| `Dockerfile.orchestrator` | `@forge-engine/orchestrator...` | — | `node apps/orchestrator/dist/index.js` |
| `Dockerfile.worker` | `@forge-engine/worker...` | — | `node apps/worker/dist/index.js` |
| `Dockerfile.scheduler` | `@forge-engine/scheduler...` | — | `node apps/scheduler/dist/index.js` |

### `infra/dockerfiles/Dockerfile.dashboard`

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY apps/dashboard/package.json ./apps/dashboard/
RUN npm ci

FROM deps AS builder
COPY apps/dashboard ./apps/dashboard
ENV VITE_API_KEY=${VITE_API_KEY:-forge-dev-api-key-12345}
RUN npm run build --workspace=apps/dashboard

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### `infra/nginx.conf`

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://api:3000/;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}
```

---

## 2. Full `docker-compose.yml` (All Services)

```yaml
version: '3.9'

services:
  # ── Infrastructure ───────────────────────────────────────────────────────────

  postgres:
    image: postgres:16-alpine
    container_name: forge-postgres
    environment:
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge
      POSTGRES_DB: forge_engine
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U forge']
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: forge-redis
    ports:
      - '6379:6379'
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5

  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    container_name: forge-zookeeper
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    container_name: forge-kafka
    depends_on:
      - zookeeper
    ports:
      - '9092:9092'
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'
    healthcheck:
      test: ['CMD', 'kafka-broker-api-versions', '--bootstrap-server', 'localhost:9092']
      interval: 10s
      timeout: 10s
      retries: 5

  # ── Application Services ─────────────────────────────────────────────────────

  migrate:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.api
    command: sh -c "cd packages/prisma && npx prisma migrate deploy && npx prisma db seed"
    environment:
      DATABASE_URL: postgresql://forge:forge@postgres:5432/forge_engine
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.api
    container_name: forge-api
    ports:
      - '3000:3000'
    env_file:
      - ../.env
    environment:
      DATABASE_URL: postgresql://forge:forge@postgres:5432/forge_engine
      KAFKA_BROKERS: kafka:29092
      REDIS_HOST: redis
      API_PORT: '3000'
    depends_on:
      postgres:
        condition: service_healthy
      kafka:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

  orchestrator:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.orchestrator
    container_name: forge-orchestrator
    env_file:
      - ../.env
    environment:
      DATABASE_URL: postgresql://forge:forge@postgres:5432/forge_engine
      KAFKA_BROKERS: kafka:29092
      REDIS_HOST: redis
    depends_on:
      - api

  worker:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.worker
    env_file:
      - ../.env
    environment:
      DATABASE_URL: postgresql://forge:forge@postgres:5432/forge_engine
      KAFKA_BROKERS: kafka:29092
      REDIS_HOST: redis
    depends_on:
      - api
    deploy:
      replicas: 2    # Run 2 worker instances by default

  scheduler:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.scheduler
    container_name: forge-scheduler
    env_file:
      - ../.env
    environment:
      DATABASE_URL: postgresql://forge:forge@postgres:5432/forge_engine
      KAFKA_BROKERS: kafka:29092
      REDIS_HOST: redis
      API_BASE_URL: http://api:3000
    depends_on:
      - api

  dashboard:
    build:
      context: ..
      dockerfile: infra/dockerfiles/Dockerfile.dashboard
    container_name: forge-dashboard
    ports:
      - '5173:80'
    depends_on:
      - api

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: forge-kafka-ui
    ports:
      - '8080:8080'
    environment:
      KAFKA_CLUSTERS_0_NAME: forge
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
    depends_on:
      - kafka

volumes:
  postgres_data:
  redis_data:
```

---

## 3. Helm Chart Skeleton (`infra/helm/`)

```
infra/helm/
  Chart.yaml
  values.yaml
  templates/
    api-deployment.yaml
    api-service.yaml
    orchestrator-deployment.yaml
    worker-deployment.yaml
    scheduler-deployment.yaml
    dashboard-deployment.yaml
    dashboard-service.yaml
    configmap.yaml
    secrets.yaml
    hpa.yaml              ← HorizontalPodAutoscaler for worker
```

### `infra/helm/Chart.yaml`

```yaml
apiVersion: v2
name: forge-engine
description: Distributed Job Scheduler & Workflow Engine
type: application
version: 0.1.0
appVersion: "1.0.0"
```

### `infra/helm/values.yaml`

```yaml
api:
  replicaCount: 2
  image:
    repository: forge-engine/api
    tag: latest
  port: 3000
  resources:
    requests: { cpu: 200m, memory: 256Mi }
    limits: { cpu: 500m, memory: 512Mi }

orchestrator:
  replicaCount: 2
  image:
    repository: forge-engine/orchestrator
    tag: latest

worker:
  replicaCount: 3
  image:
    repository: forge-engine/worker
    tag: latest
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 20
    targetCPUUtilizationPercentage: 70

scheduler:
  replicaCount: 1    # ALWAYS 1 — Redis lock handles dedup but 1 replica is safer
  image:
    repository: forge-engine/scheduler
    tag: latest

dashboard:
  replicaCount: 1
  image:
    repository: forge-engine/dashboard
    tag: latest
  port: 80

config:
  kafkaBrokers: "kafka:9092"
  redisHost: redis-master
  redisPort: "6379"
  apiBaseUrl: "http://api:3000"

secrets:
  databaseUrl: ""       # Set via --set or Kubernetes secret
  redisPassword: ""
  apiKeySeed: ""
```

### `infra/helm/templates/worker-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-worker
spec:
  replicas: {{ .Values.worker.replicaCount }}
  selector:
    matchLabels:
      app: forge-worker
  template:
    metadata:
      labels:
        app: forge-worker
    spec:
      containers:
        - name: worker
          image: "{{ .Values.worker.image.repository }}:{{ .Values.worker.image.tag }}"
          envFrom:
            - configMapRef:
                name: {{ .Release.Name }}-config
            - secretRef:
                name: {{ .Release.Name }}-secrets
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .Release.Name }}-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .Release.Name }}-worker
  minReplicas: {{ .Values.worker.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.worker.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.worker.autoscaling.targetCPUUtilizationPercentage }}
```

---

## 4. Environment Variables — Complete Reference

| Variable | Used By | Description |
|---|---|---|
| `DATABASE_URL` | api, orchestrator, worker, scheduler | Postgres connection string |
| `KAFKA_BROKERS` | all services | Comma-separated broker list |
| `KAFKA_CLIENT_ID` | all services | KafkaJS client identifier |
| `KAFKA_GROUP_ID_ORCHESTRATOR` | orchestrator | Consumer group ID |
| `KAFKA_GROUP_ID_WORKER` | worker | Consumer group ID |
| `KAFKA_GROUP_ID_API` | api | Consumer group ID for event bridge |
| `REDIS_HOST` | all services | Redis hostname |
| `REDIS_PORT` | all services | Redis port (default 6379) |
| `REDIS_PASSWORD` | all services | Redis auth password |
| `API_PORT` | api | Fastify listen port (default 3000) |
| `API_BASE_URL` | scheduler | URL to submit jobs via HTTP |
| `API_KEY_SEED` | api, scheduler | Dev seed key for internal scheduler calls |
| `SCHEDULER_POLL_INTERVAL_MS` | scheduler | Poll interval (default 60000) |
| `LOG_LEVEL` | all services | Pino log level (default info) |
| `NODE_ENV` | all services | development \| production |

---

## 5. Quick Start Commands

```bash
# Start infrastructure + all services
docker compose -f infra/docker-compose.yml up -d

# View logs
docker compose -f infra/docker-compose.yml logs -f api orchestrator worker

# Scale workers
docker compose -f infra/docker-compose.yml up -d --scale worker=5

# Run migrations only
npm run db:migrate

# Open Kafka UI
open http://localhost:8080

# Open Dashboard
open http://localhost:5173

# Stop everything
docker compose -f infra/docker-compose.yml down -v
```
