import "../config.js";
import { prisma } from "../prisma.js";
import { Email } from "../../generated/prisma/client.js";
import {
  esClient,
  ELASTICSEARCH_INDEX,
  ensureIndex,
} from "../services/elasticsearch.service.js";

/**
 * Idempotent one-time backfill utility to index all existing PostgreSQL Email records
 * into the Elasticsearch index.
 */
export async function runBackfill(): Promise<void> {
  console.log("[Backfill] Starting Elasticsearch backfill process...");

  // 1. Ensure target index exists with proper schema
  try {
    await ensureIndex();
    console.log(`[Backfill] Verified index "${ELASTICSEARCH_INDEX}" is ready.`);
  } catch (error: any) {
    console.error(
      "[Backfill] Failed to connect to or ensure Elasticsearch index:",
      error instanceof Error ? error.message : error
    );
    throw error;
  }

  // 2. Count total emails in PostgreSQL
  const totalEmails = await prisma.email.count();
  console.log(`[Backfill] Found ${totalEmails} total email record(s) in PostgreSQL.`);

  if (totalEmails === 0) {
    console.log("[Backfill] No emails to index. Completed.");
    return;
  }

  const BATCH_SIZE = 100;
  let processedCount = 0;
  let indexedCount = 0;
  let cursorId: string | undefined = undefined;

  while (processedCount < totalEmails) {
    const emails: Email[] = await prisma.email.findMany({
      take: BATCH_SIZE,
      skip: cursorId ? 1 : 0,
      cursor: cursorId ? { id: cursorId } : undefined,
      orderBy: { id: "asc" },
    });

    if (emails.length === 0) break;

    cursorId = emails[emails.length - 1].id;

    // Build bulk operations matching exact Elasticsearch document schema
    const operations = emails.flatMap((email) => [
      { index: { _index: ELASTICSEARCH_INDEX, _id: email.id } },
      {
        id: email.id,
        userId: email.userId,
        senderId: email.senderId,
        campaignId: email.campaignId,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt ? email.scheduledAt.toISOString() : null,
        sentAt: email.sentAt ? email.sentAt.toISOString() : null,
        failureReason: email.failureReason || null,
        createdAt: email.createdAt ? email.createdAt.toISOString() : null,
        updatedAt: email.updatedAt ? email.updatedAt.toISOString() : null,
      },
    ]);

    const bulkResponse = await esClient.bulk({
      refresh: false,
      operations,
    });

    if (bulkResponse.errors) {
      const errorItems = bulkResponse.items.filter((item: any) => item.index?.error);
      console.warn(`[Backfill] Notice: ${errorItems.length} item(s) had errors in this batch.`);
      indexedCount += emails.length - errorItems.length;
    } else {
      indexedCount += emails.length;
    }

    processedCount += emails.length;
    console.log(
      `[Backfill] Progress: ${processedCount}/${totalEmails} processed (${indexedCount} indexed).`
    );
  }

  // Refresh index so all newly indexed documents are immediately searchable
  await esClient.indices.refresh({ index: ELASTICSEARCH_INDEX }).catch(() => {});

  console.log(
    `[Backfill] Complete! Successfully indexed ${indexedCount}/${totalEmails} email(s) into "${ELASTICSEARCH_INDEX}".`
  );
}

// Self-executing runner when executed from CLI
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-elasticsearch.ts") ||
    process.argv[1].endsWith("backfill-elasticsearch.js"));

if (isDirectExecution) {
  runBackfill()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(
        "[Backfill] Execution failed:",
        err instanceof Error ? err.message : err
      );
      await prisma.$disconnect();
      process.exit(1);
    });
}
