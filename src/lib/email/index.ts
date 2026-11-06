import "server-only";
import { sendViaResend } from "./resend";
import type { MailData, MailTemplate } from "./templates";

export type { MailData, MailTemplate };

/** Everything that sends email goes through this interface so tests can swap it (setMailer). */
export interface Mailer {
  send(to: string, template: MailTemplate, data: MailData): Promise<void>;
}

const DEFAULT_FROM = "KEP Keuskupan Bandung <onboarding@resend.dev>";

/** Real delivery only when RESEND_API_KEY is set; otherwise a no-op that logs nothing sensitive. */
const envMailer: Mailer = {
  async send(to, template, data) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.warn("RESEND_API_KEY is not set: email not sent");
      return;
    }
    await sendViaResend(key, process.env.MAIL_FROM || DEFAULT_FROM, to, template, data);
  },
};

let override: Mailer | null = null;
/** Test hook: install a mock (null restores the default). */
export function setMailer(m: Mailer | null): void {
  override = m;
}

export function sendMail(to: string, template: MailTemplate, data: MailData): Promise<void> {
  return (override ?? envMailer).send(to, template, data);
}

/** Public origin used in emailed links: APP_BASE_URL, else GOOGLE_REDIRECT_BASE. Fixed config, never request-derived. */
export function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || process.env.GOOGLE_REDIRECT_BASE;
  if (!raw) throw new Error("APP_BASE_URL is not configured");
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("APP_BASE_URL must be https");
  return u.origin;
}
