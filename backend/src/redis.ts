import "./config.js";
import IORedis from "ioredis";

const redisUrl =
  process.env.REDIS_URL ||
  (process.env.REDIS_HOST
    ? `redis://${process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ""}${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
    : "redis://localhost:6379");

if (!redisUrl) {
  throw new Error("Redis connection configuration is not defined");
}

export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (error) => {
  console.error("Redis connection error:", error);
});