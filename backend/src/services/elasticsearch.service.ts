import { Client } from "@elastic/elasticsearch";

const esNode = (process.env.ELASTICSEARCH_NODE || "http://localhost:9200")
  .trim()
  .replace(/\/+$/, "");
const esApiKey = process.env.ELASTICSEARCH_API_KEY
  ? process.env.ELASTICSEARCH_API_KEY.trim()
  : undefined;

export const esClient = new Client({
  node: esNode,
  auth: esApiKey ? { apiKey: esApiKey } : undefined,
});

export const ELASTICSEARCH_INDEX = (
  process.env.ELASTICSEARCH_INDEX || "emails"
).trim();

let indexEnsured = false;

/**
 * Ensures the target Elasticsearch index exists with proper field mappings.
 * Idempotent: Does not recreate, alter, or delete an existing index.
 */
export async function ensureIndex(): Promise<void> {
  if (indexEnsured) return;

  try {
    const exists = await esClient.indices.exists({ index: ELASTICSEARCH_INDEX });
    if (!exists) {
      await esClient.indices.create({
        index: ELASTICSEARCH_INDEX,
        mappings: {
          properties: {
            id: { type: "keyword" },
            userId: { type: "keyword" },
            senderId: { type: "keyword" },
            campaignId: { type: "keyword" },
            recipient: {
              type: "text",
              fields: { keyword: { type: "keyword" } },
            },
            subject: { type: "text" },
            body: { type: "text" },
            status: { type: "keyword" },
            scheduledAt: { type: "date" },
            sentAt: { type: "date" },
            failureReason: { type: "text" },
            createdAt: { type: "date" },
            updatedAt: { type: "date" },
          },
        },
      });
      console.log(`[Elasticsearch] Created index "${ELASTICSEARCH_INDEX}".`);
    }
    indexEnsured = true;
  } catch (err: any) {
    if (
      err?.meta?.body?.error?.type === "resource_already_exists_exception" ||
      err?.message?.includes("resource_already_exists_exception")
    ) {
      indexEnsured = true;
      return;
    }
    throw err;
  }
}

export interface EmailDocument {
  id: string;
  userId: string;
  senderId: string;
  campaignId?: string | null;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt?: Date | string | null;
  sentAt?: Date | string | null;
  failureReason?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

/**
 * Indexes an email record into Elasticsearch using email.id as the document ID for idempotency.
 * Errors are caught and logged so that Elasticsearch downtime does not disrupt core processing or PostgreSQL state.
 */
export async function indexEmailDocument(email: EmailDocument): Promise<void> {
  try {
    await ensureIndex();
    await esClient.index({
      index: ELASTICSEARCH_INDEX,
      id: email.id,
      document: {
        id: email.id,
        userId: email.userId,
        senderId: email.senderId,
        campaignId: email.campaignId,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt
          ? new Date(email.scheduledAt).toISOString()
          : null,
        sentAt: email.sentAt ? new Date(email.sentAt).toISOString() : null,
        failureReason: email.failureReason || null,
        createdAt: email.createdAt
          ? new Date(email.createdAt).toISOString()
          : null,
        updatedAt: email.updatedAt
          ? new Date(email.updatedAt).toISOString()
          : null,
      },
    });
  } catch (error) {
    console.error(
      `[Elasticsearch] Safe indexing error for email ${email.id}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Search emails in Elasticsearch across recipient, subject, and body fields.
 */
export async function searchEmails(params: {
  query: string;
  userId?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  await ensureIndex();

  const page = params.page && params.page > 0 ? params.page : 1;
  const limit = params.limit && params.limit > 0 ? params.limit : 20;
  const from = (page - 1) * limit;

  const mustConditions: any[] = [];

  if (params.query) {
    mustConditions.push({
      multi_match: {
        query: params.query,
        fields: ["recipient^3", "subject^2", "body"],
        fuzziness: "AUTO",
      },
    });
  }

  if (params.userId) {
    mustConditions.push({ term: { userId: params.userId } });
  }

  if (params.status) {
    mustConditions.push({ term: { status: params.status } });
  }

  const searchQuery =
    mustConditions.length > 0
      ? { bool: { must: mustConditions } }
      : { match_all: {} };

  const response = await esClient.search({
    index: ELASTICSEARCH_INDEX,
    from,
    size: limit,
    query: searchQuery,
  });

  const hits = response.hits.hits.map((hit: any) => hit._source);
  const totalHits =
    typeof response.hits.total === "number"
      ? response.hits.total
      : response.hits.total?.value || 0;

  return {
    success: true,
    data: hits,
    pagination: {
      total: totalHits,
      page,
      limit,
      totalPages: Math.ceil(totalHits / limit),
    },
  };
}
