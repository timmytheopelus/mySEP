import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GET_LIMIT, GET_WINDOW_S } from "@/lib/auth/guard";
import { readSession, type Session } from "@/lib/auth/session";
import { limitKey, rateLimit } from "@/lib/ratelimit";

/** Where a page goes when the account spent its GET budget (static page, no Airtable read). */
export const PAGE_LIMIT_PATH = "/batas";

/**
 * Session for a server-rendered page, or a redirect to /login. Pages share the per-account GET budget of the API
 * (600 per 10 min, same key as withAuth), so reloading a heavy page in a loop cannot drain the Airtable budget.
 * Server components cannot set cookies: the sliding session is renewed by the client keep-alive
 * (GET /api/sesi/ping from the (app) layout), never beyond the 8 h absolute cap.
 */
export async function pageSession(): Promise<Session> {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const lim = await rateLimit(limitKey("api-get", session.accountId), GET_LIMIT, GET_WINDOW_S);
  if (!lim.ok) redirect(PAGE_LIMIT_PATH);
  return session;
}
