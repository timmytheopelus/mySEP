export type MailTemplate = "invite" | "reset" | "kep_keputusan";
export type MailData = { link: string; nama?: string; kepNama?: string; keputusan?: "Disetujui" | "Ditolak"; catatan?: string };
export type Rendered = { subject: string; text: string; html: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const COPY: Record<"invite" | "reset", { subject: string; intro: string; action: string; validity: string }> = {
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
  if (template === "kep_keputusan") return renderKepDecision(data);
  const c = COPY[template];
  const hi = data.nama ? `Halo ${data.nama},` : "Halo,";
  return {
    subject: c.subject,
    text: `${hi}\n\n${c.intro}\n\n${data.link}\n\n${c.validity}\n`,
    html: `<p>${esc(hi)}</p><p>${esc(c.intro)}</p><p><a href="${esc(data.link)}">${esc(c.action)}</a></p><p>${esc(c.validity)}</p>`,
  };
}

/** Decision on a submitted KEP. Every variable part (names, note) is escaped for HTML. */
function renderKepDecision(data: MailData): Rendered {
  const hi = data.nama ? `Halo ${data.nama},` : "Halo,";
  const kep = data.kepNama || "KEP";
  const verdict = data.keputusan === "Ditolak" ? "ditolak" : "disetujui";
  const intro = `Pengajuan ${kep} telah ${verdict} oleh SEP.`;
  const note = data.catatan?.trim() ? `Catatan SEP: ${data.catatan.trim()}` : "";
  const action = "Buka aplikasi KEP";
  return {
    subject: `Pengajuan KEP ${data.keputusan === "Ditolak" ? "Ditolak" : "Disetujui"}`,
    text: `${hi}\n\n${intro}\n${note ? `\n${note}\n` : ""}${data.link ? `\n${data.link}\n` : ""}`,
    html: `<p>${esc(hi)}</p><p>${esc(intro)}</p>${note ? `<p>${esc(note)}</p>` : ""}${data.link ? `<p><a href="${esc(data.link)}">${esc(action)}</a></p>` : ""}`,
  };
}
