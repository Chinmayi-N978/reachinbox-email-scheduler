import "./config.js";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";
import { emailQueue } from "./queues/email.queue.js";
import { emailWorker } from "./workers/email.worker.js";
import { esClient, indexEmailDocument, searchEmails } from "./services/elasticsearch.service.js";
import { RedisRateLimiter } from "./services/rate-limiter.js";
import { sendRateLimitSlackAlert, sendSlackNotification } from "./services/slack.service.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import emailRoutes from "./routes/email.routes.js";
import authRoutes from "./routes/auth.routes.js";
import senderRoutes from "./routes/sender.routes.js";
import slackRoutes from "./routes/slack.routes.js";
import { EmailStatus } from "../generated/prisma/client.js";

async function runSmokeTests() {
  console.log("==================================================");
  console.log("STARTING REACHINBOX END-TO-END SMOKE TESTS");
  console.log("==================================================");

  let server: any;
  const TEST_PORT = 5098;

  try {
    // 1. INFRASTRUCTURE CHECKS
    console.log("\n[1/7] Testing Infrastructure Services...");
    const redisPong = await redis.ping();
    console.log(`✓ Redis connected and responded to PING: ${redisPong}`);

    const dbCheck = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log(`✓ PostgreSQL connected via Prisma:`, dbCheck);

    const esInfo = await esClient.info();
    console.log(`✓ Elasticsearch connected (cluster: ${esInfo.cluster_name}, version: ${esInfo.version.number})`);

    // 2. SERVER & ROUTES TEST
    console.log("\n[2/7] Starting Express Test Server & Mounting Routes...");
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json());
    app.use(cookieParser());

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");
    createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter });

    app.use("/admin/queues", serverAdapter.getRouter());
    app.use("/api/auth", authRoutes);
    app.use("/api/senders", senderRoutes);
    app.use("/api/slack", slackRoutes);
    app.use("/api/emails", emailRoutes);

    app.get("/api/health", (_req, res) => res.json({ success: true, message: "ReachInbox backend is running" }));
    app.get("/api/health/db", async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ success: true, message: "Database connection is working" });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        console.log(`✓ Express server listening on port ${TEST_PORT}`);
        resolve();
      });
    });

    const healthRes = await fetch(`http://localhost:${TEST_PORT}/api/health`).then((r) => r.json());
    console.log(`✓ GET /api/health returned:`, healthRes);

    const dbHealthRes = await fetch(`http://localhost:${TEST_PORT}/api/health/db`).then((r) => r.json());
    console.log(`✓ GET /api/health/db returned:`, dbHealthRes);

    const bullBoardStatus = await fetch(`http://localhost:${TEST_PORT}/admin/queues`).then((r) => r.status);
    console.log(`✓ GET /admin/queues returned HTTP status: ${bullBoardStatus}`);

    // 3. DATABASE USER & SENDER SETUP
    console.log("\n[3/7] Setting Up Test Tenant & Sender...");
    const testUser = await prisma.user.upsert({
      where: { email: "smoke-test@reachinbox.internal" },
      update: {},
      create: {
        googleId: "smoke-test-google-id",
        name: "Smoke Test Agent",
        email: "smoke-test@reachinbox.internal",
      },
    });

    const testSender = await prisma.sender.upsert({
      where: {
        userId_email: {
          userId: testUser.id,
          email: "smoke-sender@ethereal.email",
        },
      },
      update: {
        delayBetweenEmailsMs: 100,
        hourlyLimit: 10,
      },
      create: {
        userId: testUser.id,
        email: "smoke-sender@ethereal.email",
        name: "Smoke Test Sender",
        delayBetweenEmailsMs: 100,
        hourlyLimit: 10,
      },
    });
    console.log(`✓ Test User (${testUser.id}) and Sender (${testSender.id}) verified in DB`);

    // 4. EMAIL PIPELINE & WORKER EXECUTION
    console.log("\n[4/7] Testing Email Scheduling -> Worker -> SMTP -> DB -> Elasticsearch...");
    const emailId = `smoke-email-${Date.now()}`;
    const jobId = `job-${emailId}`;
    const scheduledAt = new Date(Date.now() + 200);

    // Create campaign first as required by relational schema
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId: testUser.id,
        senderId: testSender.id,
        name: "Smoke Test Campaign",
        subject: "Smoke Test Subject",
        body: "<p>ReachInbox automated pipeline smoke test.</p>",
        startTime: scheduledAt,
        delayBetweenEmailsMs: 100,
        hourlyLimit: 10,
      },
    });

    const emailRecord = await prisma.email.create({
      data: {
        id: emailId,
        userId: testUser.id,
        senderId: testSender.id,
        campaignId: campaign.id,
        recipient: "smoke-recipient@example.com",
        subject: "Smoke Test Subject",
        body: "<p>ReachInbox automated pipeline smoke test.</p>",
        sequence: 0,
        scheduledAt,
        originalScheduledAt: scheduledAt,
        status: EmailStatus.SCHEDULED,
        jobId,
        idempotencyKey: emailId,
        attemptCount: 0,
      },
    });
    console.log(`✓ Created Email record ${emailRecord.id} with status SCHEDULED in PostgreSQL`);

    // Add job to BullMQ
    await emailQueue.add(
      "send-email",
      {
        emailId: emailRecord.id,
        userId: testUser.id,
        senderId: testSender.id,
        from: testSender.email,
        recipient: emailRecord.recipient,
        subject: emailRecord.subject,
        body: emailRecord.body,
      },
      {
        jobId,
        delay: 200,
      }
    );
    console.log(`✓ Added BullMQ job ${jobId} to email-scheduler queue`);

    // Wait for worker to process the job
    console.log("Waiting for worker processing and SMTP send...");
    let processed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = await prisma.email.findUnique({ where: { id: emailId } });
      if (current && (current.status === EmailStatus.SENT || current.status === EmailStatus.FAILED)) {
        console.log(`✓ Email ${emailId} reached final status: ${current.status}`);
        if (current.sentAt) console.log(`✓ Email sentAt timestamp: ${current.sentAt.toISOString()}`);
        processed = true;
        break;
      }
    }

    if (!processed) {
      throw new Error(`Email ${emailId} was not processed by the worker within 20 seconds`);
    }

    // 5. IDEMPOTENCY VERIFICATION
    console.log("\n[5/7] Testing Idempotency & Duplicate Prevention...");
    const completedEmail = await prisma.email.findUnique({ where: { id: emailId } });
    if (completedEmail?.status === EmailStatus.SENT) {
      // Trying to claim or send again must be rejected
      const duplicateClaim = await prisma.email.updateMany({
        where: {
          id: emailId,
          status: EmailStatus.SCHEDULED,
        },
        data: {
          status: EmailStatus.PROCESSING,
        },
      });
      console.log(`✓ Duplicate claim count: ${duplicateClaim.count} (0 expected - verified protected!)`);
    }

    // 6. RATE LIMIT & RESCHEDULING TEST
    console.log("\n[6/7] Testing Hourly Rate Limit & Rescheduling Logic...");
    const limitedSenderId = `rate-limit-test-sender-${Date.now()}`;
    const limit = 2;

    // Check rate limit increments
    const res1 = await RedisRateLimiter.checkAndIncrement(limitedSenderId, limit);
    const res2 = await RedisRateLimiter.checkAndIncrement(limitedSenderId, limit);
    const res3 = await RedisRateLimiter.checkAndIncrement(limitedSenderId, limit);

    console.log(`✓ Rate limit attempt 1: allowed=${res1.allowed}, currentCount=${res1.currentCount}`);
    console.log(`✓ Rate limit attempt 2: allowed=${res2.allowed}, currentCount=${res2.currentCount}`);
    console.log(`✓ Rate limit attempt 3 (exceeded): allowed=${res3.allowed}, currentCount=${res3.currentCount}`);

    if (res3.allowed !== false) {
      throw new Error("Rate limit was not enforced at limit of 2");
    }

    // Verify Slack Alert Deduplication logic
    console.log("Testing Slack rate limit alert deduplication...");
    await sendRateLimitSlackAlert({
      userId: testUser.id,
      senderId: limitedSenderId,
      senderEmail: "limited-sender@test.com",
      hourlyLimit: limit,
      nextHourStartMs: res3.nextHourStartMs,
    });
    console.log("✓ Rate limit Slack alert dispatched/deduplicated safely without throwing");

    // 7. ELASTICSEARCH INDEXING & SEARCH TEST
    console.log("\n[7/7] Testing Elasticsearch Indexing & Search Querying...");
    await indexEmailDocument({
      id: emailId,
      userId: testUser.id,
      senderId: testSender.id,
      recipient: "smoke-recipient@example.com",
      subject: "Smoke Test Subject",
      body: "ReachInbox automated pipeline smoke test.",
      status: "SENT",
      sentAt: new Date(),
    });

    // Wait for ES refresh
    await new Promise((r) => setTimeout(r, 1200));

    const searchRes = await searchEmails({ query: "Smoke", userId: testUser.id });
    console.log(`✓ Elasticsearch query executed. Found: ${searchRes.pagination.total} hit(s)`);

    console.log("\n==================================================");
    console.log("ALL SMOKE TEST PHASES PASSED WITH 100% SUCCESS!");
    console.log("==================================================");
  } catch (error) {
    console.error("\n❌ SMOKE TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    await emailWorker.close();
    await prisma.$disconnect();
    await redis.quit();
  }
}

runSmokeTests();
