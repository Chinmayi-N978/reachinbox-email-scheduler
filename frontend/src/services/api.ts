import type { User, Sender, Email, EmailMetrics, Pagination, SlackConnection } from "../types";

export const API_BASE_URL = import.meta.env.PROD
  ? ""
  : (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000");

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const isFormData = options.body instanceof FormData;
  const headers = isFormData
    ? { ...options.headers }
    : { ...defaultHeaders, ...options.headers };

  const response = await fetch(url, {
    ...options,
    credentials: "include", // Essential for HttpOnly cookie authentication
    headers,
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    const errorMsg = data.message || `Request failed with status ${response.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

export const api = {
  // Auth API
  async getMe(): Promise<{ success: boolean; user: User }> {
    return request<{ success: boolean; user: User }>("/api/auth/me");
  },

  async logout(): Promise<{ success: boolean; message: string }> {
    return request<{ success: boolean; message: string }>("/api/auth/logout", {
      method: "POST",
    });
  },

  // Slack API
  async getSlackStatus(): Promise<{
    success: boolean;
    connected: boolean;
    connection: SlackConnection | null;
  }> {
    return request<{
      success: boolean;
      connected: boolean;
      connection: SlackConnection | null;
    }>("/api/slack/status");
  },

  async disconnectSlack(): Promise<{ success: boolean; message: string }> {
    return request<{ success: boolean; message: string }>("/api/slack/disconnect", {
      method: "POST",
    });
  },

  // Sender API
  async getSenders(): Promise<{ success: boolean; data: Sender[] }> {
    return request<{ success: boolean; data: Sender[] }>("/api/senders");
  },

  async createSender(data: {
    email: string;
    name: string;
    delayBetweenEmailsMs?: number;
    hourlyLimit?: number;
  }): Promise<{ success: boolean; data: Sender }> {
    return request<{ success: boolean; data: Sender }>("/api/senders", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  // Email Campaign & Scheduler API
  async uploadLeads(file: File): Promise<{
    success: boolean;
    message: string;
    count: number;
    emails: string[];
  }> {
    const formData = new FormData();
    formData.append("file", file);

    return request("/api/emails/upload-leads", {
      method: "POST",
      body: formData,
    });
  },

  async scheduleCampaign(data: {
    senderId: string;
    recipients: string[];
    subject: string;
    body: string;
    startTime: string;
    delayBetweenEmailsMs?: number;
    hourlyLimit?: number;
    name?: string;
  }): Promise<{
    success: boolean;
    message: string;
    campaign: { id: string; name?: string; startTime: string; totalEmails: number };
  }> {
    return request("/api/emails/schedule", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async getScheduledEmails(params?: {
    senderId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ success: boolean; data: Email[]; pagination: Pagination }> {
    const searchParams = new URLSearchParams();
    if (params?.senderId) searchParams.append("senderId", params.senderId);
    if (params?.search) searchParams.append("search", params.search);
    if (params?.page) searchParams.append("page", String(params.page));
    if (params?.limit) searchParams.append("limit", String(params.limit));

    const queryString = searchParams.toString();
    return request(`/api/emails/scheduled${queryString ? `?${queryString}` : ""}`);
  },

  async getSentEmails(params?: {
    senderId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ success: boolean; data: Email[]; pagination: Pagination }> {
    const searchParams = new URLSearchParams();
    if (params?.senderId) searchParams.append("senderId", params.senderId);
    if (params?.status) searchParams.append("status", params.status);
    if (params?.search) searchParams.append("search", params.search);
    if (params?.page) searchParams.append("page", String(params.page));
    if (params?.limit) searchParams.append("limit", String(params.limit));

    const queryString = searchParams.toString();
    return request(`/api/emails/sent${queryString ? `?${queryString}` : ""}`);
  },

  async getEmailMetrics(senderId?: string): Promise<{ success: boolean; metrics: EmailMetrics }> {
    const query = senderId ? `?senderId=${encodeURIComponent(senderId)}` : "";
    return request(`/api/emails/metrics${query}`);
  },

  async getEmailList(params?: {
    senderId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ success: boolean; data: Email[]; pagination: Pagination }> {
    const searchParams = new URLSearchParams();
    if (params?.senderId) searchParams.append("senderId", params.senderId);
    if (params?.status) searchParams.append("status", params.status);
    if (params?.search) searchParams.append("search", params.search);
    if (params?.page) searchParams.append("page", String(params.page));
    if (params?.limit) searchParams.append("limit", String(params.limit));

    const queryString = searchParams.toString();
    return request(`/api/emails/list${queryString ? `?${queryString}` : ""}`);
  },

  async searchEmails(params: {
    q: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    success: boolean;
    source: string;
    data: Email[];
    pagination: Pagination;
  }> {
    const searchParams = new URLSearchParams();
    searchParams.append("q", params.q);
    if (params.status) searchParams.append("status", params.status);
    if (params.page) searchParams.append("page", String(params.page));
    if (params.limit) searchParams.append("limit", String(params.limit));

    return request(`/api/emails/search?${searchParams.toString()}`);
  },
};
