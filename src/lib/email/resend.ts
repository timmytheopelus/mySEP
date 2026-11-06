import "server-only";
import { renderTemplate, type MailData, type MailTemplate } from "./templates";

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

/** Sends through the Resend REST API. Never logs the message (it carries a one-time link). */
export async function sendViaResend(apiKey: string, from: string, to: string, template: MailTemplate, data: MailData): Promise<void> {
  const m = renderTemplate(template, data);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Resend request failed: HTTP ${res.status}`);
}
