# ReachInbox Email Scheduler & Outbound Delivery Engine

A production-grade cold outreach email scheduling platform built for scale. Features BullMQ distributed delayed queues without cron jobs, Redis Lua rate limiting, atomic concurrency locks, PostgreSQL persistence, Elasticsearch document search, Google OAuth 2.0 authentication, and automated Slack rate-limit notifications.

---

## 1. How to Run Backend

### Prerequisites
- Node.js 20+
- Docker & Docker Compose (for local PostgreSQL, Redis, and Elasticsearch)

### Step 1: Start Infrastructure Services
From the repository root, start PostgreSQL, Redis, and Elasticsearch in detached mode:
```bash
docker compose up -d
```

### Step 2: Configure Environment Variables
Navigate to the `backend` directory and copy the environment template:
```bash
cd backend
cp .env.example .env
```
Fill in the required configuration in `backend/.env` (see [Section 3](#3-ethereal-email--environment-variables)).

### Step 3: Install Dependencies & Run Database Migrations
This project uses Prisma's migration history (`prisma/migrations`) to ensure schema synchronization:
```bash
npm install
npx prisma generate
npx prisma migrate deploy
```

### Step 4: Start the Express Backend API
Run the backend API server in development mode:
```bash
npm run dev
```
The backend starts at `http://localhost:5000`.
- Health Check: `http://localhost:5000/api/health`
- Bull Board Queue Monitor: `http://localhost:5000/admin/queues`

### Step 5: Start the BullMQ Worker
In a separate terminal window, navigate to the `backend` directory and start the email worker:
```bash
cd backend
npm run worker
```
The worker connects to Redis, listens to the `email-scheduler` queue, claims matured delayed jobs, enforces rate limits, dispatches emails via SMTP, and updates status in PostgreSQL and Elasticsearch.

---

## 2. How to Run Frontend

### Step 1: Navigate to Frontend Directory
From the repository root:
```bash
cd frontend
```

### Step 2: Configure Environment Variables
Create `frontend/.env` (or copy from `frontend/.env.example`):
```bash
cp .env.example .env
```
Ensure the API base URL points to your running backend:
```env
VITE_API_BASE_URL=http://localhost:5000
```

### Step 3: Install Dependencies & Start Frontend
```bash
npm install
npm run dev
```
The frontend starts at `http://localhost:5173`. Open your browser to access the ReachInbox dashboard.

---

## 3. Ethereal Email + Environment Variables

### Setting Up Ethereal Email
Ethereal is a fake SMTP service for testing email delivery without sending to real inboxes:
1. Go to [https://ethereal.email/create](https://ethereal.email/create) to generate a free test account.
2. Note the generated credentials:
   - **Host**: `smtp.ethereal.email`
   - **Port**: `587`
   - **Username**: `<generated_ethereal_user>`
   - **Password**: `<generated_ethereal_pass>`
3. Add these credentials to your `backend/.env` file.
4. Sent emails can be inspected directly in the Ethereal web mailbox at [https://ethereal.email/messages](https://ethereal.email/messages).

### Required Environment Variables

> **Security Note**: Never commit actual secrets, passwords, or API keys. The following tables list variable names and placeholder examples.

#### Backend (`backend/.env`)

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Express server port | `5000` |
| `NODE_ENV` | Environment mode | `development` |
| `FRONTEND_URL` | Frontend origin URL for CORS and cookie cookies | `http://localhost:5173` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/reachinbox?schema=public` |
| `REDIS_URL` | Redis connection string for BullMQ & rate limits | `redis://localhost:6379` |
| `JWT_SECRET` | Secret key for signing session tokens | `your_jwt_secret_key_here` |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID | `your_google_client_id` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret | `your_google_client_secret` |
| `GOOGLE_REDIRECT_URI` | Google OAuth redirect callback URL | `http://localhost:5000/api/auth/google/callback` |
| `ETHEREAL_SMTP_HOST` | Ethereal SMTP hostname | `smtp.ethereal.email` |
| `ETHEREAL_SMTP_PORT` | Ethereal SMTP port | `587` |
| `ETHEREAL_SMTP_USER` | Ethereal account username | `your_ethereal_username` |
| `ETHEREAL_SMTP_PASS` | Ethereal account password | `your_ethereal_password` |
| `WORKER_CONCURRENCY` | Number of concurrent jobs per worker process | `5` |
| `DEFAULT_DELAY_MS` | Default minimum delay between sends (ms) | `2000` |
| `DEFAULT_HOURLY_LIMIT` | Default maximum sends per sender per hour | `200` |
| `SLACK_CLIENT_ID` | Slack OAuth App Client ID | `your_slack_client_id` |
| `SLACK_CLIENT_SECRET` | Slack OAuth App Client Secret | `your_slack_client_secret` |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL | `http://localhost:5000/api/slack/callback` |
| `ELASTICSEARCH_NODE` | Elasticsearch cluster endpoint | `http://localhost:9200` |
| `ELASTICSEARCH_INDEX` | Elasticsearch index name | `emails` |

#### Frontend (`frontend/.env`)

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | Base URL of the backend API | `http://localhost:5000` |

---

## 4. Architecture Overview

### How Email Scheduling Works (No Cron Jobs)
- When a campaign is submitted via `POST /api/emails/schedule`, the backend calculates the exact execution timestamp for each recipient:
  $$\text{scheduledAt}_i = \text{startTime} + (i \times \text{delayBetweenEmailsMs})$$
- The API saves all recipient rows to PostgreSQL with status `SCHEDULED` using `prisma.email.createMany()`.
- The jobs are immediately enqueued into Redis via BullMQ's `emailQueue.addBulk()`, setting `delay: Math.max(0, scheduledAt - Date.now())`.
- Redis stores delayed jobs in a sorted set (`ZSET`) indexed by target execution timestamp.
- **Zero Cron Polling**: Instead of periodic database scans, BullMQ uses an internal timer mechanism to promote delayed jobs into the active queue the exact millisecond they mature.

### Persistence Across Server Restart
- **Durable Relational State**: PostgreSQL is the persistent source of truth for all application and email records (campaigns, emails, status, timestamps, attempt counts, idempotency keys).
- **Durable Queue State**: BullMQ stores queued and delayed job state in Redis. In the local Docker setup, Redis data is persisted through the mounted `redis_data` volume and Redis's default RDB snapshot persistence. The production Redis service provides its own managed persistence.
- **Restart Recovery**: If the API server, worker, or host restarts, scheduled jobs remain persisted in Redis and PostgreSQL. When the worker resumes, it picks up delayed jobs from their scheduled timestamps without losing pending emails or causing duplicate sends.
- **Crash Recovery**: If a worker crashes mid-send, emails stuck in `PROCESSING` for more than 5 minutes can be safely reclaimed.

### Rate Limiting Implementation
- **Distributed Hourly Rate Limiter (Atomic Redis Lua)**:
  Rate limits are enforced across multiple worker processes using an atomic Lua script (`ratelimit:sender:<senderId>:<hourBucket>`). When a sender reaches their hourly quota:
  - The job is **not failed or dropped**.
  - It calculates the millisecond offset until the next hour window begins.
  - The job is rescheduled in BullMQ with that delay, updating `scheduledAt` in PostgreSQL to preserve delivery order.
- **Minimum Delay Pacing Between Sends**:
  An atomic Redis token reservation script (`ratelimit:sender_delay:<senderId>`) tracks the timestamp when the next send is allowed for a sender. If the minimum delay (e.g., 2,000ms) has not elapsed, the job is deferred by the remaining milliseconds.
- **Slack Rate-Limit Alert**:
  When a sender breaches their hourly quota, the worker sends an automated alert to the user's connected Slack channel. Alerts use a Redis deduplication key (`SET NX` with 1-hour TTL) to prevent spamming the channel.

### Worker Concurrency
- Configured via `WORKER_CONCURRENCY` (default `1` to `5` parallel jobs per worker).
- **Atomic Database Claim**: Before sending, the worker performs an atomic conditional update:
  ```typescript
  const claimResult = await prisma.email.updateMany({
    where: { id: email.id, status: EmailStatus.SCHEDULED },
    data: { status: EmailStatus.PROCESSING, attemptCount: { increment: 1 } },
  });
  ```
- If another concurrent worker or thread claimed the job first, `claimResult.count` is `0`, and the worker immediately skips to prevent duplicate sends.

---

## 5. Features Implemented

### Backend Features
- **Queue Scheduler**: BullMQ Redis-backed queue engine; delayed jobs via sorted sets; bulk enqueueing via `addBulk()`; bulk DB insertion via `createMany()`.
- **Durable Persistence**: Full relational schema in PostgreSQL (Users, Senders, Campaigns, Emails, SlackConnections) via Prisma ORM.
- **Distributed Rate Limiting**: Atomic Redis Lua scripts for hourly sender quotas; intelligent rescheduling to next hour; inter-email delay reservation per sender.
- **Worker Concurrency & Idempotency**: Multi-worker concurrency; atomic DB state claims (`SCHEDULED` &rarr; `PROCESSING` &rarr; `SENT`/`FAILED`); unique idempotency keys; crash recovery for stale processing states.
- **Elasticsearch Search**: Full-text fuzzy search across recipients, subjects, and email bodies with graceful PostgreSQL fallback.
- **Lead Ingestion**: In-memory parsing for `.csv` and `.txt` lead files with regex extraction, deduplication, and Zod validation (up to 10MB).
- **Multi-Sender Management**: Tenant-scoped sender account registration; per-sender hourly limits and delay overrides; ownership verification.
- **Slack Integration**: Slack OAuth 2.0 flow; token storage; deduplicated rate-limit alerts.
- **Bull Board Monitor**: Express adapter mounted at `/admin/queues` for inspecting queue jobs and counts in real time.

### Frontend Features
- **Authentication**: Google OAuth 2.0 login and logout with HttpOnly cookie session management.
- **Dashboard Navigation**: Dark glassmorphic interface with tabs for Compose, Scheduled Emails, Sent Email Log, Search, Sender Accounts, Slack Integration, and Analytics.
- **Email Composer**: Campaign name, sender selection dropdown, recipient chip editor, CSV/TXT file upload, future datetime picker, delay pacing, and hourly limit settings.
- **Scheduled Emails Table**: Live listing of scheduled jobs with recipient, subject, scheduledAt timestamp, status badge, and BullMQ job ID.
- **Sent Emails Log**: Filterable log (`ALL` / `SENT` / `FAILED`, defaulting to `SENT`) with execution timestamps, error details, and record modal inspection.
- **Elasticsearch Search UI**: Keyword search across all email content with visual source indicator (`Source: elasticsearch` or `Source: postgresql_fallback`).
- **Sender Accounts Management**: Register new sender profiles and configure individual sending quotas.
- **Slack Workspace Panel**: Connect/disconnect Slack workspace with live connection status, team name, and channel name.
- **Analytics & Metrics**: 5-card metric summary (Total Emails, Scheduled, Sent, Failed, Delivery Success Rate) with clear explanation of the calculation basis.

---

## 6. Assumptions / Shortcuts / Trade-offs

1. **Production SMTP Outbound Policy (Railway)**:
   - *Limitation*: Railway container hosting blocks outbound raw TCP connections on SMTP ports (25, 465, 587) by default to prevent spam abuse.
   - *Actual Implementation*: The project uses standard Nodemailer with Ethereal SMTP. When running directly inside Railway containers, outbound SMTP handshakes time out. For live evaluation and real email delivery without mock data, the verified architecture runs the backend API, PostgreSQL, and Redis on Railway, while the BullMQ worker runs from an environment with unrestricted outbound SMTP access (e.g. locally via `railway run npx tsx src/workers/email.worker.ts` or `npm run worker`).
2. **Ethereal Sandbox vs. Production ESP**:
   - *Assumption*: Ethereal Email is utilized as a testbed SMTP relay. Emails are delivered to virtual Ethereal inboxes rather than real recipient mailboxes.
3. **Bull Board Worker Detection (`CLIENT LIST`)**:
   - *Technical Detail*: Bull Board's UI detects active workers using Redis `CLIENT LIST` and `CLIENT SETNAME`. In cloud Redis topologies (e.g. Railway proxies) or when sharing a pre-instantiated IORedis client, Bull Board may show `"No workers"` even while the worker is actively consuming jobs via BullMQ atomic Lua scripts (`BZPOPMIN`).
4. **Permanent Audit Trail**:
   - *Trade-off*: Failed email attempts are retained with their error message rather than deleted, ensuring truthful delivery metrics (`Success Rate = Sent / (Sent + Failed)`).
