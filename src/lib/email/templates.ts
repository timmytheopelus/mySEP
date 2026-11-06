export type MailTemplate = "invite" | "reset";
export type MailData = { link: string; nama?: string };
export type Rendered = { subject: string; text: string; html: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const COPY: Record<MailTemplate, { subject: string; intro: string; action: string; validity: string }> = {
  invite: {
    subject: "Undangan akun KEP Keuskupan Bandung",
    intro: "Anda diundang menggunakan aplikasi KEP Keuskupan Bandung. Atur password Anda lewat tautan berikut.",
    action: "Atur password",
    validity: "Tautan berlaku 72 jam dan hanya dapat dipakai sekali.",
  },
  reset: {
    subject: "Atur ulang password KEP Keuskupan Bandung",
    intro: "Kami menerima permintaan mengatur ulang password akun Anda. Gunakan tautan berikut.",
    action: "Atur ulang password",
    validity: "Tautan berlaku 30 menit dan hanya dapat dipakai sekali. Jika bukan Anda yang meminta, abaikan email ini.",
  },
};

/** Plain text + minimal HTML; the link is the only variable part and is escaped for HTML. */
export function renderTemplate(template: MailTemplate, data: MailData): Rendered {
  const c = COPY[template];
  const hi = data.nama ? `Halo ${data.nama},` : "Halo,";
  return {
    subject: c.subject,
    text: `${hi}\n\n${c.intro}\n\n${data.link}\n\n${c.validity}\n`,
    html: `<p>${esc(hi)}</p><p>${esc(c.intro)}</p><p><a href="${esc(data.link)}">${esc(c.action)}</a></p><p>${esc(c.validity)}</p>`,
  };
}
