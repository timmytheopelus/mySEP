import { scopeFilter, withAuth } from "@/lib/auth/guard";
import { logAudit } from "@/lib/audit/log";
import { tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { kehadiranPerPertemuan, profilPeserta, rekapAngkatan, toCsv, trenTahunan } from "@/lib/kep/reports";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const JENIS = ["rekap-angkatan", "kehadiran", "tren", "profil"] as const;
type Jenis = (typeof JENIS)[number];
const NO_STORE = { "Cache-Control": "no-store" };

function csvRows(jenis: Jenis, data: unknown): Record<string, unknown>[] {
  if (jenis !== "profil") return data as Record<string, unknown>[];
  const p = data as Record<string, Record<string, unknown>>;
  return Object.entries(p).flatMap(([dimensi, m]) => Object.entries(m).map(([kelompok, jumlah]) => ({ dimensi, kelompok, jumlah })));
}

/**
 * Reports. SEP: all parishes (optionally narrowed by ?paroki=). PIC/ADMIN: own parish only, taken from the
 * session; ?paroki= naming another parish is a 404. ?format=csv downloads (audited).
 */
export const GET = withAuth(
  async (req, { session, params }) => {
    const jenis = (JENIS as readonly string[]).includes(params.jenis) ? (params.jenis as Jenis) : null;
    if (!jenis) throw new HttpError(404);
    const lim = await rateLimit(limitKey("laporan", session.accountId), 30, 60);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") throw new HttpError(422, "Format tidak dikenal");

    let scope = scopeFilter(session);
    const wanted = url.searchParams.get("paroki");
    if (wanted !== null) {
      if (!REC_ID.test(wanted) || (session.role !== "SEP" && wanted !== session.parokiId)) throw new HttpError(404);
      scope = { parokiId: wanted };
    }

    let data: unknown;
    if (jenis === "kehadiran") {
      const kep = url.searchParams.get("kep");
      if (!kep) throw new HttpError(422, "Parameter kep wajib");
      data = await kehadiranPerPertemuan(session, kep);
    } else if (jenis === "rekap-angkatan") data = await rekapAngkatan(scope);
    else if (jenis === "tren") data = await trenTahunan(scope);
    else data = await profilPeserta(scope);

    if (format === "json") return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE } });

    // audit first, ids only (the report name and the scope id; never rows)
    await logAudit({ actorEmail: session.email, action: "laporan_unduh", targetId: jenis, after: { jenis, paroki: scope.parokiId, t: Date.now() } });
    return new Response("﻿" + toCsv(csvRows(jenis, data)), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="laporan-${jenis}.csv"`,
        "X-Content-Type-Options": "nosniff",
        ...NO_STORE,
      },
    });
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);
