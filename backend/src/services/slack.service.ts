import { prisma } from "../prisma.js";
import { redis } from "../redis.js";

/**
 * Sends a message to the user's connected Slack workspace/channel.
 * Never throws exceptions that could disrupt email processing.
 */
export async function sendSlackNotification(
  userId: string,
  text: string
): Promise<{ success: boolean; reason?: string }> {
  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
    });

    if (!connection || !connection.accessToken) {
      return { success: false, reason: "SLACK_NOT_CONNECTED" };
    }

    const channel = connection.channelId || "general";

    let response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${connection.accessToken}`,
      },
      body: JSON.stringify({
        channel,
        text,
      }),
    });

    let data = await response.json();

    // If bot is not in the channel, attempt conversations.join and retry
    if (!data.ok && data.error === "not_in_channel") {
      try {
        const joinRes = await fetch("https://slack.com/api/conversations.join", {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${connection.accessToken}`,
          },
          body: JSON.stringify({ channel }),
        });
        const joinData = await joinRes.json();
        if (joinData.ok) {
          response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${connection.accessToken}`,
            },
            body: JSON.stringify({
              channel,
              text,
            }),
          });
          data = await response.json();
        }
      } catch (joinErr) {
        console.warn("[Slack Service] Automatic conversations.join failed:", joinErr);
      }
    }

    if (!data.ok) {
      console.warn(
        `[Slack Service] Slack notification failed for user ${userId} in channel ${connection.channelName || channel} (${data.error}). ` +
          (data.error === "not_in_channel"
            ? `Please invite the Slack Bot to channel ${connection.channelName || channel} by typing '/invite @BotName' in the channel.`
            : "")
      );
      return { success: false, reason: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error(
      `[Slack Service] Error sending Slack notification for user ${userId}:`,
      error instanceof Error ? error.message : error
    );
    return { success: false, reason: "EXCEPTION" };
  }
}

/**
 * Sends a rate-limit alert to Slack with Redis-backed deduplication (1 alert per sender per hour).
 * Fails safely without throwing.
 */
export async function sendRateLimitSlackAlert(params: {
  userId: string;
  senderId: string;
  senderEmail: string;
  hourlyLimit: number;
  nextHourStartMs: number;
}): Promise<void> {
  try {
    const currentHourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const dedupKey = `ratelimit:slack_alert:${params.senderId}:${currentHourBucket}`;

    // Redis SET NX with 1 hour TTL (3600 seconds)
    const acquired = await redis.set(dedupKey, "1", "EX", 3600, "NX");

    if (!acquired) {
      // Deduplicated: Alert already sent for this sender during the current hour window
      return;
    }

    const nextHourDate = new Date(params.nextHourStartMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const alertMessage = `⚠️ *ReachInbox Rate-Limit Alert*\n` +
      `Sender: \`${params.senderEmail}\` reached its hourly quota of *${params.hourlyLimit} emails/hour*.\n` +
      `Subsequent scheduled jobs have been automatically rescheduled to resume in the next window at *${nextHourDate}*. No emails were dropped.`;

    const result = await sendSlackNotification(params.userId, alertMessage);
    if (!result.success) {
      // Release dedup key on failure so it can retry immediately once the bot is invited
      await redis.del(dedupKey).catch(() => {});
    }
  } catch (error) {
    console.error(
      `[Slack Service] Safe rate limit alert error for sender ${params.senderId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
