import "./config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue } from "./queues/email.queue.js";
import emailRoutes from "./routes/email.routes.js";
import authRoutes from "./routes/auth.routes.js";
import senderRoutes from "./routes/sender.routes.js";
import slackRoutes from "./routes/slack.routes.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

app.use(helmet({
  contentSecurityPolicy: false, // Allows Bull Board UI inline resources
}));
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

// Routes
app.use("/admin/queues", serverAdapter.getRouter());
app.use("/api/auth", authRoutes);
app.use("/api/senders", senderRoutes);
app.use("/api/slack", slackRoutes);
app.use("/api/emails", emailRoutes);

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "ReachInbox backend is running",
  });
});

app.get("/api/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      success: true,
      message: "Database connection is working",
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

redis.ping().then((result) => {
  console.log(`Redis ping: ${result}`);
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);

  if (process.env.ENABLE_EMBEDDED_WORKER === "true") {
    import("./workers/email.worker.js")
      .then(() => {
        console.log("[Server] Embedded BullMQ email worker started.");
      })
      .catch((err) => {
        console.error("[Server] Failed to start embedded worker:", err);
      });
  }
});