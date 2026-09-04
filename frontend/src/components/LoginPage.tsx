import React from "react";
import { API_BASE_URL } from "../services/api";
import { Mail, Zap, Database, Search, ShieldCheck } from "lucide-react";

export const LoginPage: React.FC = () => {
  const urlParams = new URLSearchParams(window.location.search);
  const authError = urlParams.get("error");

  const handleGoogleLogin = () => {
    window.location.href = `${API_BASE_URL}/api/auth/google`;
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div style={{ width: "100%", maxWidth: "1050px", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "2.5rem" }}>
        
        {/* Left Side: Brand Showcase */}
        <div className="glass-card" style={{ padding: "3rem", display: "flex", flexDirection: "column", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: "-50px", left: "-50px", width: "200px", height: "200px", background: "rgba(99, 102, 241, 0.2)", borderRadius: "50%", filter: "blur(60px)", pointerEvents: "none" }} />

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "2.5rem" }}>
              <div style={{ background: "linear-gradient(135deg, #6366f1, #06b6d4)", width: "42px", height: "42px", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 20px rgba(99,102,241,0.5)" }}>
                <Mail size={24} color="#ffffff" />
              </div>
              <span style={{ fontSize: "1.5rem", fontWeight: "800", letterSpacing: "-0.02em", background: "linear-gradient(to right, #ffffff, #9ca3af)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                ReachInbox
              </span>
            </div>

            <h1 style={{ fontSize: "2.5rem", fontWeight: "800", lineHeight: "1.15", marginBottom: "1.25rem" }}>
              Enterprise Cold Email <br />
              <span style={{ background: "linear-gradient(90deg, #818cf8, #38bdf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Scheduler & Engine
              </span>
            </h1>

            <p style={{ color: "#9ca3af", fontSize: "1.05rem", marginBottom: "2.5rem", maxWidth: "440px" }}>
              Schedule 1,000+ outreach emails with microsecond sender rate limits, BullMQ distributed queues, and Elasticsearch index search.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "1rem" }}>
              <Zap size={20} color="#818cf8" style={{ marginBottom: "0.5rem" }} />
              <div style={{ fontSize: "0.9rem", fontWeight: "600" }}>Distributed Workers</div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>BullMQ & Redis throttling</div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "1rem" }}>
              <Database size={20} color="#34d399" style={{ marginBottom: "0.5rem" }} />
              <div style={{ fontSize: "0.9rem", fontWeight: "600" }}>Prisma & Postgres</div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>ACID transactional state</div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "1rem" }}>
              <Search size={20} color="#38bdf8" style={{ marginBottom: "0.5rem" }} />
              <div style={{ fontSize: "0.9rem", fontWeight: "600" }}>Elasticsearch</div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Full-text document index</div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "1rem" }}>
              <ShieldCheck size={20} color="#fbbf24" style={{ marginBottom: "0.5rem" }} />
              <div style={{ fontSize: "0.9rem", fontWeight: "600" }}>Google OAuth 2.0</div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Secure HttpOnly session</div>
            </div>
          </div>
        </div>

        {/* Right Side: Login Card matching Figma specifications */}
        <div className="glass-card" style={{ padding: "3rem", display: "flex", flexDirection: "column", justifyContent: "center", textAlign: "center" }}>
          <div style={{ marginBottom: "2rem" }}>
            <h2 style={{ fontSize: "1.75rem", fontWeight: "700", marginBottom: "0.5rem" }}>
              Create an account / Sign In
            </h2>
            <p style={{ color: "#9ca3af", fontSize: "0.9rem" }}>
              Sign in with your Google Account to access your Outreach Dashboard
            </p>
          </div>

          {authError && (
            <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#f87171", padding: "0.75rem 1rem", borderRadius: "10px", fontSize: "0.85rem", marginBottom: "1.5rem", textAlign: "left" }}>
              <strong>Authentication Error:</strong> {authError}
            </div>
          )}

          <button
            onClick={handleGoogleLogin}
            style={{
              width: "100%",
              padding: "0.9rem 1.25rem",
              borderRadius: "12px",
              background: "#ffffff",
              color: "#1f2937",
              fontWeight: "600",
              fontSize: "0.95rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.75rem",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
              transition: "all 0.2s ease",
            }}
            onMouseOver={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
            onMouseOut={(e) => (e.currentTarget.style.transform = "translateY(0)")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            Sign in with Google
          </button>

          <div style={{ marginTop: "2.5rem", fontSize: "0.75rem", color: "#6b7280", lineHeight: "1.6" }}>
            By signing in, you agree to ReachInbox Terms of Service and Privacy Policy. All session tokens are safely encrypted and set via HttpOnly headers.
          </div>
        </div>

      </div>
    </div>
  );
};
