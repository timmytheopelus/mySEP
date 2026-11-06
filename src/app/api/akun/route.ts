import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { hasUsablePassword, listAllAccounts } from "@/lib/accounts/repo";
import { createAccount } from "@/lib/accounts/manage";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/** SEP only. Never exposes hashes, secrets or the Google subject: only booleans. */
export const GET = withAuth(
  async () => {
    const [rows, paroki] = await Promise.all([listAllAccounts(), listRecords(T.paroki, { fields: [F.paroki.nama] })]);
    return json({
      paroki: paroki
        .map((p) => ({ id: p.id, nama: String(p.fields[F.paroki.nama] ?? "") }))
        .filter((p) => p.nama)
        .sort((a, b) => a.nama.localeCompare(b.nama)),
      akun: rows
        .map((a) => ({
          id: a.id,
          email: a.email,
          nama: a.nama,
          role: a.role,
          parokiId: a.parokiId,
          aktif: a.active,
          googleTerhubung: a.googleSub !== null,
          mfa: a.mfaSecretEnc !== null,
          passwordSudahDiatur: hasUsablePassword(a),
        }))
        .sort((x, y) => x.email.localeCompare(y.email)),
    });
  },
  { roles: ["SEP"] },
);

/** Only these four request keys are read; anything else in the body is ignored. */
export const POST = withAuth(
  async (req, { session }) => {
    const b = await readBody(req);
    const acc = await createAccount(session, {
      email: b.email as string,
      nama: b.nama as string,
      role: b.role as "SEP",
      parokiId: (b.parokiId ?? null) as string | null,
    }, { code: b.code });
    return json({ id: acc.id, email: acc.email, nama: acc.nama, role: acc.role, parokiId: acc.parokiId, undanganTerkirim: acc.inviteSent }, 201);
  },
  { roles: ["SEP"] },
);
