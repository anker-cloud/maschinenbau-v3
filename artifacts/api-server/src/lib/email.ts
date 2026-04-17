/**
 * Email alert helper.
 *
 * Sends SMTP emails via nodemailer. The feature is disabled (silently
 * skipped) when SMTP_HOST or SMTP_USER is not set, so deployments without
 * email infrastructure are unaffected.
 *
 * Required env vars to enable:
 *   SMTP_HOST   — SMTP server hostname  (e.g. smtp.gmail.com)
 *   SMTP_USER   — SMTP auth username    (e.g. alerts@example.com)
 *   SMTP_PASS   — SMTP auth password    (keep in secrets, not .env)
 *
 * Optional:
 *   SMTP_PORT   — defaults to 587 (STARTTLS)
 *   SMTP_FROM   — From address; defaults to SMTP_USER
 *   APP_URL     — Public app URL used for links in alert emails
 *                 (e.g. https://my-app.replit.app). Falls back to
 *                 REPLIT_DEV_DOMAIN if set, then to a placeholder.
 *
 * Feature flag:
 *   ENABLE_INGESTION_FAILURE_ALERTS — set to "false" to disable alert
 *     emails even when SMTP is fully configured. Defaults to enabled.
 */
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

const log = logger.child({ module: "email" });

function alertsEnabled(): boolean {
  if (process.env.ENABLE_INGESTION_FAILURE_ALERTS === "false") return false;
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });
}

function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "https://your-app-url";
}

interface FailedDocInfo {
  id: string;
  title: string;
  filename: string;
  createdAt: Date;
}

/** Send an ingestion-failure alert to all admin users. Fire-and-forget safe. */
export async function sendIngestionFailureAlert(doc: FailedDocInfo): Promise<void> {
  if (!alertsEnabled()) {
    log.info({ documentId: doc.id }, "Ingestion failure alerts disabled or SMTP not configured — skipping");
    return;
  }

  let adminEmails: string[];
  try {
    const admins = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    adminEmails = admins.map((a) => a.email);
  } catch (err) {
    log.error({ err, documentId: doc.id }, "Failed to query admin emails for alert");
    return;
  }

  if (adminEmails.length === 0) {
    log.warn({ documentId: doc.id }, "No admin users found — skipping ingestion failure alert");
    return;
  }

  const fromAddress = process.env.SMTP_FROM ?? process.env.SMTP_USER!;
  const adminLink = `${appUrl()}/admin?tab=documents`;
  const uploadedAt = doc.createdAt.toUTCString();

  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2 style="color: #c0392b;">⚠️ Document indexing failed</h2>
      <p>A document could not be indexed into the Sturtz Maschinenbau support knowledge base.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Title</td><td style="padding: 8px;">${escHtml(doc.title)}</td></tr>
        <tr style="background:#f9f9f9"><td style="padding: 8px; font-weight: bold; color: #555;">Filename</td><td style="padding: 8px;">${escHtml(doc.filename)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Uploaded</td><td style="padding: 8px;">${uploadedAt}</td></tr>
      </table>
      <p>
        <a href="${adminLink}" style="background:#2563EB;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">
          Go to Admin Documents
        </a>
      </p>
      <p style="color:#888;font-size:12px;">
        You can re-upload the file or trigger re-indexing from the Documents tab in the admin panel.
        This notification was sent to all admin accounts.
      </p>
    </div>
  `;

  const text = [
    "Document indexing failed",
    "",
    `Title:    ${doc.title}`,
    `Filename: ${doc.filename}`,
    `Uploaded: ${uploadedAt}`,
    "",
    `Re-ingest at: ${adminLink}`,
  ].join("\n");

  try {
    const transport = makeTransport();
    await transport.sendMail({
      from: fromAddress,
      to: fromAddress,
      bcc: adminEmails.join(", "),
      subject: `[Sturtz Support] Indexing failed: ${doc.title}`,
      text,
      html,
    });
    log.info({ documentId: doc.id, recipients: adminEmails.length }, "Ingestion failure alert sent");
  } catch (err) {
    log.error({ err, documentId: doc.id }, "Failed to send ingestion failure alert email");
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
