import { runInBackground } from "@/lib/background";
import { guardPost, clientIp, json, readBody, serverError, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { notAvailable, validationError } from "@/lib/http/registration-http";
import { PesertaInput, RegistrationClosedError, RegistrationInputError, registerPeserta, verifyRegistrationToken } from "@/lib/kep/registration";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import { verifyTurnstile } from "@/lib/security/turnstile";

export const dynamic = "force-dynamic";

const IP_LIMIT = 10; // registrations per hour per IP
const EMAIL_LIMIT = 3; // per hour per email address (stops mail bombing a victim)
const TOKEN_LIMIT = 300; // per hour per KEP link
const HOUR = 3600;
const DEFAULT_FLOOR_MS = 2500;

/**
 * Public self-registration. The answer is the same for "registered" and "already_registered" (no enumeration of
 * people, emails or numbers); the difference only shows in the email. Order: CSRF guard, IP limit, token,
 * validation, captcha (server side, fail closed), per-email and per-KEP limits, then the write.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const started = Date.now();
  try {
    const blocked = guardPost(req);
    if (blocked) return blocked;
    const { token } = await ctx.params;
    const ip = clientIp(req);

    const ipLim = await rateLimit(limitKey("daftar-ip", ip), IP_LIMIT, HOUR);
    if (!ipLim.ok) return tooMany(ipLim.retryAfter);

    const t = verifyRegistrationToken(token);
    if (!t) return notAvailable();

    const { turnstileToken, ...rest } = await readBody(req);
    const parsed = PesertaInput.safeParse(rest);
    if (!parsed.success) return validationError(parsed.error);

    if (!(await verifyTurnstile(turnstileToken, ip))) return json({ error: "Verifikasi keamanan gagal. Muat ulang tantangan lalu coba lagi." }, 400);

    const emailLim = await rateLimit(limitKey("daftar-email", parsed.data.email), EMAIL_LIMIT, HOUR);
    const kepLim = await rateLimit(limitKey("daftar-kep", t.eventId), TOKEN_LIMIT, HOUR);
    if (!emailLim.ok || !kepLim.ok) return tooMany(Math.max(emailLim.retryAfter, kepLim.retryAfter));

    // Row creation happens before the response; email and non-critical audit rows run after it. A floor on the
    // response time evens out the registered / already_registered paths (no timing oracle).
    await registerPeserta(t.eventId, parsed.data, { actorEmail: "publik", defer: runInBackground });
    const floor = Number(process.env.REG_MIN_RESPONSE_MS ?? DEFAULT_FLOOR_MS);
    const wait = floor - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return json({ ok: true, pesan: "Terima kasih, konfirmasi dikirim ke email Anda" });
  } catch (e) {
    if (e instanceof RegistrationClosedError) return notAvailable();
    if (e instanceof RegistrationInputError) return json({ error: e.message }, 422);
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return serverError();
  }
}
