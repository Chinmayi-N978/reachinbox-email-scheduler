import { redis } from "../redis.js";

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  nextHourStartMs: number;
}

/**
 * Distributed atomic hourly rate limiter using Redis.
 * Safe across multiple worker processes/threads.
 * Fail-closed: Redis failure will throw an error to prevent rate limit bypass.
 */
export class RedisRateLimiter {
  /**
   * Check and atomically increment rate limit for a sender in the current hour window.
   * If limit is reached, returns allowed: false and the timestamp of the start of next hour.
   * If Redis fails, throws an error (fail-closed) so callers handle it safely without bypassing limit.
   */
  static async checkAndIncrement(
    senderId: string,
    hourlyLimit: number
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const currentHourIndex = Math.floor(now / 3600000);
    const nextHourStartMs = (currentHourIndex + 1) * 3600000;

    // Key formatted per sender per hour block
    const key = `ratelimit:sender:${senderId}:${currentHourIndex}`;

    // Redis Lua script for atomic check-and-increment
    const luaScript = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local ttl = tonumber(ARGV[2])

      local current = redis.call('GET', key)
      if current and tonumber(current) >= limit then
          return {0, tonumber(current)}
      else
          local val = redis.call('INCR', key)
          if val == 1 then
              redis.call('EXPIRE', key, ttl)
          end
          if val > limit then
              redis.call('DECR', key)
              return {0, val - 1}
          end
          return {1, val}
      end
    `;

    // Key TTL: remaining time in current hour + 300s buffer
    const ttlSeconds = Math.ceil((nextHourStartMs - now) / 1000) + 300;

    try {
      const result = (await redis.eval(
        luaScript,
        1,
        key,
        hourlyLimit.toString(),
        ttlSeconds.toString()
      )) as [number, number];

      const allowed = result[0] === 1;
      const currentCount = Number(result[1]);

      return {
        allowed,
        currentCount,
        nextHourStartMs,
      };
    } catch (error) {
      console.error("Redis rate limiter infrastructure error:", error);
      // Fail-closed: Throw error to prevent silent bypass of rate limits
      throw new Error(
        `Redis rate limiter unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Get current usage count for a sender in the current hour
   */
  static async getCurrentHourCount(senderId: string): Promise<number> {
    const currentHourIndex = Math.floor(Date.now() / 3600000);
    const key = `ratelimit:sender:${senderId}:${currentHourIndex}`;
    const val = await redis.get(key);
    return val ? parseInt(val, 10) : 0;
  }
}
