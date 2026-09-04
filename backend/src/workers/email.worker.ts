import "../config.js";
import { Worker, Job } from "bullmq";
import { redis } from "../redis.js";
import { prisma } from "../prisma.js";
import { emailQueue } from "../queues/email.queue.js";
import { sendEmail } from "../services/email.service.js";
import { RedisRateLimiter } from "../services/rate-limiter.js";
import { EmailStatus } from "../../generated/prisma/client.js";
import { indexEmailDocument } from "../services/elasticsearch.service.js";
import { sendRateLimitSlackAlert } from "../services/slack.service.js";

/**
 * Helper to check and reserve minimum delay between email sends for the same sender across worker instances.
 */
async function checkAndReserveSenderDelay(
  senderId: string,
  delayBetweenEmailsMs: number
): Promise<{ allowed: boolean; nextAllowedMs: number }> {
  if (delayBetweenEmailsMs <= 0) {
    return { allowed: true, nextAllowedMs: Date.now() };
  }

  const now = Date.now();
  const key = `ratelimit:sender_delay:${senderId}`;
  const ttlSeconds = Math.max(3600, Math.ceil(delayBetweenEmailsMs / 1000) * 2);

  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local delay = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])

    local nextAllowed = tonumber(redis.call('GET', key) or '0')

    if now < nextAllowed then
        return {0, nextAllowed}
    else
        redis.call('SET', key, now + delay, 'EX', ttl)
        return {1, now + delay}
    end
  `;

  const result = (await redis.eval(
    luaScript,
    1,
    key,
    now.toString(),
    delayBetweenEmailsMs.toString(),
    ttlSeconds.toString()
  )) as [number, number];

  return {
    allowed: result[0] === 1,
    nextAllowedMs: Number(result[1]),
  };
}

export const emailWorker = new Worker(
  "email-scheduler",
  async (job: Job) => {
    console.log(`Processing job ${job.id} for emailId: ${job.data?.emailId}`);

    const emailId = job.data?.emailId;
    if (!emailId) {
      console.warn(`Job ${job.id} missing emailId in payload.`);
      return;
    }

    // 1. Load the Email record from PostgreSQL using job.data.emailId
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        sender: true,
        campaign: true,
      },
    });

    if (!email) {
      console.warn(`Email record not found in PostgreSQL for id: ${emailId}`);
      return;
    }

    // 2. Idempotency check:
    if (email.status === EmailStatus.SENT) {
      console.log(`Email ${email.id} is already SENT. Skipping.`);
      return { status: "ALREADY_SENT" };
    }

    if (email.status === EmailStatus.FAILED) {
      console.log(`Email ${email.id} is already FAILED. Skipping.`);
      return { status: "ALREADY_FAILED" };
    }

    // 3. Atomic processing claim with crash recovery (stale PROCESSING > 5 minutes reclaimed):
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const claimResult = await prisma.email.updateMany({
      where: {
        id: email.id,
        OR: [
          { status: EmailStatus.SCHEDULED },
          { status: EmailStatus.PROCESSING, updatedAt: { lt: fiveMinutesAgo } },
        ],
      },
      data: {
        status: EmailStatus.PROCESSING,
        attemptCount: { increment: 1 },
      },
    });

    if (claimResult.count === 0) {
      console.log(
        `Email ${email.id} could not be claimed atomically (active worker working on it or status changed). Skipping.`
      );
      return { status: "CLAIM_FAILED" };
    }

    // 5. Minimum delay check:
    const delayBetweenEmailsMs =
      email.campaign?.delayBetweenEmailsMs ??
      email.sender?.delayBetweenEmailsMs ??
      (Number(process.env.DEFAULT_DELAY_MS) || 2000);

    let delayResult;
    try {
      delayResult = await checkAndReserveSenderDelay(
        email.senderId,
        delayBetweenEmailsMs
      );
    } catch (error) {
      console.error(
        `Redis error checking minimum delay for email ${email.id}:`,
        error
      );
      // Revert processing status on Redis infrastructure error so it can retry later
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SCHEDULED,
          attemptCount: { decrement: 1 },
        },
      });
      throw error;
    }

    if (!delayResult.allowed) {
      const delayMs = Math.max(100, delayResult.nextAllowedMs - Date.now());
      const rescheduledAt = new Date(Date.now() + delayMs);
      const newJobId = `email-${email.id}-delay-${Date.now()}`;

      console.log(
        `Email ${email.id} minimum delay not met. Rescheduling in ${delayMs}ms (at ${rescheduledAt.toISOString()}).`
      );

      // Revert to SCHEDULED status with new scheduledAt and jobId
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SCHEDULED,
          attemptCount: { decrement: 1 },
          scheduledAt: rescheduledAt,
          jobId: newJobId,
        },
      });

      await emailQueue.add(
        job.name,
        {
          ...job.data,
          scheduledAt: rescheduledAt.toISOString(),
        },
        {
          delay: delayMs,
          jobId: newJobId,
        }
      );

      return { status: "RESCHEDULED_MIN_DELAY", rescheduledAt };
    }

    // 6. Hourly rate limit check:
    const hourlyLimit =
      email.campaign?.hourlyLimit ??
      email.sender?.hourlyLimit ??
      (Number(process.env.DEFAULT_HOURLY_LIMIT) || 200);

    let rateLimitResult;
    try {
      rateLimitResult = await RedisRateLimiter.checkAndIncrement(
        email.senderId,
        hourlyLimit
      );
    } catch (error) {
      console.error(
        `Redis error checking rate limit for email ${email.id}:`,
        error
      );
      // Revert processing status on Redis infrastructure error so it can retry later
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SCHEDULED,
          attemptCount: { decrement: 1 },
        },
      });
      throw error;
    }

    if (!rateLimitResult.allowed) {
      const rescheduledAt = new Date(rateLimitResult.nextHourStartMs);
      const delayMs = Math.max(1000, rescheduledAt.getTime() - Date.now());
      const newJobId = `email-${email.id}-ratelimit-${Date.now()}`;

      console.log(
        `Email ${email.id} hit rate limit for sender ${email.senderId}. Rescheduling in ${delayMs}ms (at ${rescheduledAt.toISOString()}).`
      );

      // Revert status to SCHEDULED and update scheduledAt/jobId
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SCHEDULED,
          attemptCount: { decrement: 1 },
          scheduledAt: rescheduledAt,
          jobId: newJobId,
        },
      });

      // 7. BullMQ rescheduling via delayed-job mechanism
      await emailQueue.add(
        job.name,
        {
          ...job.data,
          scheduledAt: rescheduledAt.toISOString(),
        },
        {
          delay: delayMs,
          jobId: newJobId,
        }
      );

      // Trigger deduplicated Slack alert for this sender's rate limit window
      sendRateLimitSlackAlert({
        userId: email.userId,
        senderId: email.senderId,
        senderEmail: email.sender.email,
        hourlyLimit,
        nextHourStartMs: rateLimitResult.nextHourStartMs,
      }).catch((slackErr) => {
        console.warn(`[Worker] Slack alert warning for email ${email.id}:`, slackErr);
      });

      return { status: "RESCHEDULED_RATE_LIMIT", rescheduledAt };
    }

    // 8. Email sending via existing sendEmail() service
    try {
      const result = await sendEmail({
        from: job.data.from || email.sender.email,
        to: job.data.recipient || email.recipient,
        subject: job.data.subject || email.subject,
        html: job.data.body || email.body,
      });

      // 9. On successful send:
      const updatedEmail = await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SENT,
          sentAt: new Date(),
          failureReason: null,
        },
      });

      // Safe background indexing in Elasticsearch (will not fail worker if ES is down)
      indexEmailDocument(updatedEmail).catch((esErr) => {
        console.error(`[Worker] ES indexing error for email ${email.id}:`, esErr);
      });

      console.log(
        `Email ${email.id} sent successfully. MessageId: ${result.messageId}`
      );
      return result;
    } catch (sendError: any) {
      // 10. On failure:
      const errorMessage =
        sendError instanceof Error ? sendError.message : String(sendError);
      console.error(
        `Failed to send email ${email.id} to ${email.recipient}:`,
        errorMessage
      );

      const updatedEmail = await prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.FAILED,
          failureReason: errorMessage,
        },
      });

      // Safe background indexing in Elasticsearch (will not fail worker if ES is down)
      indexEmailDocument(updatedEmail).catch((esErr) => {
        console.error(`[Worker] ES indexing error for email ${email.id}:`, esErr);
      });

      throw sendError;
    }
  },
  {
    connection: redis,
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 1,
  }
);

emailWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

emailWorker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed:`, error);
});