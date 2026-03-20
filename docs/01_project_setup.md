# 01 — Project Setup & Monorepo Bootstrap

> **Claude Code Instruction**: Implement this document first before any service code. This establishes the monorepo foundation that all other packages depend on. Use TypeScript throughout — no plain JavaScript files in `src/` directories.

---

## 1. Root `package.json` — npm Workspaces

```json
{
  "name": "forge-engine",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "db:migrate": "npm run migrate --workspace=packages/prisma",
    "db:generate": "npm run generate --workspace=packages/prisma",
    "db:seed": "npm run seed --workspace=packages/prisma"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "eslint": "^8.57.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "prettier": "^3.2.0"
  }
}
```

---

## 2. Turborepo Configuration (`turbo.json`)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

---

## 3. Base TypeScript Configuration (`tsconfig.base.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "exclude": ["node_modules", "dist"]
}
```

Each `apps/*` and `packages/*` folder extends this:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

---

## 4. Root `.env.example`

```dotenv
# PostgreSQL
DATABASE_URL=postgresql://forge:forge@localhost:5432/forge_engine

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=forge-engine
KAFKA_GROUP_ID_ORCHESTRATOR=orchestrator
KAFKA_GROUP_ID_WORKER=workers
KAFKA_GROUP_ID_API=api-consumers

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# API Service
API_PORT=3000
API_BASE_URL=http://localhost:3000

# Security
API_KEY_SEED=supersecret-change-me-in-production

# Scheduler
SCHEDULER_POLL_INTERVAL_MS=60000
SCHEDULER_LOCK_TTL_MS=70000

# Redlock
REDLOCK_WORKER_TTL_MS=30000
REDLOCK_WORKFLOW_TTL_MS=10000

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

---

## 5. ESLint Config (`.eslintrc.js` at root)

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    'no-console': 'warn',
  },
  env: {
    node: true,
    es2022: true,
  },
};
```

---

## 6. Prettier Config (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```

---

## 7. Docker Compose (`infra/docker-compose.yml`)

```yaml
version: '3.9'

services:
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
    ports:
      - '2181:2181'

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    container_name: forge-kafka
    depends_on:
      - zookeeper
    ports:
      - '9092:9092'
      - '29092:29092'
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'
      KAFKA_LOG_RETENTION_HOURS: 168
    healthcheck:
      test: ['CMD', 'kafka-broker-api-versions', '--bootstrap-server', 'localhost:9092']
      interval: 10s
      timeout: 10s
      retries: 5

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: forge-kafka-ui
    depends_on:
      - kafka
    ports:
      - '8080:8080'
    environment:
      KAFKA_CLUSTERS_0_NAME: forge
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092

volumes:
  postgres_data:
  redis_data:
```

---

## 8. Kafka Topic Initialization Script

Create `packages/kafka/src/init-topics.ts`:

```typescript
import { kafka } from './client';

const TOPICS = [
  'job.submitted',
  'job.retry',
  'job.started',
  'job.completed',
  'job.failed',
  'job.dlq',
  'workflow.created',
  'workflow.step.done',
  'workflow.completed',
  'schedule.tick',
];

export async function initKafkaTopics() {
  const admin = kafka.admin();
  await admin.connect();

  const existing = await admin.listTopics();
  const toCreate = TOPICS.filter((t) => !existing.includes(t)).map((topic) => ({
    topic,
    numPartitions: 3,
    replicationFactor: 1,
  }));

  if (toCreate.length > 0) {
    await admin.createTopics({ topics: toCreate });
    console.log(`Created Kafka topics: ${toCreate.map((t) => t.topic).join(', ')}`);
  }

  await admin.disconnect();
}
```

---

## 9. Service-Level `package.json` Template

Each app (`apps/api`, `apps/orchestrator`, etc.) uses this structure:

```json
{
  "name": "@forge-engine/api",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src --ext .ts",
    "test": "jest"
  },
  "dependencies": {
    "@forge-engine/types": "*",
    "@forge-engine/kafka": "*",
    "@forge-engine/redis": "*",
    "@forge-engine/prisma": "*"
  },
  "devDependencies": {
    "ts-node-dev": "^2.0.0",
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0"
  }
}
```

---

## 10. Structured Logger Utility

Create `packages/types/src/logger.ts` — used by **all** services:

```typescript
import pino from 'pino';

export function createLogger(service: string) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
```

Add `pino` and `pino-pretty` as shared dependencies. **No bare `console.log` calls** in application code.

---

## 11. Bootstrap Order for Claude Code

When implementing, follow this exact order:
1. Root `package.json` + `turbo.json` + `tsconfig.base.json`
2. `packages/types` — all TypeScript interfaces and enums
3. `packages/prisma` — Prisma schema + client (see doc `02_database_and_prisma.md`)
4. `packages/kafka` — KafkaJS factory + topic constants
5. `packages/redis` — ioredis + Redlock + key constants
6. `apps/api` — Fastify API service
7. `apps/orchestrator` — Orchestrator consumer
8. `apps/worker` — Worker consumer
9. `apps/scheduler` — Scheduler service
10. `apps/dashboard` — React dashboard
11. `packages/sdk` — Client SDK (can be done in parallel with step 6+)
