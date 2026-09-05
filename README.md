# ReachInbox Outbound Email Scheduler & Distributed Delivery Engine

A production-grade cold outreach email scheduling platform built for scale. Designed to schedule and deliver 1,000+ outreach emails with microsecond sender rate limits, atomic concurrency locks, BullMQ distributed queues without cron jobs, Elasticsearch document search, Google OAuth 2.0 authentication, and automated Slack rate-limit notifications.

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Architecture Overview](#architecture-overview)
4. [Technology Stack](#technology-stack)
5. [Core Engineering & Scheduling Mechanics](#core-engineering--scheduling-mechanics)
   - [BullMQ Delayed Jobs vs. Cron](#bullmq-delayed-jobs-vs-cron)
   - [Worker Concurrency Scaling](#worker-concurrency-scaling)
   - [Minimum Delay Between Sends](#minimum-delay-between-sends)
   - [Distributed Hourly Rate Limiting (Redis Lua)](#distributed-hourly-rate-limiting-redis-lua)
   - [Intelligent Rescheduling (Zero Drops)](#intelligent-rescheduling-zero-drops)
   - [Slack Alert Deduplication](#slack-alert-deduplication)
   - [Idempotency & Duplicate Prevention](#idempotency--duplicate-prevention)
   - [Crash Recovery & Restart Persistence](#crash-recovery--restart-persistence)
   - [Elasticsearch Full-Text Search with Fallback](#elasticsearch-full-text-search-with-fallback)
   - [CSV & TXT Bulk Lead Parsing](#csv--txt-bulk-lead-parsing)
   - [Sender Accounts Management](#sender-accounts-management)
   - [Scheduled vs. Sent & Failed Email Tracking](#scheduled-vs-sent--failed-email-tracking)
   - [Bull Board Real-Time Queue Monitor](#bull-board-real-time-queue-monitor)
   - [High-Volume Load Behavior (1,000+ Emails)](#high-volume-load-behavior-1000-emails)
6. [Known Production SMTP Limitation (Railway)](#known-production-smtp-limitation-railway)
7. [Directory Structure](#directory-structure)
8. [Prerequisites](#prerequisites)
9. [Environment Variables](#environment-variables)
10. [Local Setup & Installation](#local-setup--installation)
    - [1. Infrastructure Containers (Docker)](#1-infrastructure-containers-docker)
    - [2. Database Synchronization](#2-database-synchronization)
    - [3. Backend & Worker Launch](#3-backend--worker-launch)
    - [4. Frontend Launch](#4-frontend-launch)
    - [5. Running the Automated Smoke Test Suite](#5-running-the-automated-smoke-test-suite)
11. [External Integrations Setup](#external-integrations-setup)
    - [Google OAuth 2.0](#google-oauth-20)
    - [Slack OAuth 2.0 & Channel Webhook](#slack-oauth-20--channel-webhook)
    - [Ethereal SMTP Testing](#ethereal-smtp-testing)
12. [Production Deployment Architecture](#production-deployment-architecture)
13. [API Reference](#api-reference)
14. [Assumptions & Design Tradeoffs](#assumptions--design-tradeoffs)
15. [Assignment Requirement Mapping](#assignment-requirement-mapping)
16. [Demo & Evaluation Walkthrough](#demo--evaluation-walkthrough)

---

## Project Overview

ReachInbox Email Scheduler is designed to solve the challenges of outbound email delivery at scale:
- **No Cron Polling**: Instead of periodic database scans, outbound emails are queued as deterministic, timestamped BullMQ delayed jobs backed by Redis sorted sets (`ZSET`).
- **Sender Quotas**: Outbound quotas (e.g., 200 emails/hour) are strictly enforced across horizontally scaled workers using atomic Redis Lua scripts.
- **Inter-Email Spacing**: Configurable delays (e.g., 2,000ms between sends) are reserved globally per sender to protect domain reputation.
- **Fail-Safe Processing**: Transient SMTP errors, worker crashes, or rate limit throttling automatically reschedule jobs without dropping data or double-sending.
- **Multi-Sender Isolation**: Multiple sender email identities can be registered under a single user account, each with independent hourly rate limits and delay pacing.
- **Elasticsearch Search**: Sub-millisecond full-text fuzzy queries across hundreds of thousands of historical emails with graceful PostgreSQL fallback.

---

## Key Features

- **Google OAuth 2.0 Authentication**: Secure authorization code exchange issuing signed JWTs in HttpOnly, SameSite cookies (with Vercel reverse proxy architecture for cross-site cookie isolation).
- **Slack OAuth Integration**: Connects workspace channels to receive automated alerts whenever sender quotas are reached.
- **Bulk Scheduling (1,000+ Recipients)**: Batch inserts in PostgreSQL via `createMany()` and batch enqueue in Redis via `emailQueue.addBulk()`.
- **Lead File Upload**: Drag-and-drop or file upload of `.csv` or `.txt` lead files with in-memory regex extraction and Zod email validation.
- **High-Performance Worker Engine**: Configurable concurrency (`WORKER_CONCURRENCY`) with atomic DB status claims (`SCHEDULED` &rarr; `PROCESSING` &rarr; `SENT`/`FAILED`).
- **Distributed Rate Limiting**: Redis Lua script guarantees thread-safe, multi-worker rate limiting.
- **Zero-Loss Rescheduling**: Exceeded rate limits calculate the exact millisecond offset to the next hour and reschedule delayed jobs automatically.
- **Sent & Failed Email Auditing**: Sent Email Log provides real-time visibility into both `SENT` and `FAILED` email dispatches, including error reasons and timestamp auditing.
- **Elasticsearch Search**: Full-text indexing across recipient, subject, and body with relevance boosting, fuzzy matching, and graceful PostgreSQL fallback.
- **Bull Board Queue Dashboard**: Built-in queue monitor at `/admin/queues` for inspecting active, waiting, delayed, and failed jobs.
- **Modern Responsive UI**: Dark glassmorphic interface built with React 19, TypeScript, Vanilla CSS design tokens, and Lucide icons.

---

## Architecture Overview

```
                                  +---------------------------------------+
                                  |         React 19 + Vite Frontend      |
                                  |    (Dashboard, Scheduler, Search)     |
                                  +-------------------+-------------------+
                                                      |
                                                      | HTTP / REST (with HttpOnly JWT)
                                                      v
                                  +---------------------------------------+
                                  |          Express.js API Server        |
                                  |       (Auth, Emails, Senders, Slack)  |
                                  +---------+-------------------+---------+
                                            |                   |
            +-------------------------------+                   +-------------------------------+
            |                               |                                                   |
            v                               v                                                   v
+-----------------------+       +-----------------------+                           +-----------------------+
|  PostgreSQL 16 DB     |       |    Redis 7 (Cache &   |                           |  Elasticsearch 8.19   |
| (ACID State, Campaign,|       |   BullMQ Queue ZSET)  |                           |  (Full-Text Index &   |
|   Senders, Emails)    |       +-----------+-----------+                           |   Fuzzy Search Query) |
+-----------------------+                   |                                       +-----------+-----------+
            ^                               | Pulls Delayed Jobs                                ^
            |                               v                                                   |
            |                   +-----------------------+                                       |
            +-------------------|   BullMQ Email Worker |---------------------------------------+
            Updates status      | (Concurrency, Rate    |  Indexes sent/failed docs
            & timestamps        |  Limits, Min Delays)  |
                                +-----------+-----------+
                                            |
                         +------------------+------------------+
                         |                                     |
                         v                                     v
             +-----------------------+             +-----------------------+
             | Ethereal / SMTP Relay |             |    Slack Webhook API  |
             |   (Email Dispatch)    |             | (Rate Limit Alerts)   |
             +-----------------------+             +-----------------------+
```

### Complete End-to-End Pipeline
$$\text{React UI} \xrightarrow{\text{REST}} \text{Express API} \xrightarrow{\text{Prisma}} \text{PostgreSQL} \xrightarrow{\text{addBulk}} \text{Redis / BullMQ} \xrightarrow{\text{ZSET Delay}} \text{Worker Pool} \xrightarrow{\text{Nodemailer}} \text{SMTP Relay}$$

1. **User schedules campaign**: Express validates payload, saves records to PostgreSQL as `SCHEDULED`, and pushes jobs with computed millisecond delays to BullMQ.
2. **Redis sorted set (`ZSET`)**: Holds delayed jobs until their target timestamp without holding open database locks or CPU cycles.
3. **BullMQ worker claims job**: Concurrently pulls eligible jobs, validates sender rate limits via Redis Lua, enforces minimum inter-email delay, and atomically claims the database row (`PROCESSING`).
4. **Email dispatch**: Nodemailer transmits the payload to SMTP (Ethereal for testing or production SMTP provider).
5. **State update & search indexing**: On success, row is marked `SENT` with `sentAt`. On error, row is marked `FAILED` with `failureReason`. In both cases, the document is asynchronously indexed into Elasticsearch.

---

## Technology Stack

- **Backend Runtime**: Node.js 20+ (ES Modules, TypeScript 5.9, `tsx`)
- **Web Framework**: Express.js 5
- **Database & ORM**: PostgreSQL 16, Prisma 7 (`@prisma/client`, `@prisma/adapter-pg`)
- **Queue & In-Memory Store**: BullMQ 6, Redis 7 (via `ioredis`)
- **Search Engine**: Elasticsearch 8.19 (`@elastic/elasticsearch`)
- **Queue UI**: Bull Board (`@bull-board/express`, `@bull-board/api`)
- **Email Transport**: Nodemailer (configured for Ethereal SMTP or custom SMTP relays)
- **Frontend Framework**: React 19, TypeScript, Vite 8
- **Styling**: Vanilla CSS Design System with dark glassmorphism (zero Tailwind dependency)
- **Icons**: Lucide React
- **Validation**: Zod schema validation (request bodies, query params, leads)
- **File Ingestion**: Multer (memory-backed buffer streaming)

---

## Core Engineering & Scheduling Mechanics

### BullMQ Delayed Jobs vs. Cron

A common anti-pattern in email schedulers is using cron tasks (e.g., `node-cron` running every minute) to query `SELECT * FROM emails WHERE status = 'SCHEDULED' AND scheduledAt <= NOW()`. This approach suffers from:
1. **Database Contention**: Under high volume (100,000+ rows), recurring table scans introduce row locking and high CPU utilization.
2. **Double-Processing Windows**: Concurrency races between cron ticks require complex row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`).
3. **Resolution Granularity**: Cron is limited to 1-minute intervals, preventing millisecond precision.
4. **Missed Execution Windows**: If the server restarts during a cron tick, scheduled jobs can be delayed or missed entirely without complex offset recovery.

**How ReachInbox Solves This**:
- **Zero Cron Dependencies**: The scheduler uses BullMQ delayed jobs natively backed by Redis Sorted Sets (`ZSET`).
- When an email campaign is scheduled for `scheduledAt`:
  $$\text{delay} = \max(0, \text{scheduledAt} - \text{Date.now()})$$
- The job is added directly to Redis:
  ```typescript
  await emailQueue.add(
    "send-email",
    { emailId: email.id, senderId, recipient, subject, body },
    { delay, jobId: email.jobId }
  );
  ```
- Redis schedules the key in its internal timer heap. When the delay elapses, Redis pushes the job into the active queue with sub-millisecond precision.

---

### Worker Concurrency Scaling

The worker pool concurrency is driven by the `WORKER_CONCURRENCY` environment variable:
```typescript
export const emailWorker = new Worker(
  "email-scheduler",
  async (job: Job) => { /* execution */ },
  {
    connection: redis,
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 1,
  }
);
```
- Each worker instance processes up to $N$ jobs concurrently across asynchronous event loops.
- Horizontal scaling is achieved by running multiple worker processes on the same machine or across distinct container nodes without duplicate sends.

---

### Minimum Delay Between Sends

To protect domain reputation and prevent spam filters from flagging bulk bursts, an inter-email delay (default: 2,000ms) is enforced through a two-tier strategy:

1. **Schedule Spacing**: When inserting 1,000 recipients at campaign creation, the scheduled times are spaced incrementally:
   $$\text{scheduledAt}_i = \text{startTime} + (i \times \text{delayBetweenEmailsMs})$$
2. **Worker Distributed Lock**: If concurrent workers pick up jobs out-of-order or after an ungraceful restart, a distributed Redis Lua script reserves the next allowable execution timestamp per sender:
   ```lua
   local key = KEYS[1]
   local now = tonumber(ARGV[1])
   local delay = tonumber(ARGV[2])
   local nextAllowed = tonumber(redis.call('GET', key) or '0')

   if now < nextAllowed then
       return {0, nextAllowed}
   else
       redis.call('SET', key, now + delay, 'EX', ttl)
       return {1, now + delay}
   end
   ```
   If the delay has not elapsed, the worker reschedules the job for $\text{nextAllowed} - \text{now}$ without dropping it.

---

### Distributed Hourly Rate Limiting (Redis Lua)

Rate limiting operates per-sender in atomic 1-hour tumbling windows using Redis Lua script execution:
- Key pattern: `ratelimit:sender:<senderId>:<currentHourIndex>`
- Where `currentHourIndex = floor(Date.now() / 3600000)`
- The Lua script atomically increments the counter:
  - If counter $\le$ limit: returns allowed.
  - If counter $>$ limit: decrements counter and returns the timestamp of the start of the next hour.
- **Fail-Closed Guarantee**: If Redis is unreachable, the rate limiter throws an error, causing the job to safely fail and retry rather than bypassing the quota.

---

### Intelligent Rescheduling (Zero Drops)

When a sender exceeds their hourly quota, jobs are **never discarded**. The system performs the following:
1. Calculates the millisecond offset until the next hour starts:
   $$\text{delayMs} = \text{nextHourStartMs} - \text{Date.now()}$$
2. Reverts the email record status to `SCHEDULED` in PostgreSQL.
3. Generates a deterministic rescheduling job ID: `email-<id>-ratelimit-<timestamp>`.
4. Re-enqueues the job into BullMQ with `delay: delayMs`.
5. Dispatches an automated Slack alert notifying the team of the reschedule event.

---

### Slack Alert Deduplication

To prevent alert flooding when a burst of emails exceeds the hourly limit, alerts are deduplicated in Redis:
- Key: `ratelimit:slack_alert:<senderId>:<currentHourBucket>`
- Implemented with Redis atomic `SET NX` and a 1-hour TTL (3,600s).
- Exactly **one alert** is dispatched per sender per hourly window. Subsequent throttled emails in the same hour skip sending redundant Slack webhooks.

---

### Idempotency & Duplicate Prevention

Duplicate sends are prevented at multiple levels:
1. **PostgreSQL Schema Constraints**:
   - `idempotencyKey String @unique`
   - `jobId String @unique`
2. **BullMQ Job Deduplication**: BullMQ ignores duplicate job submissions sharing the same `jobId`.
3. **Worker Pre-flight Verification**: Before attempting SMTP dispatch, the worker checks:
   ```typescript
   if (email.status === EmailStatus.SENT || email.status === EmailStatus.FAILED) {
     return { status: "ALREADY_PROCESSED" };
   }
   ```
4. **Atomic DB Claiming**: Workers atomically transition the row from `SCHEDULED` to `PROCESSING`:
   ```typescript
   const claim = await prisma.email.updateMany({
     where: { id: email.id, status: EmailStatus.SCHEDULED },
     data: { status: EmailStatus.PROCESSING }
   });
   if (claim.count === 0) return; // Another worker claimed this email
   ```

---

### Crash Recovery & Restart Persistence

- **Redis Persistence**: Redis is configured with Docker volume `redis_data:/data` and AOF/RDB persistence, preserving all pending BullMQ delayed jobs across container reboots.
- **PostgreSQL Persistence**: Stored on disk via volume `postgres_data`.
- **Stale Processing Recovery**: If a worker crashes mid-flight while an email is marked `PROCESSING`, the atomic claim query reclaims stale processing rows older than 5 minutes:
   ```typescript
   where: {
     id: email.id,
     OR: [
       { status: EmailStatus.SCHEDULED },
       { status: EmailStatus.PROCESSING, updatedAt: { lt: fiveMinutesAgo } }
     ]
   }
   ```

---

### Elasticsearch Full-Text Search with Fallback

- **Index Initialization**: The `ensureIndex()` utility creates the `emails` index with mapped fields (`id`, `userId`, `senderId`, `recipient`, `subject`, `body`, `status`, `scheduledAt`, `sentAt`, `failureReason`) if it does not exist.
- **Real-Time Indexing**: When an email is marked `SENT` or `FAILED`, `indexEmailDocument()` indexes the record into Elasticsearch under document ID `email.id`.
- **Fuzzy Search**: Multi-match queries search across `recipient^3`, `subject^2`, and `body` with `fuzziness: "AUTO"`.
- **Resilient Fallback**: If Elasticsearch is offline or unreachable, the search route automatically falls back to a PostgreSQL `ILIKE` query and sets `source: "postgresql_fallback"` in the JSON response, ensuring zero UI downtime.

---

### CSV & TXT Bulk Lead Parsing

- Implemented via `multer.memoryStorage()` (files are never written to disk, preventing filesystem clutter).
- Uses regular expressions to extract valid email addresses from any delimited format (comma, newline, tab, semicolon).
- Deduplicates list, parses through Zod email validator, and returns validated recipient array to the scheduler UI.

---

### Sender Accounts Management

- Users can register and manage multiple sender email accounts under **Sender Accounts**.
- Each sender profile maintains:
  - `name`: Display identity (e.g., "Sales Outreach Team")
  - `email`: Outbound sender email address
  - `delayBetweenEmailsMs`: Custom delay between sends (e.g., 2,000ms)
  - `hourlyLimit`: Maximum emails allowed per hour (e.g., 200/hr)
- Rate limiting and spacing calculations are partitioned per sender ID, allowing users to safely run concurrent campaigns across multiple mailboxes.

---

### Scheduled vs. Sent & Failed Email Tracking

The dashboard provides dedicated visibility into both stages of email delivery:
1. **Scheduled Emails Tab**: Displays upcoming queued emails, scheduled dispatch time, status badge (`SCHEDULED`), and associated BullMQ Job ID.
2. **Sent Emails Tab**: Displays the complete dispatch history:
   - Recipient email address
   - Subject line
   - Sent time (`sentAt` formatted timestamp or "N/A" if delivery failed)
   - Dynamic status badge: `badge-sent` for `SENT` records or `badge-failed` for `FAILED` records
   - Clicking any row opens an **Email Detail Modal** displaying full debugging metadata, including `jobId`, `idempotencyKey`, and the exact `failureReason` returned by the transport.

---

### Bull Board Real-Time Queue Monitor

- Accessible at: `http://localhost:5000/admin/queues` (or via the dashboard top navigation).
- Mounted directly into Express using `@bull-board/express` and `@bull-board/api/bullMQAdapter`.
- Express Helmet is configured with `contentSecurityPolicy: false` to allow Bull Board's React dashboard assets to render without CSP violations.
- Real-time visibility into: Active, Waiting, Completed, Failed, Delayed, and Paused jobs with manual retry capabilities.

---

### High-Volume Load Behavior (1,000+ Emails)

When scheduling campaigns with 1,000+ recipients, the system optimizes throughput and resource utilization:
1. **Batch Database Insertion**: Recipients are inserted into PostgreSQL using Prisma's `createMany()`, avoiding 1,000 sequential round-trips.
2. **Bulk Queue Ingestion**: BullMQ delayed jobs are submitted in a single bulk transaction via `emailQueue.addBulk()`, saving Redis network overhead.
3. **Non-Blocking Timer Heap**: Redis stores all 1,000+ jobs as timestamped scores in a `ZSET`. Workers only pull jobs when their delay timer fires, consuming virtually zero CPU while idle.
4. **Memory Efficiency**: CSV/TXT files are streamed in memory and garbage-collected immediately after parsing.

---

## Known Production SMTP Limitation (Railway)

> [!IMPORTANT]
> **Railway Outbound SMTP Restriction Note**  
> On Railway's free/hobby plans, **outbound raw TCP connections on SMTP ports (25, 465, 587, 2525) are blocked by platform network policy** to prevent abuse.
>
> **Production Behavior**:  
> In the deployed Railway environment, when the BullMQ worker triggers an email dispatch attempt to Ethereal SMTP (`smtp.ethereal.email:587`), the connection times out:
> ```text
> Connection timeout
> ```
> The worker handles this gracefully by design:
> 1. Transitions the record status from `PROCESSING` to `FAILED`.
> 2. Records `failureReason: "Connection timeout"`.
> 3. Indexes the failed record into Elasticsearch.
> 4. Displays the failed email in the **Sent Emails** tab with the `FAILED` status badge and full failure details in the inspection modal.
>
> **Verified Local Delivery**:  
> The entire email pipeline — including successful Ethereal SMTP transmission, message ID generation, `SENT` status transition, `sentAt` timestamp recording, and Bull Board completion — was **fully verified end-to-end locally** using the automated test suite (`npm run test:smoke`), where outbound port 587 is unblocked.

---

## Directory Structure

```
reachinbox-email-scheduler/
├── docker-compose.yml              # PostgreSQL, Redis, Elasticsearch orchestration
├── .gitignore                      # Git exclusion rules (safeguarding .env and build files)
├── README.md                       # Comprehensive system documentation
├── backend/
│   ├── .env.example                # Backend environment variable template
│   ├── package.json                # Dependencies, scripts (dev, worker, build, start, test:smoke)
│   ├── tsconfig.json               # Backend TypeScript configuration
│   ├── prisma/
│   │   └── schema.prisma           # Relational schema (User, Sender, EmailCampaign, Email, SlackConnection)
│   └── src/
│       ├── config.ts               # Hot-reloading environment loader with runtime precedence
│       ├── server.ts               # Express entrypoint, middleware, Bull Board mounting
│       ├── redis.ts                # Shared IORedis connection instance
│       ├── prisma.ts               # PrismaClient instance
│       ├── smoke-test.ts           # Automated end-to-end integration test suite
│       ├── middleware/
│       │   └── auth.middleware.ts  # JWT HttpOnly cookie and Bearer header verification
│       ├── queues/
│       │   └── email.queue.ts      # BullMQ queue instantiation ("email-scheduler")
│       ├── workers/
│       │   └── email.worker.ts     # BullMQ worker: concurrency, delays, rate-limiting, dispatch
│       ├── services/
│       │   ├── email.service.ts    # Nodemailer transport service
│       │   ├── rate-limiter.ts     # Redis Lua distributed rate-limiting engine
│       │   ├── slack.service.ts    # Slack notification dispatcher & deduplicator
│       │   └── elasticsearch.service.ts # Elasticsearch indexing, ensureIndex, and fuzzy search
│       └── routes/
│           ├── auth.routes.ts      # Google OAuth 2.0 & session routes
│           ├── sender.routes.ts    # Sender identity management
│           ├── slack.routes.ts     # Slack OAuth connect & callback
│           └── email.routes.ts     # Scheduling, leads upload, search, analytics
└── frontend/
    ├── .env.example                # Frontend environment variable template
    ├── package.json                # Dependencies, scripts (dev, build, preview)
    ├── vite.config.ts              # Vite configuration
    ├── index.html                  # HTML document root with Inter typography
    └── src/
        ├── main.tsx                # React DOM mount point
        ├── App.tsx                 # Root component with auth session hydration
        ├── App.css                 # Base styles and reset
        ├── index.css               # Design system, glassmorphism, responsive grid
        ├── types/
        │   └── index.ts            # TypeScript interfaces matching backend models
        ├── services/
        │   └── api.ts              # Fetch wrapper with credentials and error handling
        └── components/
            ├── LoginPage.tsx       # Google OAuth login landing view
            └── Dashboard.tsx       # Main dashboard: compose, scheduled, sent, search, slack, metrics
```

---

## Prerequisites

Ensure you have the following installed on your host machine:
- **Node.js**: v18.0.0 or later (v20+ recommended)
- **npm**: v9.0.0 or later
- **Docker & Docker Compose**: v2.20+ (for local infrastructure containers)
- **Git**

---

## Environment Variables

> **Important**: Never commit actual secrets to version control. Reference templates are provided in `backend/.env.example` and `frontend/.env.example`.

### Backend (`backend/.env`)

| Variable Name | Description | Default / Example Value |
|---|---|---|
| `PORT` | HTTP port for the Express backend server | `5000` |
| `NODE_ENV` | Application environment mode | `development` or `production` |
| `FRONTEND_URL` | URL of the frontend application (for CORS and OAuth redirect) | `http://localhost:5173` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/reachinbox?schema=public` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `REDIS_HOST` | Redis host (alternative to REDIS_URL) | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (if authentication is enabled) | *(blank)* |
| `ELASTICSEARCH_NODE`| HTTP endpoint for Elasticsearch | `http://localhost:9200` |
| `ELASTICSEARCH_API_KEY`| Optional API key for Elastic Cloud deployments | *(blank or API key)* |
| `ELASTICSEARCH_INDEX`| Elasticsearch index name for email documents | `emails` |
| `JWT_SECRET` | Secret key used to sign session cookies and OAuth state tokens | *(strong random secret)* |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from Google Cloud Console | `*.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret from Google Cloud Console | *(Google secret)* |
| `GOOGLE_REDIRECT_URI` | Authorized redirect URI for Google OAuth | `http://localhost:5000/api/auth/google/callback` |
| `SLACK_CLIENT_ID` | Client ID from Slack App configuration | `*.slack.com` |
| `SLACK_CLIENT_SECRET` | Client Secret from Slack App configuration | *(Slack secret)* |
| `SLACK_REDIRECT_URI` | Authorized redirect URI for Slack OAuth | `http://localhost:5000/api/slack/callback` |
| `ETHEREAL_SMTP_HOST` | SMTP server hostname | `smtp.ethereal.email` |
| `ETHEREAL_SMTP_PORT` | SMTP server port | `587` |
| `ETHEREAL_SMTP_USER` | Ethereal or custom SMTP account username | *(Ethereal user)* |
| `ETHEREAL_SMTP_PASS` | Ethereal or custom SMTP account password | *(Ethereal pass)* |
| `WORKER_CONCURRENCY` | Concurrent email delivery jobs per worker instance | `5` |
| `DEFAULT_DELAY_MS` | Default minimum delay between consecutive emails for a sender | `2000` |
| `DEFAULT_HOURLY_LIMIT`| Default maximum emails allowed per sender per hour | `200` |

### Frontend (`frontend/.env`)

| Variable Name | Description | Default Value |
|---|---|---|
| `VITE_API_BASE_URL` | Base HTTP endpoint for the backend API | `http://localhost:5000` |

---

## Local Setup & Installation

### 1. Infrastructure Containers (Docker)

Start PostgreSQL, Redis, and Elasticsearch in the background:

```bash
docker compose up -d
```

Verify that all three services are healthy:

```bash
docker compose ps
```

Port bindings:
- **PostgreSQL**: `localhost:5432`
- **Redis**: `localhost:6379`
- **Elasticsearch**: `localhost:9200`

### 2. Database Synchronization

Navigate to the `backend` directory, install dependencies, and push the Prisma schema to PostgreSQL:

```bash
cd backend
npm install
npx prisma db push
```

*(Optional)* Launch Prisma Studio to visually inspect database tables:
```bash
npx prisma studio
```

### 3. Backend & Worker Launch

Open a terminal in the `backend` directory and start the Express API server:

```bash
# Terminal 1: Start Express API server
cd backend
npm run dev
```

In a separate terminal, start the dedicated BullMQ email worker:

```bash
# Terminal 2: Start BullMQ email worker
cd backend
npm run worker
```

> **Note**: In development, running `npm run worker` starts the dedicated worker process. In production on single-container platforms, `server.ts` automatically starts an embedded worker instance if no standalone worker is spawned.

### 4. Frontend Launch

Open a terminal in the `frontend` directory, install dependencies, and start the Vite development server:

```bash
# Terminal 3: Start Vite frontend
cd frontend
npm install
npm run dev
```

Open your browser and navigate to `http://localhost:5173`.

### 5. Running the Automated Smoke Test Suite

The repository includes a comprehensive 7-phase automated smoke test that exercises the entire pipeline end-to-end:

```bash
cd backend
npm run test:smoke
```

**Test Coverage**:
- Phase 1: Database & Redis connectivity
- Phase 2: User & sender creation
- Phase 3: Immediate email dispatch via BullMQ & Ethereal SMTP
- Phase 4: Delayed email scheduling (5,000ms delay verification)
- Phase 5: Rate limit throttling & automatic hour-boundary rescheduling
- Phase 6: Slack alert dispatch & Redis deduplication
- Phase 7: Elasticsearch indexing and fuzzy search

---

## External Integrations Setup

### Google OAuth 2.0

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and configure the **OAuth consent screen** (User Type: External).
3. Under **Credentials**, create an **OAuth 2.0 Client ID** (Application type: Web application).
4. Add the following to **Authorized redirect URIs**:
   - For local development:
     ```
     http://localhost:5000/api/auth/google/callback
     ```
   - For production (with reverse proxy):
     ```
     https://<your-frontend-domain>/api/auth/google/callback
     ```
5. Copy the Client ID and Client Secret into `backend/.env`.

### Slack OAuth 2.0 & Channel Webhook

1. Go to [Slack API: Your Apps](https://api.slack.com/apps) and create a new App from scratch.
2. Under **OAuth & Permissions**, add the following **Bot Token Scopes**:
   - `chat:write` (to post rate-limit notifications)
   - `channels:read` (to inspect public channels)
   - `groups:read` (to inspect private channels)
   - `incoming-webhook` (to link directly to a designated alert channel)
3. Add the **Redirect URL**:
   - Local: `http://localhost:5000/api/slack/callback`
   - Production: `https://<your-frontend-domain>/api/slack/callback`
4. Copy Client ID and Secret into `backend/.env`.
5. In the ReachInbox dashboard, navigate to **Slack Integration** and click **Connect Slack Workspace**.

### Ethereal SMTP Testing

[Ethereal](https://ethereal.email/) is a fake SMTP service where messages never leave the test sandbox:
1. Visit [ethereal.email/create](https://ethereal.email/create) to generate disposable credentials.
2. Copy the credentials into `backend/.env`:
   ```env
   ETHEREAL_SMTP_HOST=smtp.ethereal.email
   ETHEREAL_SMTP_PORT=587
   ETHEREAL_SMTP_USER=your_username@ethereal.email
   ETHEREAL_SMTP_PASS=your_ethereal_password
   ```

---

## Production Deployment Architecture

The application is deployed across modern cloud services:

```
+-------------------------------------------------------------------------------+
|                                  Vercel Edge                                  |
|   Frontend: https://reachinbox-email-scheduler-wine.vercel.app                |
|   Rewrites: /api/:path* -> Railway Backend (Same-Origin Cookie Preservation)   |
+---------------------------------------+---------------------------------------+
                                        | HTTPS
                                        v
+-------------------------------------------------------------------------------+
|                                Railway Cloud                                  |
|   Backend Service: Express 5 API Server + Embedded BullMQ Worker              |
|   In-Memory Queue: Managed Redis 7 Service (Private Networking)               |
+-------------------+-----------------------------------+-----------------------+
                    |                                   |
                    v                                   v
+---------------------------------------+   +-----------------------------------+
|               Neon Tech               |   |            Elastic Cloud          |
|   Serverless PostgreSQL 16 Database   |   |   Managed Elasticsearch 8.19      |
+---------------------------------------+   +-----------------------------------+
```

### Vercel Reverse Proxy Architecture (Cross-Site Cookie Handling)
Browsers strictly enforce third-party cookie restrictions under modern cross-site policies (Partitioned/SameSite). To ensure smooth Google OAuth authentication:
- Vercel acts as the single unified origin (`reachinbox-email-scheduler-wine.vercel.app`).
- `vercel.json` proxies all `/api/*` traffic directly to Railway.
- The browser treats the auth cookie as first-party, ensuring sessions persist seamlessly without cross-site cookie drops.

---

## API Reference

All protected endpoints require an active session via the HttpOnly `token` cookie or a `Bearer <token>` Authorization header.

### Authentication (`/api/auth`)
- `GET /api/auth/google` - Initiates Google OAuth 2.0 authorization code flow.
- `GET /api/auth/google/callback` - OAuth callback endpoint; exchanges code, sets cookie, redirects to dashboard.
- `GET /api/auth/me` - Returns current authenticated user profile (`id`, `name`, `email`, `avatarUrl`).
- `POST /api/auth/logout` - Clears session cookie and invalidates session.

### Senders (`/api/senders`)
- `GET /api/senders` - Lists all registered senders for the authenticated user.
- `POST /api/senders` - Creates or updates a sender (`email`, `name`, `delayBetweenEmailsMs`, `hourlyLimit`).
- `GET /api/senders/:id` - Retrieves a specific sender's configuration.

### Emails & Scheduling (`/api/emails`)
- `POST /api/emails/upload-leads` - Accepts multipart `.csv` or `.txt` file; returns extracted recipient emails.
- `POST /api/emails/schedule` - Schedules an email campaign for 1 to 1,000+ recipients.
  - *Payload*:
    ```json
    {
      "senderId": "cl...",
      "recipients": ["user1@example.com", "user2@example.com"],
      "subject": "Outreach Subject",
      "body": "<p>Outreach Body</p>",
      "startTime": "2026-09-10T14:30:00.000Z",
      "delayBetweenEmailsMs": 2000,
      "hourlyLimit": 200,
      "name": "Q4 Campaign"
    }
    ```
- `GET /api/emails/scheduled` - Paginated list of currently scheduled emails.
- `GET /api/emails/sent` - Paginated list of processed emails (**both `SENT` and `FAILED` records**), sorted by `sentAt` descending with fallback to `createdAt` descending.
- `GET /api/emails/metrics` - Aggregated counts (`total`, `scheduled`, `processing`, `sent`, `failed`, `successRate`).
- `GET /api/emails/search?q=query` - Full-text search across recipient, subject, and body using Elasticsearch with PostgreSQL fallback.
- `GET /api/emails/:id` - Retrieves full metadata and body for a single email record.

### Slack Integration (`/api/slack`)
- `GET /api/slack/connect` - Initiates Slack OAuth 2.0 flow.
- `GET /api/slack/callback` - Slack OAuth callback; exchanges token and stores channel integration.
- `GET /api/slack/status` - Returns Slack connection state without exposing tokens.
- `POST /api/slack/disconnect` - Disconnects Slack workspace.

### Health & Monitoring
- `GET /admin/queues` - Bull Board administrative queue interface.
- `GET /api/health` - Backend application health check.
- `GET /api/health/db` - PostgreSQL database connection test.

---

## Assumptions & Design Tradeoffs

1. **Tumbling vs. Sliding Window Rate Limiting**:
   - *Design Choice*: Hourly rate limits use 1-hour tumbling buckets (`currentHourIndex = floor(now / 3600000)`).
   - *Rationale*: Tumbling windows provide $O(1)$ memory consumption in Redis and enable deterministic calculation of `nextHourStartMs` for exact rescheduling.
2. **Elasticsearch Resilient Degradation**:
   - *Design Choice*: Elasticsearch indexing is fire-and-forget in the background of the worker, and search queries fall back to PostgreSQL `ILIKE` on error.
   - *Rationale*: Search engine outages should never halt outbound email delivery or prevent users from inspecting their scheduled queue.
3. **Session Management via HttpOnly Cookies**:
   - *Design Choice*: JWT tokens are stored in HttpOnly, SameSite cookies rather than browser `localStorage`.
   - *Rationale*: Eliminates XSS token extraction vectors.
4. **Sent Email Log Scope**:
   - *Design Choice*: `GET /api/emails/sent` returns both `SENT` and `FAILED` email attempts.
   - *Rationale*: Operators require immediate visibility into delivery failures (such as SMTP connection timeouts) alongside successful sends to audit campaigns.

---

## Assignment Requirement Mapping

| # | Assignment Requirement | Implementation Location | Verification Method |
|---|---|---|---|
| 1 | Google OAuth Login | `backend/src/routes/auth.routes.ts`, `frontend/src/components/LoginPage.tsx` | End-to-end authorization code flow, JWT cookie issuance |
| 2 | Slack OAuth & Notifications | `backend/src/routes/slack.routes.ts`, `backend/src/services/slack.service.ts` | Signed state token, Redis-deduplicated alert dispatch |
| 3 | BullMQ Delayed Jobs (No Cron) | `backend/src/queues/email.queue.ts`, `backend/src/workers/email.worker.ts` | Zero cron packages; delayed jobs backed by Redis sorted sets |
| 4 | Restart Persistence | `docker-compose.yml`, `backend/src/workers/email.worker.ts` | Docker volume mounts; recovery query for stale processing jobs |
| 5 | Duplicate Send Prevention | `backend/prisma/schema.prisma`, `backend/src/workers/email.worker.ts` | `@unique` idempotency keys, deterministic job IDs, atomic DB updates |
| 6 | Hourly Rate Limit & Reschedule | `backend/src/services/rate-limiter.ts`, `backend/src/workers/email.worker.ts` | Atomic Redis Lua script; delay calculation to next hour start |
| 7 | Minimum Delay Between Sends | `backend/src/workers/email.worker.ts`, `backend/src/routes/email.routes.ts` | Scheduling offset + Redis Lua inter-delay check |
| 8 | Configurable Concurrency | `backend/src/workers/email.worker.ts` | `concurrency: Number(process.env.WORKER_CONCURRENCY) \|\| 1` |
| 9 | 1,000+ Email Bulk Scheduling | `backend/src/routes/email.routes.ts` | `prisma.email.createMany()` + `emailQueue.addBulk()` |
| 10 | PostgreSQL Scheduling State | `backend/prisma/schema.prisma` | Relational schema, composite indexes, typed status enum |
| 11 | Elasticsearch Search | `backend/src/services/elasticsearch.service.ts`, `backend/src/routes/email.routes.ts` | Real-time indexing, multi-match boosting, PostgreSQL fallback |
| 12 | CSV / TXT Lead Upload | `backend/src/routes/email.routes.ts`, `frontend/src/components/Dashboard.tsx` | Multer memory buffer, regex extraction, Zod email validation |
| 13 | Scheduled & Sent Views | `frontend/src/components/Dashboard.tsx` | Tabular queues, status badges (`SENT` & `FAILED`), detail modal |
| 14 | Loading, Empty & Error States | `frontend/src/components/Dashboard.tsx`, `frontend/src/App.tsx` | Spinners, empty table placeholders, banner alerts |
| 15 | Bull Board Queue Monitor | `backend/src/server.ts`, `frontend/src/components/Dashboard.tsx` | Express adapter mounted at `/admin/queues` with header link |
| 16 | Environment Variables | `backend/.env.example`, `frontend/.env.example` | Standardized variable names; zero hardcoded secrets |
| 17 | Frontend Production Build | `frontend/` | `npm run build` passes with zero errors |
| 18 | Backend TypeScript Compilation | `backend/` | `npx tsc --noEmit` passes with zero errors |
| 19 | Comprehensive Documentation | `README.md` | Complete coverage of setup, architecture, and mechanics |
| 20 | Automated Integration Testing | `backend/src/smoke-test.ts` | 7-phase automated smoke test passing with 100% success |

---

## Demo & Evaluation Walkthrough

### Option A: Local Evaluation (Recommended for Full SMTP Verification)
1. Clone the repository and navigate to the project directory:
   ```bash
   git clone https://github.com/Chinmayi-N978/reachinbox-email-scheduler.git
   cd reachinbox-email-scheduler
   ```
2. Start the local infrastructure:
   ```bash
   docker compose up -d
   ```
3. Set up the backend:
   ```bash
   cd backend
   npm install
   npx prisma db push
   ```
4. Run the automated end-to-end smoke test suite:
   ```bash
   npm run test:smoke
   ```
   *This executes all 7 phases, proving real SMTP delivery via Ethereal, delayed job scheduling, rate limiting, and Elasticsearch search.*
5. Launch the application:
   ```bash
   # Terminal 1: Backend
   npm run dev

   # Terminal 2: Worker
   npm run worker

   # Terminal 3: Frontend
   cd ../frontend && npm install && npm run dev
   ```
6. Visit `http://localhost:5173` to test the UI.

### Option B: Production Deployment Inspection
- **Live Frontend**: [https://reachinbox-email-scheduler-wine.vercel.app](https://reachinbox-email-scheduler-wine.vercel.app)
- **Backend Health Check**: [https://reachinbox-email-scheduler-production-c354.up.railway.app/api/health](https://reachinbox-email-scheduler-production-c354.up.railway.app/api/health)
- **Database Connection Check**: [https://reachinbox-email-scheduler-production-c354.up.railway.app/api/health/db](https://reachinbox-email-scheduler-production-c354.up.railway.app/api/health/db)
- **Bull Board Queue Monitor**: [https://reachinbox-email-scheduler-production-c354.up.railway.app/admin/queues](https://reachinbox-email-scheduler-production-c354.up.railway.app/admin/queues)
