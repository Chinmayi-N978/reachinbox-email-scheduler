import nodemailer from "nodemailer";

const smtpHost = process.env.ETHEREAL_SMTP_HOST || process.env.SMTP_HOST;
const smtpPort =
  Number(process.env.ETHEREAL_SMTP_PORT || process.env.SMTP_PORT) || 587;
const smtpUser = process.env.ETHEREAL_SMTP_USER || process.env.SMTP_USER;
const smtpPass = process.env.ETHEREAL_SMTP_PASS || process.env.SMTP_PASS;

if (!smtpHost || !smtpUser || !smtpPass) {
  throw new Error("SMTP configuration is missing (requires ETHEREAL_SMTP_* or SMTP_* variables)");
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(input: SendEmailInput) {
  const info = await transporter.sendMail({
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });

  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info) || null,
  };
}