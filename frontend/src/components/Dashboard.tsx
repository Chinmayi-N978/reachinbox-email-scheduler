import React, { useState, useEffect, useRef } from "react";
import type { User, Sender, Email, EmailMetrics, SlackConnection } from "../types";
import { api, API_BASE_URL } from "../services/api";
import {
  Mail,
  Send,
  Clock,
  CheckCircle2,
  AlertCircle,
  Search,
  UserCheck,
  LogOut,
  ExternalLink,
  Plus,
  RefreshCw,
  BarChart3,
  UploadCloud,
  X,
  MessageSquare,
  Calendar,
  Layers,
  FileText,
} from "lucide-react";

interface DashboardProps {
  user: User;
  onLogout: () => void;
}

type TabType = "compose" | "scheduled" | "sent" | "search" | "senders" | "slack" | "metrics";

/**
 * Formats a Date object into local YYYY-MM-DDTHH:mm format for HTML datetime-local input.
 * Uses local calendar components (not UTC) so the user's local timezone is preserved.
 */
function formatLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function getDefaultStartTime(): string {
  return formatLocalDateTime(new Date(Date.now() + 5 * 60 * 1000));
}

function getMinStartTime(): string {
  return formatLocalDateTime(new Date());
}

export const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<TabType>("compose");

  // Global State
  const [senders, setSenders] = useState<Sender[]>([]);
  const [metrics, setMetrics] = useState<EmailMetrics | null>(null);
  const [scheduledEmails, setScheduledEmails] = useState<Email[]>([]);
  const [sentEmails, setSentEmails] = useState<Email[]>([]);
  const [sentStatusFilter, setSentStatusFilter] = useState<"ALL" | "SENT" | "FAILED">("SENT");
  const [selectedEmailDetail, setSelectedEmailDetail] = useState<Email | null>(null);
  const [slackStatus, setSlackStatus] = useState<{
    connected: boolean;
    connection: SlackConnection | null;
  }>({ connected: false, connection: null });
  const [searchResults, setSearchResults] = useState<{
    data: Email[];
    source: string;
  } | null>(null);

  // Form State for Compose / Scheduling
  const [selectedSenderId, setSelectedSenderId] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [manualEmailInput, setManualEmailInput] = useState<string>("");
  const [startTime, setStartTime] = useState<string>(getDefaultStartTime());
  const [delayMs, setDelayMs] = useState<number>(2000);
  const [hourlyLimit, setHourlyLimit] = useState<number>(200);
  const [campaignName, setCampaignName] = useState<string>("");

  // File Upload Ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search State
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Sender Modal / Form State
  const [newSenderEmail, setNewSenderEmail] = useState<string>("");
  const [newSenderName, setNewSenderName] = useState<string>("");

  // Status & Feedback
  const [loading, setLoading] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // URL query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("slack") === "connected") {
      setMessage({ text: "Slack workspace connected successfully! Rate-limit alerts are now active.", type: "success" });
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (params.get("slack_error")) {
      setMessage({ text: `Slack connection failed: ${params.get("slack_error")}`, type: "error" });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Initial Load
  useEffect(() => {
    loadSenders();
    loadMetrics();
    loadSlackStatus();
  }, []);

  useEffect(() => {
    if (activeTab === "scheduled") loadScheduledEmails();
    if (activeTab === "sent") loadSentEmails();
    if (activeTab === "metrics") loadMetrics();
    if (activeTab === "slack") loadSlackStatus();
  }, [activeTab]);

  const loadSenders = async () => {
    try {
      const res = await api.getSenders();
      setSenders(res.data);
      if (res.data.length > 0 && !selectedSenderId) {
        setSelectedSenderId(res.data[0].id);
        if (res.data[0].delayBetweenEmailsMs) setDelayMs(res.data[0].delayBetweenEmailsMs);
        if (res.data[0].hourlyLimit) setHourlyLimit(res.data[0].hourlyLimit);
      }
    } catch (err: any) {
      console.error("Failed to load senders:", err);
    }
  };

  const loadSlackStatus = async () => {
    try {
      const res = await api.getSlackStatus();
      setSlackStatus({ connected: res.connected, connection: res.connection });
    } catch (err: any) {
      console.error("Failed to load Slack status:", err);
    }
  };

  const loadMetrics = async () => {
    try {
      const res = await api.getEmailMetrics();
      setMetrics(res.metrics);
    } catch (err: any) {
      console.error("Failed to load metrics:", err);
    }
  };

  const loadScheduledEmails = async () => {
    setLoading(true);
    try {
      const res = await api.getScheduledEmails({ limit: 50 });
      setScheduledEmails(res.data);
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to load scheduled emails", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const loadSentEmails = async () => {
    setLoading(true);
    try {
      const res = await api.getSentEmails({ limit: 50 });
      setSentEmails(res.data);
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to load sent emails", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleAddManualEmail = (e: React.KeyboardEvent | React.FocusEvent) => {
    if ("key" in e && e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();

    const email = manualEmailInput.trim().toLowerCase();
    if (!email) return;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setMessage({ text: `"${email}" is not a valid email address.`, type: "error" });
      return;
    }

    if (!recipients.includes(email)) {
      setRecipients([...recipients, email]);
    }
    setManualEmailInput("");
  };

  const handleRemoveRecipient = (emailToRemove: string) => {
    setRecipients(recipients.filter((r) => r !== emailToRemove));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setMessage(null);

    try {
      const res = await api.uploadLeads(file);
      const combined = Array.from(new Set([...recipients, ...res.emails]));
      setRecipients(combined);
      setMessage({
        text: `Extracted ${res.count} recipient(s) from ${file.name}. Total list: ${combined.length} recipient(s).`,
        type: "success",
      });
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to upload lead file", type: "error" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!selectedSenderId) {
      setMessage({ text: "Please select or create a sender first.", type: "error" });
      return;
    }

    if (recipients.length === 0) {
      setMessage({ text: "Please provide at least one recipient email address.", type: "error" });
      return;
    }

    setLoading(true);
    try {
      const parsedStartDate = new Date(startTime);
      if (isNaN(parsedStartDate.getTime())) {
        setMessage({ text: "Please select a valid date and time.", type: "error" });
        setLoading(false);
        return;
      }

      const isoStartTime = parsedStartDate.toISOString();
      const res = await api.scheduleCampaign({
        senderId: selectedSenderId,
        subject,
        body,
        recipients,
        startTime: isoStartTime,
        delayBetweenEmailsMs: delayMs,
        hourlyLimit,
        name: campaignName || undefined,
      });

      setMessage({
        text: `Campaign "${res.campaign.name || "Default"}" scheduled successfully for ${res.campaign.totalEmails} recipient(s)!`,
        type: "success",
      });

      // Clear form inputs
      setSubject("");
      setBody("");
      setRecipients([]);
      setStartTime(getDefaultStartTime());
      loadMetrics();
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to schedule email campaign", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSender = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSenderEmail || !newSenderName) return;

    setLoading(true);
    try {
      const res = await api.createSender({
        email: newSenderEmail,
        name: newSenderName,
        delayBetweenEmailsMs: delayMs,
        hourlyLimit,
      });

      setNewSenderEmail("");
      setNewSenderName("");
      setMessage({ text: `Sender "${res.data.email}" added successfully!`, type: "success" });
      await loadSenders();
      setSelectedSenderId(res.data.id);
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to create sender", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnectSlack = async () => {
    setLoading(true);
    try {
      await api.disconnectSlack();
      setMessage({ text: "Slack disconnected successfully.", type: "success" });
      await loadSlackStatus();
    } catch (err: any) {
      setMessage({ text: err.message || "Failed to disconnect Slack", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setLoading(true);
    try {
      const res = await api.searchEmails({ q: searchQuery });
      setSearchResults({ data: res.data, source: res.source });
    } catch (err: any) {
      setMessage({ text: err.message || "Elasticsearch search failed", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top Header Bar */}
      <header className="glass-card" style={{ borderRadius: 0, borderTop: 0, borderLeft: 0, borderRight: 0, padding: "1rem 2rem", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ background: "linear-gradient(135deg, #6366f1, #06b6d4)", width: "36px", height: "36px", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Mail size={20} color="#ffffff" />
          </div>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: "700" }}>ReachInbox Cold Outreach</h1>
            <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Production Email Scheduler & Queue Engine</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <a
            href={`${API_BASE_URL}/admin/queues`}
            target="_blank"
            rel="noopener noreferrer"
            className="glass-btn-secondary"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", textDecoration: "none" }}
          >
            <BarChart3 size={16} color="#818cf8" />
            BullMQ Queue Monitor
            <ExternalLink size={14} />
          </a>

          {/* User Profile Badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.4rem 0.8rem", background: "rgba(255,255,255,0.05)", borderRadius: "9999px", border: "1px solid rgba(255,255,255,0.1)" }}>
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.name} style={{ width: "32px", height: "32px", borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: "0.9rem" }}>
                {user.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: "600", lineHeight: "1.2" }}>{user.name}</span>
              <span style={{ fontSize: "0.7rem", color: "#9ca3af" }}>{user.email}</span>
            </div>
          </div>

          <button onClick={onLogout} className="glass-btn-secondary" style={{ padding: "0.5rem 0.8rem" }} title="Sign Out">
            <LogOut size={18} color="#f87171" />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div style={{ flex: 1, padding: "2rem", maxWidth: "1400px", margin: "0 auto", width: "100%" }}>
        
        {/* Banner Messages */}
        {message && (
          <div
            style={{
              padding: "1rem 1.25rem",
              borderRadius: "12px",
              marginBottom: "1.5rem",
              background: message.type === "success" ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
              border: `1px solid ${message.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
              color: message.type === "success" ? "#34d399" : "#f87171",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              {message.type === "success" ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
              <span>{message.text}</span>
            </div>
            <button onClick={() => setMessage(null)} style={{ background: "transparent", color: "inherit", fontSize: "1rem" }}>×</button>
          </div>
        )}

        {/* Navigation Tabs */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "2rem", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "0.75rem", overflowX: "auto" }}>
          {[
            { id: "compose", label: "Compose New Email", icon: Send },
            { id: "scheduled", label: "Scheduled Emails", icon: Clock },
            { id: "sent", label: "Sent Emails", icon: CheckCircle2 },
            { id: "search", label: "Elasticsearch Search", icon: Search },
            { id: "senders", label: "Sender Accounts", icon: UserCheck },
            { id: "slack", label: "Slack Integration", icon: MessageSquare },
            { id: "metrics", label: "Analytics & Metrics", icon: BarChart3 },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.6rem 1.2rem",
                  borderRadius: "10px",
                  fontSize: "0.9rem",
                  fontWeight: isActive ? "600" : "500",
                  background: isActive ? "rgba(99, 102, 241, 0.2)" : "transparent",
                  color: isActive ? "#818cf8" : "#9ca3af",
                  border: isActive ? "1px solid rgba(99, 102, 241, 0.4)" : "1px solid transparent",
                  transition: "all 0.2s ease",
                  whiteSpace: "nowrap",
                }}
              >
                <Icon size={18} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab 1: Compose New Email (Matching Figma Layout) */}
        {activeTab === "compose" && (
          <div style={{ display: "grid", gridTemplateColumns: "1.9fr 1fr", gap: "2rem" }}>
            <form onSubmit={handleScheduleSubmit} className="glass-card" style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <span style={{ fontSize: "1.3rem", fontWeight: "700" }}>Compose New Email</span>
                </div>
                {recipients.length > 0 && (
                  <span className="badge badge-sent">
                    {recipients.length} Recipient(s) Added
                  </span>
                )}
              </div>

              {/* From Sender Selector */}
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>From (Sender Account)</label>
                <select
                  className="glass-input"
                  style={{ width: "100%" }}
                  value={selectedSenderId}
                  onChange={(e) => {
                    setSelectedSenderId(e.target.value);
                    const chosen = senders.find((s) => s.id === e.target.value);
                    if (chosen) {
                      setDelayMs(chosen.delayBetweenEmailsMs);
                      setHourlyLimit(chosen.hourlyLimit);
                    }
                  }}
                >
                  {senders.map((s) => (
                    <option key={s.id} value={s.id} style={{ background: "#121826" }}>
                      {s.name} &lt;{s.email}&gt; (Delay: {s.delayBetweenEmailsMs}ms, Limit: {s.hourlyLimit}/hr)
                    </option>
                  ))}
                </select>
              </div>

              {/* To Recipients Input & File Upload */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                  <label style={{ fontSize: "0.85rem", color: "#9ca3af" }}>To (Recipients)</label>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <input
                      type="file"
                      ref={fileInputRef}
                      style={{ display: "none" }}
                      accept=".csv,.txt,text/csv,text/plain"
                      onChange={handleFileUpload}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="glass-btn-secondary"
                      style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.4rem" }}
                      disabled={uploading}
                    >
                      <UploadCloud size={14} />
                      {uploading ? "Parsing..." : "Upload List (.csv, .txt)"}
                    </button>
                    {recipients.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setRecipients([])}
                        className="glass-btn-secondary"
                        style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem", color: "#f87171" }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Recipient Chips Container */}
                <div
                  className="glass-input"
                  style={{ minHeight: "80px", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", padding: "0.6rem" }}
                >
                  {recipients.map((rec) => (
                    <span
                      key={rec}
                      style={{
                        background: "rgba(99, 102, 241, 0.2)",
                        border: "1px solid rgba(99, 102, 241, 0.4)",
                        color: "#c7d2fe",
                        padding: "0.2rem 0.6rem",
                        borderRadius: "8px",
                        fontSize: "0.8rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.35rem",
                      }}
                    >
                      {rec}
                      <button
                        type="button"
                        onClick={() => handleRemoveRecipient(rec)}
                        style={{ background: "transparent", color: "inherit", display: "flex", alignItems: "center" }}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    type="email"
                    placeholder={recipients.length === 0 ? "Type email and press Enter, or upload CSV/TXT..." : "Add another email..."}
                    value={manualEmailInput}
                    onChange={(e) => setManualEmailInput(e.target.value)}
                    onKeyDown={handleAddManualEmail}
                    onBlur={handleAddManualEmail}
                    style={{ background: "transparent", border: "none", color: "#f3f4f6", outline: "none", flex: 1, minWidth: "160px", fontSize: "0.85rem" }}
                  />
                </div>
              </div>

              {/* Subject */}
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Subject</label>
                <input
                  type="text"
                  className="glass-input"
                  style={{ width: "100%" }}
                  placeholder="Quick question regarding your growth strategy"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                />
              </div>

              {/* Email Body */}
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Email Body (HTML / Text)</label>
                <textarea
                  className="glass-input"
                  style={{ width: "100%", minHeight: "150px", resize: "vertical" }}
                  placeholder="Hi there,<br><br>I noticed your company has been expanding rapidly..."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  required
                />
              </div>

              {/* Scheduling Controls & Settings */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
                    <Clock size={14} style={{ display: "inline", marginRight: "4px" }} /> Delay (ms)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    className="glass-input"
                    style={{ width: "100%" }}
                    value={delayMs}
                    onChange={(e) => setDelayMs(Number(e.target.value))}
                    required
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
                    <Layers size={14} style={{ display: "inline", marginRight: "4px" }} /> Hourly Limit
                  </label>
                  <input
                    type="number"
                    min="1"
                    className="glass-input"
                    style={{ width: "100%" }}
                    value={hourlyLimit}
                    onChange={(e) => setHourlyLimit(Number(e.target.value))}
                    required
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
                    <Calendar size={14} style={{ display: "inline", marginRight: "4px" }} /> Send Later (Time)
                  </label>
                  <input
                    type="datetime-local"
                    className="glass-input"
                    style={{
                      width: "100%",
                      colorScheme: "dark",
                      cursor: "pointer",
                    }}
                    value={startTime}
                    min={getMinStartTime()}
                    onClick={(e) => {
                      try {
                        e.currentTarget.showPicker?.();
                      } catch {}
                    }}
                    onChange={(e) => setStartTime(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Campaign Name & Submit */}
              <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Campaign Label (Optional)</label>
                  <input
                    type="text"
                    className="glass-input"
                    style={{ width: "100%" }}
                    placeholder="Q4 Reachout Campaign"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                  />
                </div>

                <button type="submit" className="glass-btn" disabled={loading} style={{ height: "44px", minWidth: "180px" }}>
                  {loading ? <RefreshCw className="animate-spin" size={18} /> : <Send size={18} />}
                  Schedule Campaign
                </button>
              </div>
            </form>

            {/* Right Side: Information & Rate-Limit Engine Card */}
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              <div className="glass-card" style={{ padding: "1.5rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: "700", marginBottom: "1rem", color: "#818cf8" }}>Scheduling Pipeline</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem", fontSize: "0.85rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "0.5rem" }}>
                    <span style={{ color: "#9ca3af" }}>Recipients Queue:</span>
                    <strong style={{ color: "#f3f4f6" }}>{recipients.length} emails</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "0.5rem" }}>
                    <span style={{ color: "#9ca3af" }}>Minimum Inter-Delay:</span>
                    <strong style={{ color: "#f3f4f6" }}>{delayMs} ms</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "0.5rem" }}>
                    <span style={{ color: "#9ca3af" }}>Sender Max Capacity:</span>
                    <strong style={{ color: "#f3f4f6" }}>{hourlyLimit} / hour</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#9ca3af" }}>Engine Architecture:</span>
                    <strong style={{ color: "#34d399" }}>BullMQ + Redis Delayed Jobs</strong>
                  </div>
                </div>
              </div>

              {/* Slack Status Card */}
              <div className="glass-card" style={{ padding: "1.5rem", background: "rgba(99, 102, 241, 0.05)", borderColor: "rgba(99, 102, 241, 0.2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                  <h4 style={{ fontSize: "0.95rem", fontWeight: "700", color: "#38bdf8", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <MessageSquare size={16} /> Slack Rate-Limit Alerts
                  </h4>
                  <span className={`badge ${slackStatus.connected ? "badge-sent" : "badge-scheduled"}`}>
                    {slackStatus.connected ? "Active" : "Not Linked"}
                  </span>
                </div>
                <p style={{ fontSize: "0.8rem", color: "#9ca3af", lineHeight: "1.5", marginBottom: "1rem" }}>
                  {slackStatus.connected
                    ? `Connected to team "${slackStatus.connection?.teamName || "Workspace"}". When hourly quota is reached, alerts are deduplicated and dispatched automatically.`
                    : "Connect your Slack workspace to receive automated alerts when sender rate limits are reached."}
                </p>
                {!slackStatus.connected ? (
                  <button
                    type="button"
                    onClick={() => (window.location.href = `${API_BASE_URL}/api/slack/connect`)}
                    className="glass-btn-secondary"
                    style={{ width: "100%", fontSize: "0.85rem" }}
                  >
                    Connect Slack
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleDisconnectSlack}
                    className="glass-btn-secondary"
                    style={{ width: "100%", fontSize: "0.85rem", color: "#f87171" }}
                  >
                    Disconnect Slack
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Scheduled Emails */}
        {activeTab === "scheduled" && (
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1.25rem", fontWeight: "700" }}>Scheduled Email Queue</h2>
              <button onClick={loadScheduledEmails} className="glass-btn-secondary" style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {scheduledEmails.length === 0 ? (
              <div style={{ textAlign: "center", padding: "3rem", color: "#9ca3af" }}>No emails currently scheduled.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#9ca3af" }}>
                      <th style={{ padding: "0.75rem" }}>Recipient</th>
                      <th style={{ padding: "0.75rem" }}>Subject</th>
                      <th style={{ padding: "0.75rem" }}>Scheduled At</th>
                      <th style={{ padding: "0.75rem" }}>Status</th>
                      <th style={{ padding: "0.75rem" }}>Job ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduledEmails.map((email) => (
                      <tr
                        key={email.id}
                        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", transition: "background 0.2s" }}
                        onClick={() => setSelectedEmailDetail(email)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "0.75rem", fontWeight: "600" }}>{email.recipient}</td>
                        <td style={{ padding: "0.75rem", color: "#d1d5db" }}>{email.subject}</td>
                        <td style={{ padding: "0.75rem", color: "#9ca3af" }}>{new Date(email.scheduledAt).toLocaleString()}</td>
                        <td style={{ padding: "0.75rem" }}><span className="badge badge-scheduled">{email.status}</span></td>
                        <td style={{ padding: "0.75rem", fontFamily: "JetBrains Mono, monospace", color: "#6b7280", fontSize: "0.75rem" }}>{email.jobId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Sent Emails */}
        {activeTab === "sent" && (() => {
          const filteredSentEmails = sentEmails.filter((email) => {
            if (sentStatusFilter === "ALL") return true;
            return email.status === sentStatusFilter;
          });

          return (
            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                  <h2 style={{ fontSize: "1.25rem", fontWeight: "700" }}>Sent Email Log</h2>
                  <div style={{ display: "flex", gap: "0.25rem", background: "rgba(255,255,255,0.05)", padding: "0.2rem", borderRadius: "8px" }}>
                    {(["ALL", "SENT", "FAILED"] as const).map((filterOpt) => (
                      <button
                        key={filterOpt}
                        type="button"
                        onClick={() => setSentStatusFilter(filterOpt)}
                        style={{
                          padding: "0.25rem 0.65rem",
                          fontSize: "0.75rem",
                          fontWeight: "600",
                          borderRadius: "6px",
                          border: "none",
                          cursor: "pointer",
                          background: sentStatusFilter === filterOpt ? "rgba(99, 102, 241, 0.4)" : "transparent",
                          color: sentStatusFilter === filterOpt ? "#ffffff" : "#9ca3af",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {filterOpt}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={loadSentEmails} className="glass-btn-secondary" style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              {filteredSentEmails.length === 0 ? (
                <div style={{ textAlign: "center", padding: "3rem", color: "#9ca3af" }}>
                  {sentEmails.length === 0
                    ? "No sent email records found."
                    : `No ${sentStatusFilter} email records found.`}
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#9ca3af" }}>
                        <th style={{ padding: "0.75rem" }}>Recipient</th>
                        <th style={{ padding: "0.75rem" }}>Subject</th>
                        <th style={{ padding: "0.75rem" }}>Sent At</th>
                        <th style={{ padding: "0.75rem" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSentEmails.map((email) => (
                        <tr
                          key={email.id}
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", transition: "background 0.2s" }}
                          onClick={() => setSelectedEmailDetail(email)}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <td style={{ padding: "0.75rem", fontWeight: "600" }}>{email.recipient}</td>
                          <td style={{ padding: "0.75rem", color: "#d1d5db" }}>{email.subject}</td>
                          <td style={{ padding: "0.75rem", color: "#9ca3af" }}>{email.sentAt ? new Date(email.sentAt).toLocaleString() : "N/A"}</td>
                          <td style={{ padding: "0.75rem" }}>
                            <span className={`badge ${email.status === "SENT" ? "badge-sent" : "badge-failed"}`}>
                              {email.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

        {/* Tab 4: Elasticsearch Search */}
        {activeTab === "search" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
            <form onSubmit={handleSearchSubmit} className="glass-card" style={{ padding: "1.5rem", display: "flex", gap: "1rem" }}>
              <input
                type="text"
                className="glass-input"
                style={{ flex: 1 }}
                placeholder="Search across recipient email, subject line, or body contents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                required
              />
              <button type="submit" className="glass-btn" disabled={loading}>
                <Search size={18} />
                Search Elasticsearch
              </button>
            </form>

            {searchResults && (
              <div className="glass-card" style={{ padding: "1.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: "700" }}>Search Results ({searchResults.data.length})</h3>
                  <span className={`badge ${searchResults.source === "elasticsearch" ? "badge-processing" : "badge-scheduled"}`}>
                    Source: {searchResults.source}
                  </span>
                </div>

                {searchResults.data.length === 0 ? (
                  <div style={{ color: "#9ca3af", padding: "1.5rem", textAlign: "center" }}>No matching documents found.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    {searchResults.data.map((item) => (
                      <div
                        key={item.id}
                        style={{ padding: "1rem", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "10px", cursor: "pointer" }}
                        onClick={() => setSelectedEmailDetail(item)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                          <span style={{ fontWeight: "600", color: "#818cf8" }}>{item.recipient}</span>
                          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{item.status}</span>
                        </div>
                        <div style={{ fontWeight: "600", fontSize: "0.9rem", marginBottom: "0.25rem" }}>{item.subject}</div>
                        <div style={{ fontSize: "0.8rem", color: "#9ca3af", whiteSpace: "pre-wrap" }}>{item.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 5: Sender Accounts */}
        {activeTab === "senders" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: "700", marginBottom: "1rem" }}>Your Registered Senders</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {senders.map((s) => (
                  <div key={s.id} style={{ padding: "1rem", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px" }}>
                    <div style={{ fontWeight: "600", fontSize: "0.95rem" }}>{s.name}</div>
                    <div style={{ color: "#818cf8", fontSize: "0.85rem", marginBottom: "0.5rem" }}>{s.email}</div>
                    <div style={{ display: "flex", gap: "1rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                      <span>Delay: {s.delayBetweenEmailsMs}ms</span>
                      <span>Limit: {s.hourlyLimit}/hr</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <form onSubmit={handleCreateSender} className="glass-card" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: "700" }}>Add New Sender Account</h3>
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.3rem" }}>Sender Display Name</label>
                <input
                  type="text"
                  className="glass-input"
                  style={{ width: "100%" }}
                  placeholder="Sales Outreach Team"
                  value={newSenderName}
                  onChange={(e) => setNewSenderName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.3rem" }}>Sender Email Address</label>
                <input
                  type="email"
                  className="glass-input"
                  style={{ width: "100%" }}
                  placeholder="sales@company.com"
                  value={newSenderEmail}
                  onChange={(e) => setNewSenderEmail(e.target.value)}
                  required
                />
              </div>

              <button type="submit" className="glass-btn" disabled={loading}>
                <Plus size={18} /> Add Sender Account
              </button>
            </form>
          </div>
        )}

        {/* Tab 6: Slack Integration */}
        {activeTab === "slack" && (
          <div className="glass-card" style={{ padding: "2.5rem", maxWidth: "750px", margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
              <div style={{ background: "rgba(99, 102, 241, 0.2)", width: "48px", height: "48px", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MessageSquare size={24} color="#818cf8" />
              </div>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: "700" }}>Slack Notifications Integration</h2>
                <p style={{ color: "#9ca3af", fontSize: "0.85rem" }}>
                  Connect your team's Slack workspace to receive automated alerts when sender rate limits are triggered.
                </p>
              </div>
            </div>

            <div style={{ padding: "1.5rem", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", marginBottom: "2rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <span style={{ fontWeight: "600", fontSize: "0.95rem" }}>Connection Status</span>
                <span className={`badge ${slackStatus.connected ? "badge-sent" : "badge-scheduled"}`}>
                  {slackStatus.connected ? "Connected" : "Disconnected"}
                </span>
              </div>

              {slackStatus.connected && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", fontSize: "0.85rem", color: "#d1d5db" }}>
                  <div>Workspace / Team: <strong>{slackStatus.connection?.teamName || "N/A"}</strong></div>
                  <div>Channel: <strong>{slackStatus.connection?.channelName || "Default Channel"}</strong></div>
                  <div>Connected On: <strong>{slackStatus.connection?.createdAt ? new Date(slackStatus.connection.createdAt).toLocaleDateString() : "Active"}</strong></div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "1rem" }}>
              {!slackStatus.connected ? (
                <button
                  type="button"
                  onClick={() => (window.location.href = `${API_BASE_URL}/api/slack/connect`)}
                  className="glass-btn"
                  style={{ flex: 1 }}
                >
                  <MessageSquare size={18} /> Connect Slack Workspace
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleDisconnectSlack}
                  className="glass-btn-secondary"
                  style={{ flex: 1, color: "#f87171", borderColor: "rgba(239, 68, 68, 0.4)" }}
                >
                  Disconnect Slack Workspace
                </button>
              )}
            </div>
          </div>
        )}

        {/* Tab 7: Metrics & Analytics */}
        {activeTab === "metrics" && metrics && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1.5rem" }}>
            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <span style={{ color: "#9ca3af", fontSize: "0.85rem" }}>Total Emails</span>
              <div style={{ fontSize: "2rem", fontWeight: "800", marginTop: "0.5rem" }}>{metrics.total}</div>
            </div>

            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <span style={{ color: "#9ca3af", fontSize: "0.85rem" }}>Scheduled</span>
              <div style={{ fontSize: "2rem", fontWeight: "800", color: "#fbbf24", marginTop: "0.5rem" }}>{metrics.scheduled}</div>
            </div>

            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <span style={{ color: "#9ca3af", fontSize: "0.85rem" }}>Sent</span>
              <div style={{ fontSize: "2rem", fontWeight: "800", color: "#34d399", marginTop: "0.5rem" }}>{metrics.sent}</div>
            </div>

            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <span style={{ color: "#9ca3af", fontSize: "0.85rem" }}>Success Rate</span>
              <div style={{ fontSize: "2rem", fontWeight: "800", color: "#38bdf8", marginTop: "0.5rem" }}>{metrics.successRate}%</div>
            </div>
          </div>
        )}

        {/* Email Detail Modal Popup */}
        {selectedEmailDetail && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.75)",
              backdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 100,
              padding: "1.5rem",
            }}
            onClick={() => setSelectedEmailDetail(null)}
          >
            <div
              className="glass-card"
              style={{
                width: "100%",
                maxWidth: "650px",
                maxHeight: "90vh",
                overflowY: "auto",
                padding: "2rem",
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <FileText size={20} color="#818cf8" />
                  <h3 style={{ fontSize: "1.15rem", fontWeight: "700" }}>Email Record Detail</h3>
                </div>
                <button onClick={() => setSelectedEmailDetail(null)} className="glass-btn-secondary" style={{ padding: "0.3rem 0.6rem" }}>
                  <X size={16} />
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "1rem", fontSize: "0.85rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Recipient:</span>
                  <strong style={{ color: "#c7d2fe", fontSize: "0.95rem" }}>{selectedEmailDetail.recipient}</strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Subject:</span>
                  <strong>{selectedEmailDetail.subject}</strong>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Status:</span>
                  <span className={`badge ${selectedEmailDetail.status === "SENT" ? "badge-sent" : selectedEmailDetail.status === "FAILED" ? "badge-failed" : "badge-scheduled"}`}>
                    {selectedEmailDetail.status}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Scheduled For:</span>
                  <span>{new Date(selectedEmailDetail.scheduledAt).toLocaleString()}</span>
                </div>

                {selectedEmailDetail.sentAt && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "#9ca3af" }}>Sent At:</span>
                    <span>{new Date(selectedEmailDetail.sentAt).toLocaleString()}</span>
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Job ID:</span>
                  <code style={{ color: "#9ca3af", background: "rgba(255,255,255,0.05)", padding: "0.2rem 0.4rem", borderRadius: "6px" }}>
                    {selectedEmailDetail.jobId}
                  </code>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#9ca3af" }}>Idempotency Key:</span>
                  <code style={{ color: "#9ca3af", background: "rgba(255,255,255,0.05)", padding: "0.2rem 0.4rem", borderRadius: "6px" }}>
                    {selectedEmailDetail.idempotencyKey}
                  </code>
                </div>

                {selectedEmailDetail.failureReason && (
                  <div style={{ color: "#f87171", background: "rgba(239, 68, 68, 0.1)", padding: "0.75rem", borderRadius: "8px" }}>
                    <strong>Failure Reason:</strong> {selectedEmailDetail.failureReason}
                  </div>
                )}

                <div>
                  <span style={{ display: "block", color: "#9ca3af", marginBottom: "0.4rem" }}>Message Body:</span>
                  <div
                    style={{
                      background: "rgba(0,0,0,0.3)",
                      padding: "1rem",
                      borderRadius: "10px",
                      border: "1px solid rgba(255,255,255,0.05)",
                      whiteSpace: "pre-wrap",
                      fontSize: "0.85rem",
                      lineHeight: "1.6",
                    }}
                  >
                    {selectedEmailDetail.body}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
