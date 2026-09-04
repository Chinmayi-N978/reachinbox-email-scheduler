import { Router, Response } from "express";
import { z } from "zod";
import multer from "multer";
import { prisma } from "../prisma.js";
import { emailQueue } from "../queues/email.queue.js";
import { EmailStatus } from "../../generated/prisma/client.js";
import { searchEmails } from "../services/elasticsearch.service.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.middleware.js";

const router = Router();

// Configure memory-backed multer for CSV and TXT lead files (max 10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.toLowerCase().endsWith(".csv");
    const isTxt =
      file.mimetype === "text/plain" ||
      file.originalname.toLowerCase().endsWith(".txt");

    if (isCsv || isTxt) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv and .txt lead files are supported"));
    }
  },
});

// Apply requireAuth middleware to ALL email routes
router.use(requireAuth);

/**
 * POST /api/emails/upload-leads
 * Safely parses uploaded CSV or TXT lead files into a deduplicated array of validated email addresses.
 */
router.post(
  "/upload-leads",
  upload.single("file"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          message: "No lead file uploaded. Please provide a .csv or .txt file.",
        });
      }

      const fileContent = req.file.buffer.toString("utf-8");
      if (!fileContent.trim()) {
        return res.status(400).json({
          success: false,
          message: "Uploaded file is empty.",
        });
      }

      // Regex matching standard email addresses
      const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
      const matches = fileContent.match(emailRegex) || [];

      // Deduplicate and lowercase
      const uniqueEmails = Array.from(
        new Set(matches.map((e) => e.trim().toLowerCase()))
      );

      // Validate each email with zod schema
      const emailSchema = z.string().email();
      const validEmails = uniqueEmails.filter((email) => {
        const result = emailSchema.safeParse(email);
        return result.success;
      });

      if (validEmails.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No valid email addresses found in the uploaded file.",
        });
      }

      return res.json({
        success: true,
        message: `Successfully extracted ${validEmails.length} unique recipient(s)`,
        count: validEmails.length,
        emails: validEmails,
      });
    } catch (error: any) {
      console.error("Upload leads error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to process lead file",
      });
    }
  }
);

const scheduleEmailSchema = z.object({
  senderId: z.string().min(1, "senderId is required"),

  recipients: z
    .array(z.string().email("Invalid email address"))
    .min(1, "At least one recipient is required"),

  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),

  startTime: z.string().datetime("startTime must be a valid ISO datetime"),

  delayBetweenEmailsMs: z.number().int().min(0).default(2000),
  hourlyLimit: z.number().int().positive().default(200),

  name: z.string().optional(),
});

const queryParamsSchema = z.object({
  senderId: z.string().optional(),
  campaignId: z.string().optional(),
  status: z.nativeEnum(EmailStatus).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * POST /api/emails/schedule
 * Schedules an email campaign for 1 to 1000+ recipients with bulk DB insertion and bulk BullMQ queueing.
 * Uses authenticated user's ID derived strictly from JWT session token.
 */
router.post("/schedule", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = scheduleEmailSchema.parse(req.body);
    const userId = req.user!.id;
    const startTime = new Date(data.startTime);

    if (startTime.getTime() <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Start time must be in the future",
      });
    }

    // Verify sender ownership for the authenticated user
    const sender = await prisma.sender.findFirst({
      where: {
        id: data.senderId,
        userId,
      },
    });

    if (!sender) {
      return res.status(404).json({
        success: false,
        message: "Sender not found for this user",
      });
    }

    // Create the EmailCampaign
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId,
        senderId: data.senderId,
        name: data.name,
        subject: data.subject,
        body: data.body,
        startTime,
        delayBetweenEmailsMs: data.delayBetweenEmailsMs,
        hourlyLimit: data.hourlyLimit,
      },
    });

    // Prepare bulk email records
    const emailsData = data.recipients.map((recipient, index) => {
      const scheduledAt = new Date(
        startTime.getTime() + index * data.delayBetweenEmailsMs
      );
      const jobId = `email-${campaign.id}-${index}`;
      const idempotencyKey = `email-${campaign.id}-${index}`;

      return {
        id: `email-${campaign.id}-${index}`,
        userId,
        senderId: data.senderId,
        campaignId: campaign.id,
        recipient,
        subject: data.subject,
        body: data.body,
        sequence: index,
        scheduledAt,
        originalScheduledAt: scheduledAt,
        status: EmailStatus.SCHEDULED,
        jobId,
        idempotencyKey,
        attemptCount: 0,
      };
    });

    // Batch insertion into PostgreSQL via createMany
    await prisma.email.createMany({
      data: emailsData,
    });

    // Prepare bulk jobs for BullMQ queueing
    const bullMqJobs = emailsData.map((email) => {
      const delay = Math.max(0, email.scheduledAt.getTime() - Date.now());

      return {
        name: "send-email",
        data: {
          emailId: email.id,
          campaignId: campaign.id,
          userId,
          senderId: data.senderId,
          from: sender.email,
          recipient: email.recipient,
          subject: email.subject,
          body: email.body,
          sequence: email.sequence,
          scheduledAt: email.scheduledAt.toISOString(),
        },
        opts: {
          jobId: email.jobId,
          delay,
        },
      };
    });

    // Batch enqueue into Redis via BullMQ addBulk
    await emailQueue.addBulk(bullMqJobs);

    return res.status(201).json({
      success: true,
      message: "Email campaign scheduled successfully",
      campaign: {
        id: campaign.id,
        name: campaign.name,
        startTime: campaign.startTime,
        totalEmails: emailsData.length,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid request data",
        errors: error.issues,
      });
    }

    console.error("Schedule email error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to schedule email campaign",
    });
  }
});

/**
 * GET /api/emails/scheduled
 * Retrieve paginated scheduled emails for the authenticated user.
 */
router.get("/scheduled", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = queryParamsSchema.parse(req.query);
    const userId = req.user!.id;
    const { senderId, campaignId, search, page, limit } = query;

    const where: any = {
      userId,
      status: EmailStatus.SCHEDULED,
    };

    if (senderId) where.senderId = senderId;
    if (campaignId) where.campaignId = campaignId;
    if (search) {
      where.OR = [
        { recipient: { contains: search, mode: "insensitive" } },
        { subject: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [total, emails] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        skip,
        take: limit,
        orderBy: { scheduledAt: "asc" },
        include: {
          sender: true,
          campaign: true,
        },
      }),
    ]);

    return res.json({
      success: true,
      data: emails,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid query parameters",
        errors: error.issues,
      });
    }

    console.error("Fetch scheduled emails error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch scheduled emails",
    });
  }
});

/**
 * GET /api/emails/sent
 * Retrieve paginated sent emails for the authenticated user.
 */
router.get("/sent", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = queryParamsSchema.parse(req.query);
    const userId = req.user!.id;
    const { senderId, campaignId, search, page, limit } = query;

    const where: any = {
      userId,
      status: EmailStatus.SENT,
    };

    if (senderId) where.senderId = senderId;
    if (campaignId) where.campaignId = campaignId;
    if (search) {
      where.OR = [
        { recipient: { contains: search, mode: "insensitive" } },
        { subject: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [total, emails] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        skip,
        take: limit,
        orderBy: { sentAt: "desc" },
        include: {
          sender: true,
          campaign: true,
        },
      }),
    ]);

    return res.json({
      success: true,
      data: emails,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid query parameters",
        errors: error.issues,
      });
    }

    console.error("Fetch sent emails error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch sent emails",
    });
  }
});

/**
 * GET /api/emails/metrics
 * Retrieve aggregated email metrics for the authenticated user.
 */
router.get("/metrics", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { senderId, campaignId } = req.query;

    const where: any = { userId };
    if (senderId && typeof senderId === "string") where.senderId = senderId;
    if (campaignId && typeof campaignId === "string") where.campaignId = campaignId;

    const [total, scheduled, processing, sent, failed] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.count({ where: { ...where, status: EmailStatus.SCHEDULED } }),
      prisma.email.count({ where: { ...where, status: EmailStatus.PROCESSING } }),
      prisma.email.count({ where: { ...where, status: EmailStatus.SENT } }),
      prisma.email.count({ where: { ...where, status: EmailStatus.FAILED } }),
    ]);

    const processedTotal = sent + failed;
    const successRate =
      processedTotal > 0
        ? Math.round((sent / processedTotal) * 100 * 100) / 100
        : 0;

    return res.json({
      success: true,
      metrics: {
        total,
        scheduled,
        processing,
        sent,
        failed,
        successRate,
      },
    });
  } catch (error) {
    console.error("Fetch metrics error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch email metrics",
    });
  }
});

/**
 * GET /api/emails/list
 * Flexible paginated listing endpoint for authenticated user's emails.
 */
router.get("/list", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = queryParamsSchema.parse(req.query);
    const userId = req.user!.id;
    const { senderId, campaignId, status, search, page, limit } = query;

    const where: any = { userId };
    if (senderId) where.senderId = senderId;
    if (campaignId) where.campaignId = campaignId;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { recipient: { contains: search, mode: "insensitive" } },
        { subject: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [total, emails] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          sender: true,
          campaign: true,
        },
      }),
    ]);

    return res.json({
      success: true,
      data: emails,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid query parameters",
        errors: error.issues,
      });
    }

    console.error("Fetch email list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch email list",
    });
  }
});

/**
 * GET /api/emails/search
 * Search emails belonging to authenticated user using Elasticsearch with PostgreSQL fallback.
 */
router.get("/search", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const q = (req.query.q || req.query.query || "") as string;
    const status = req.query.status as string | undefined;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;

    try {
      const searchResult = await searchEmails({
        query: q,
        userId,
        status,
        page,
        limit,
      });

      return res.json({
        ...searchResult,
        source: "elasticsearch",
      });
    } catch (esError) {
      console.warn(
        "[Search Route] Elasticsearch unavailable/failed, falling back to PostgreSQL:",
        esError instanceof Error ? esError.message : esError
      );

      const where: any = { userId };
      if (status && Object.values(EmailStatus).includes(status as any)) {
        where.status = status as EmailStatus;
      }
      if (q) {
        where.OR = [
          { recipient: { contains: q, mode: "insensitive" } },
          { subject: { contains: q, mode: "insensitive" } },
          { body: { contains: q, mode: "insensitive" } },
        ];
      }

      const skip = (page - 1) * limit;
      const [total, emails] = await Promise.all([
        prisma.email.count({ where }),
        prisma.email.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            sender: true,
            campaign: true,
          },
        }),
      ]);

      return res.json({
        success: true,
        source: "postgresql_fallback",
        data: emails,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    }
  } catch (error) {
    console.error("Search emails route error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search emails",
    });
  }
});

/**
 * GET /api/emails/:id
 * Retrieve details for a single email record belonging to the authenticated user.
 */
router.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;

    const email = await prisma.email.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        sender: true,
        campaign: true,
      },
    });

    if (!email) {
      return res.status(404).json({
        success: false,
        message: "Email record not found",
      });
    }

    return res.json({
      success: true,
      data: email,
    });
  } catch (error) {
    console.error("Fetch single email error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch email details",
    });
  }
});

export default router;