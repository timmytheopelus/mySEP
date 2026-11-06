import { changeAccount, clearGoogleBinding, deactivateAccount, reactivateAccount, resetMfa } from "@/lib/accounts/manage";
import { withAuth } from "@/lib/auth/guard";
import { HttpError } from "@/lib/http/errors";
import { json, readBody } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/** SEP only. Body: { action: deactivate | reactivate | set_role | clear_google | reset_mfa, role?, parokiId? }. */
export const PATCH = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const b = await readBody(req);
    const id = params.id;
    switch (b.action) {
      case "deactivate":
        await deactivateAccount(session, id);
        break;
      case "reactivate":
        await reactivateAccount(session, id);
        break;
      case "set_role":
        await changeAccount(session, id, { role: b.role as "SEP", parokiId: (b.parokiId ?? null) as string | null });
        break;
      case "clear_google":
        await clearGoogleBinding(session, id);
        break;
      case "reset_mfa":
        await resetMfa(session, id);
        break;
      default:
        throw new HttpError(400);
    }
    return json({ ok: true });
  },
  { roles: ["SEP"] },
);
