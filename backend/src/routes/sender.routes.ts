import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.middleware.js";

const router = Router();

const createSenderSchema = z.object({
  email: z.string().email("Invalid sender email address"),
  name: z.string().min(1, "Sender name is required"),
  delayBetweenEmailsMs: z.number().int().min(0).default(2000),
  hourlyLimit: z.number().int().positive().default(200),
});

/**
 * GET /api/senders
 * Returns all senders belonging to the authenticated user.
 */
router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const senders = await prisma.sender.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: senders,
    });
  } catch (error) {
    console.error("Fetch senders error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch senders",
    });
  }
});

/**
 * POST /api/senders
 * Creates or updates a sender record for the authenticated user.
 */
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createSenderSchema.parse(req.body);
    const userId = req.user!.id;

    const sender = await prisma.sender.upsert({
      where: {
        userId_email: {
          userId,
          email: data.email,
        },
      },
      update: {
        name: data.name,
        delayBetweenEmailsMs: data.delayBetweenEmailsMs,
        hourlyLimit: data.hourlyLimit,
      },
      create: {
        userId,
        email: data.email,
        name: data.name,
        delayBetweenEmailsMs: data.delayBetweenEmailsMs,
        hourlyLimit: data.hourlyLimit,
      },
    });

    return res.status(201).json({
      success: true,
      data: sender,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid sender request data",
        errors: error.issues,
      });
    }

    console.error("Create sender error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create or update sender",
    });
  }
});

/**
 * GET /api/senders/:id
 * Retrieves details for a specific sender belonging to the authenticated user.
 */
router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;

    const sender = await prisma.sender.findFirst({
      where: {
        id,
        userId,
      },
    });

    if (!sender) {
      return res.status(404).json({
        success: false,
        message: "Sender not found",
      });
    }

    return res.json({
      success: true,
      data: sender,
    });
  } catch (error) {
    console.error("Fetch single sender error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch sender",
    });
  }
});

export default router;
