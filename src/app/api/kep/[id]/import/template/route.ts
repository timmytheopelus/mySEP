import { withAuth } from "@/lib/auth/guard";
import { tooMany } from "@/lib/http/auth-http";
import { buildTemplateXlsx } from "@/lib/kep/import";
import { importTarget, parokiLookup } from "@/lib/kep/importHttp";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export const GET = withAuth<{ id: string }>(
  async (_req, { session, params }) => {
    const lim = await rateLimit(limitKey("peserta-import-template", session.accountId), 30, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    await importTarget(session, params.id);
    const buf = await buildTemplateXlsx({ parokiNames: (await parokiLookup()).names });
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="template-peserta-kep.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  },
  { roles: ["PIC"] },
);
