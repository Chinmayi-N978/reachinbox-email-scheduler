import { reloadEnv } from "../config.js";
import { Router, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.middleware.js";

const router = Router();

function getGoogleOAuthConfig() {
  reloadEnv();
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = (
    process.env.GOOGLE_REDIRECT_URI ||
    process.env.GOOGLE_CALLBACK_URL ||
    "http://localhost:5000/api/auth/google/callback"
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
 * GET /api/auth/google
 * Initiates the Google OAuth 2.0 authorization code flow.
 */
router.get("/google", (_req, res) => {
  const { clientId, redirectUri } = getGoogleOAuthConfig();

  if (!clientId) {
    console.warn(
      "[OAuth Warning] GOOGLE_CLIENT_ID is not configured in environment variables."
    );
  }

  const scope = ["openid", "email", "profile"].join(" ");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return res.redirect(googleAuthUrl);
});

/**
 * GET /api/auth/google/callback
 * Handles the authorization code callback from Google OAuth 2.0.
 */
router.get("/google/callback", async (req, res) => {
  const { clientId, clientSecret, redirectUri, jwtSecret, frontendUrl } = getGoogleOAuthConfig();

  try {
    const { code, error } = req.query;

    if (error) {
      console.error("Google OAuth error callback:", error);
      return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(String(error))}`);
    }

    if (!code || typeof code !== "string") {
      return res.redirect(`${frontendUrl}/login?error=missing_code`);
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const tokenErr = await tokenResponse.text();
      console.error("Failed to exchange OAuth code for tokens:", tokenErr);
      return res.redirect(`${frontendUrl}/login?error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json();
    const accessToken = tokens.access_token;

    // Fetch user profile from Google UserInfo API
    const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) {
      console.error("Failed to fetch Google user profile:", await userResponse.text());
      return res.redirect(`${frontendUrl}/login?error=user_info_failed`);
    }

    const googleUser = await userResponse.json();
    const { id: googleId, email, name, picture } = googleUser;

    if (!googleId || !email) {
      return res.redirect(`${frontendUrl}/login?error=invalid_user_profile`);
    }

    // Upsert User in PostgreSQL database
    const user = await prisma.user.upsert({
      where: { googleId },
      update: {
        name: name || email.split("@")[0],
        email,
        avatarUrl: picture || null,
      },
      create: {
        googleId,
        email,
        name: name || email.split("@")[0],
        avatarUrl: picture || null,
      },
    });

    // Automatically create a default Sender for this user if they don't have one
    const existingSender = await prisma.sender.findFirst({
      where: { userId: user.id },
    });

    if (!existingSender) {
      await prisma.sender.create({
        data: {
          userId: user.id,
          email: user.email,
          name: user.name,
          delayBetweenEmailsMs: 2000,
          hourlyLimit: 200,
        },
      });
    }

    // Issue JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      jwtSecret,
      { expiresIn: "7d" }
    );

    // Set secure HttpOnly cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.redirect(`${frontendUrl}/dashboard`);
  } catch (err) {
    console.error("Google OAuth callback exception:", err);
    return res.redirect(`${frontendUrl}/login?error=auth_exception`);
  }
});

/**
 * GET /api/auth/me
 * Retrieves current authenticated user profile.
 */
router.get("/me", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  return res.json({
    success: true,
    user: req.user,
  });
});

/**
 * POST /api/auth/logout
 * Clears authentication session cookie.
 */
router.post("/logout", (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  return res.json({
    success: true,
    message: "Logged out successfully",
  });
});

export default router;
