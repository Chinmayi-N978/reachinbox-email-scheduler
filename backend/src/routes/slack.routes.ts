import { reloadEnv } from "../config.js";
import { Router, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.middleware.js";

const router = Router();

function getSlackOAuthConfig() {
  reloadEnv();
  const clientId = (process.env.SLACK_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SLACK_CLIENT_SECRET || "").trim();
  const redirectUri = (
    process.env.SLACK_REDIRECT_URI || "http://localhost:5000/api/slack/callback"
  ).trim();
  const jwtSecret = (process.env.JWT_SECRET || "default-dev-jwt-secret-reachinbox-2026").trim();
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim();

  return {
    clientId,
    clientSecret,
    redirectUri,
    jwtSecret,
    frontendUrl,
  };
}

/**
 * GET /api/slack/connect
 * Initiates the Slack OAuth 2.0 flow with a signed state token encoding userId.
 */
router.get("/connect", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { clientId, redirectUri, jwtSecret } = getSlackOAuthConfig();

  if (!clientId) {
    console.warn("[Slack OAuth] SLACK_CLIENT_ID is not configured in environment variables.");
  }

  const userId = req.user!.id;
  const stateToken = jwt.sign({ userId, purpose: "slack_oauth" }, jwtSecret, {
    expiresIn: "15m",
  });

  const scope = ["chat:write", "channels:read", "groups:read", "incoming-webhook"].join(",");

  const params = new URLSearchParams({
    client_id: clientId,
    scope,
    redirect_uri: redirectUri,
    state: stateToken,
  });

  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  return res.redirect(slackAuthUrl);
});

/**
 * GET /api/slack/callback
 * Handles authorization code callback from Slack OAuth.
 */
router.get("/callback", async (req, res) => {
  const { clientId, clientSecret, redirectUri, jwtSecret, frontendUrl } = getSlackOAuthConfig();

  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error("Slack OAuth error callback:", error);
      return res.redirect(`${frontendUrl}/dashboard?slack_error=${encodeURIComponent(String(error))}`);
    }

    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
      return res.redirect(`${frontendUrl}/dashboard?slack_error=invalid_callback_params`);
    }

    // Verify state token to get authenticated userId
    let decodedState: { userId: string; purpose: string };
    try {
      decodedState = jwt.verify(state, jwtSecret) as { userId: string; purpose: string };
      if (decodedState.purpose !== "slack_oauth" || !decodedState.userId) {
        throw new Error("Invalid state payload");
      }
    } catch (stateErr) {
      console.error("Slack OAuth invalid state token:", stateErr);
      return res.redirect(`${frontendUrl}/dashboard?slack_error=invalid_state`);
    }

    const userId = decodedState.userId;

    // Exchange authorization code for Slack access tokens
    const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      console.error("Slack token exchange failed:", tokenData.error);
      return res.redirect(`${frontendUrl}/dashboard?slack_error=${encodeURIComponent(tokenData.error || "token_failed")}`);
    }

    const accessToken = tokenData.access_token || tokenData.authed_user?.access_token || "";
    const teamId = tokenData.team?.id || null;
    const teamName = tokenData.team?.name || null;
    const channelId = tokenData.incoming_webhook?.channel_id || null;
    const channelName = tokenData.incoming_webhook?.channel || null;

    if (!accessToken) {
      return res.redirect(`${frontendUrl}/dashboard?slack_error=no_access_token_returned`);
    }

    // Upsert SlackConnection in PostgreSQL
    await prisma.slackConnection.upsert({
      where: { userId },
      update: {
        accessToken,
        teamId,
        teamName,
        channelId,
        channelName,
      },
      create: {
        userId,
        accessToken,
        teamId,
        teamName,
        channelId,
        channelName,
      },
    });

    console.log(`[Slack OAuth] Successfully connected Slack for user ${userId} (Team: ${teamName})`);
    return res.redirect(`${frontendUrl}/dashboard?slack=connected`);
  } catch (err) {
    console.error("Slack OAuth callback exception:", err);
    return res.redirect(`${frontendUrl}/dashboard?slack_error=callback_exception`);
  }
});

/**
 * GET /api/slack/status
 * Retrieves current user's Slack connection status without exposing tokens.
 */
router.get("/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
      select: {
        id: true,
        teamId: true,
        teamName: true,
        channelId: true,
        channelName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({
      success: true,
      connected: !!connection,
      connection: connection || null,
    });
  } catch (error) {
    console.error("Fetch Slack status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Slack status",
    });
  }
});

/**
 * POST /api/slack/disconnect
 * Safely disconnects and clears the authenticated user's Slack integration.
 */
router.post("/disconnect", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    await prisma.slackConnection.deleteMany({
      where: { userId },
    });

    return res.json({
      success: true,
      message: "Slack connection disconnected successfully",
    });
  } catch (error) {
    console.error("Slack disconnect error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to disconnect Slack",
    });
  }
});

export default router;
