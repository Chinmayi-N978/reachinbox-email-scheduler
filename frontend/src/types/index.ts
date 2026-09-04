export interface User {
  id: string;
  googleId: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Sender {
  id: string;
  userId: string;
  email: string;
  name: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailCampaign {
  id: string;
  userId: string;
  senderId: string;
  name?: string | null;
  subject: string;
  body: string;
  startTime: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export type EmailStatus = "SCHEDULED" | "PROCESSING" | "SENT" | "FAILED";

export interface Email {
  id: string;
  userId: string;
  senderId: string;
  campaignId: string;
  recipient: string;
  subject: string;
  body: string;
  sequence: number;
  scheduledAt: string;
  originalScheduledAt: string;
  sentAt?: string | null;
  status: EmailStatus;
  failureReason?: string | null;
  jobId: string;
  idempotencyKey: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  sender?: Sender;
  campaign?: EmailCampaign;
}

export interface EmailMetrics {
  total: number;
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  successRate: number;
}

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SlackConnection {
  id: string;
  teamId?: string | null;
  teamName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  createdAt: string;
  updatedAt: string;
}
