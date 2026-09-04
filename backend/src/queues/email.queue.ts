import { Queue } from "bullmq";
import { redis } from "../redis.js";

export const emailQueue = new Queue("email-scheduler", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});