import { withAuth } from "@/lib/auth/guard";
import { json } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/**
 * Session keep-alive for server-rendered pages (they cannot set cookies). withAuth does the work: valid session
 * (401 otherwise), the per-account GET budget (600 / 10 min) and the sliding renewal, which never extends past the
 * 8 h absolute cap. No Airtable read beyond the cached account check; tiny body.
 */
export const GET = withAuth(async () => json({ ok: true }), { roles: ["SEP", "PIC", "ADMIN"] });
