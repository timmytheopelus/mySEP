// Shared fixture + request helpers for the security suite (authz matrix, CSRF, PII leak).
// The test files call vi.mock("@/lib/airtable/client", () => fakeClientModule()) themselves (hoisting).
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { F, PENGAJAR_READ, T } from "@/lib/airtable/schema";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { setMailer } from "@/lib/email";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import { generateSync } from "otplib";
import { PASSWORD, resetStore, seedAccount, store } from "../helpers/fake-airtable";
import { validXlsx } from "../kep/fixtures/build";
import type { Actor, Entry, Method } from "./matrix";

export const PA = "recSECPAROKIA0001";
export const PB = "recSECPAROKIB0001";
export const KEP_A = "recSECKEPA0000001";
export const KEP_B = "recSECKEPB0000001";
export const EV_A = "recSECEVENTA00001";
export const EV_B = "recSECEVENTB00001";
export const SUB_A = "recSECSUBA0000001";
export const PEND_A = "recSECPENDA000001";
export const TU_A = "recSECTEAMA000001";
export const PEWARTA = "recSECPEWARTA0001";

/** Sensitive values seeded into the fixture: none may ever reach a public response, health never an SEP one. */
export const PII = {
  email: "agnes.rahasia@contoh.id",
  phone: "081234567890",
  pengajarHp: "089876543210",
  emergency: "Darurat Yohanes 081111222333",
  doa: "Pendukung Doa Rahasia",
  alamat: "Jl. Rahasia Nomor 9",
  tglLahir: "1980-02-03",
} as const;
export const HEALTH = { penyakit: "Asma-Rahasia", alergi: "Alergi-Kacang-Rahasia", obat: "Obat-Rahasia-500mg" } as const;
export const BPK_SECRET = "Ketua-Dewan-BPK-Rahasia";

export const SESSIONS: Record<Exclude<Actor, "ANON">, Session> = {
  SEP: { accountId: "recSECSEP00000001", email: "sep@sec.test", role: "SEP", parokiId: null },
  PIC: { accountId: "recSECPICA0000001", email: "pic-a@sec.test", role: "PIC", parokiId: PA },
  ADMIN: { accountId: "recSECADMA0000001", email: "adm-a@sec.test", role: "ADMIN", parokiId: PA },
  PIC_OTHER: { accountId: "recSECPICB0000001", email: "pic-b@sec.test", role: "PIC", parokiId: PB },
  ADMIN_OTHER: { accountId: "recSECADMB0000001", email: "adm-b@sec.test", role: "ADMIN", parokiId: PB },
};
export const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PERAN = { SEP: "SEP", PIC: "PIC Paroki", ADMIN: "Admin Paroki" } as const;

const wib = (d: number) => new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

export async function seedFixture(): Promise<void> {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("REG_TOKEN_SECRET", "r".repeat(40));
  vi.stubEnv("APP_BASE_URL", "https://kep.test");
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
  vi.stubEnv("GOOGLE_REDIRECT_BASE", "https://kep.test");
  vi.stubEnv("ABSEN_RECHECK_MS", "0");
  vi.stubEnv("TURNSTILE_SECRET", "");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  invalidateKepCache();
  setMailer({ send: vi.fn(async () => {}) });
  // Every outbound fetch (HIBP, Google, photo upstream) is faked: no network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = String(u);
      if (url.includes("airtableusercontent.com")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
      if (url.includes("pwnedpasswords.com")) return new Response("");
      return new Response("{}", { status: 503 });
    }),
  );

  for (const [k, s] of Object.entries(SESSIONS)) {
    const base = k.startsWith("PIC") ? "PIC" : k.startsWith("ADMIN") ? "ADMIN" : "SEP";
    await seedAccount({
      id: s.accountId,
      email: s.email,
      peran: PERAN[base as keyof typeof PERAN],
      mfaSecret: base === "ADMIN" ? undefined : TOTP_SECRET,
      fields: s.parokiId ? { [F.akunKep.paroki]: [s.parokiId] } : {},
    });
  }

  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Paroki Santa Anna" } },
    { id: PB, fields: { [F.paroki.nama]: "Paroki Santo Bonifasius" } },
  ];
  store[T.penyelenggaraKep] = [
    { id: "recSECORGA0000001", fields: { [F.penyelenggaraKep.paroki]: [PA], [F.penyelenggaraKep.penyelenggara]: "Paroki Santa Anna" } },
    { id: "recSECORGB0000001", fields: { [F.penyelenggaraKep.paroki]: [PB], [F.penyelenggaraKep.penyelenggara]: "Paroki Santo Bonifasius" } },
  ];
  const kep = (id: string, ev: string, org: string, angkatan: number) => ({
    id,
    fields: {
      [F.eventKep.events]: [ev],
      [F.eventKep.penyelenggara]: [org],
      [F.eventKep.statusPersetujuan]: "Disetujui",
      [F.eventKep.angkatan]: angkatan,
      [F.eventKep.tanggalMulai]: wib(-30),
      [F.eventKep.tanggalSelesai]: wib(60),
      [F.eventKep.jenis]: "KEP",
    },
  });
  store[T.eventKep] = [kep(KEP_A, EV_A, "recSECORGA0000001", 1), kep(KEP_B, EV_B, "recSECORGB0000001", 1)];
  const ev = (id: string, nama: string) => ({
    id,
    fields: { [F.events.namaAcara]: nama, [F.events.tanggalAcara]: wib(-30), [F.events.kelompokAcara]: "KEP" },
  });
  store[T.events] = [ev(EV_A, "KEP PAROKI SANTA ANNA ANGKATAN 1"), ev(EV_B, "KEP PAROKI SANTO BONIFASIUS ANGKATAN 1")];
  store[T.subEvent] = [
    { id: SUB_A, fields: { [F.subEvent.acara]: [EV_A], [F.subEvent.agenda]: "Bab 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: wib(-1), [F.subEvent.pengajar]: [PEWARTA] } },
  ];
  store[T.teamUmat] = [
    {
      id: TU_A,
      fields: {
        [F.teamUmat.namaLengkap]: "Agnes Lestari",
        [F.teamUmat.namaBaptis]: "Agnes",
        [F.teamUmat.email]: PII.email,
        [F.teamUmat.noWhatsapp]: PII.phone,
        [F.teamUmat.tanggalLahir]: PII.tglLahir,
        [F.teamUmat.alamatTinggal]: PII.alamat,
        [F.teamUmat.jenisKelamin]: "Wanita",
        [F.teamUmat.statusPernikahan]: "Menikah",
        [F.teamUmat.paroki]: [PA],
        fldSecJabatanBPK001: BPK_SECRET, // a non-allowlisted MasterData field
      },
    },
  ];
  store[T.pendaftaranEvents] = [
    {
      id: PEND_A,
      fields: {
        [F.pendaftaranEvents.event]: [EV_A],
        [F.pendaftaranEvents.teamUmat]: [TU_A],
        [F.pendaftaranEvents.statusPendaftaran]: "Confirmed",
        [F.pendaftaranEvents.kategoriKepesertaan]: "Peserta",
        [F.pendaftaranEvents.kontakDarurat]: PII.emergency,
        [F.pendaftaranEvents.pendukungDoa]: PII.doa,
        [F.pendaftaranEvents.riwayatPenyakit]: HEALTH.penyakit,
        [F.pendaftaranEvents.riwayatAlergi]: HEALTH.alergi,
        [F.pendaftaranEvents.obatRutin]: HEALTH.obat,
      },
    },
  ];
  store[T.pengajarKep] = [
    {
      id: PEWARTA,
      fields: {
        [F.pengajarKep.nama]: "Pewarta Satu",
        [F.pengajarKep.status]: "Aktif",
        [F.pengajarKep.bioSingkat]: "Bio",
        [F.pengajarKep.photo]: [{ url: "https://v5.airtableusercontent.com/foto.jpg" }],
        [PENGAJAR_READ.noHp]: PII.pengajarHp,
        [PENGAJAR_READ.subEvent]: [SUB_A],
      },
    },
  ];
  store[T.babKep] = [];
  store[T.auditKep] = [];
}

export async function cookieFor(actor: Actor): Promise<string | null> {
  if (actor === "ANON") return null;
  const s = SESSIONS[actor];
  return `${SESSION_COOKIE}=${await issueSession(s, { amr: s.role === "ADMIN" ? ["pwd"] : ["pwd", "otp"] })}`;
}

let ipSeq = 0;
export type ReqOpts = { cookie?: string | null; headers?: Record<string, string>; contentType?: string | null; rawBody?: BodyInit };

export async function buildRequest(e: Entry, o: ReqOpts = {}): Promise<Request> {
  const path = "/api/" + e.route.replace(/\[(\w+)\]/g, (_m, k: string) => e.params?.[k] ?? k);
  const url = `https://kep.test${path}${e.query ? `?${e.query}` : ""}`;
  const headers: Record<string, string> = {
    "sec-fetch-site": "same-origin",
    origin: "https://kep.test",
    "x-real-ip": `10.9.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}`,
  };
  if (o.cookie) headers.cookie = o.cookie;
  let body: BodyInit | undefined;
  if (e.method !== "GET") {
    if (o.rawBody !== undefined) body = o.rawBody;
    else if (e.body === "xlsx") {
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(await validXlsx(1))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "peserta.xlsx");
      const r = new Request(url, { method: "POST", body: fd });
      headers["content-type"] = r.headers.get("content-type")!;
      body = new Uint8Array(await r.arrayBuffer());
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(e.body ?? {}, (_k, v) => (v === "$TOTP" ? generateSync({ secret: TOTP_SECRET }) : v === "$PASSWORD" ? PASSWORD : v));
    }
  }
  if (o.contentType !== undefined) {
    if (o.contentType === null) delete headers["content-type"];
    else headers["content-type"] = o.contentType;
  }
  Object.assign(headers, o.headers);
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  return new Request(url, { method: e.method, headers, body });
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
export async function call(e: Entry, o: ReqOpts = {}): Promise<Response> {
  const mod = (await loadRoutes()).get(e.route);
  const h = mod?.[e.method] as Handler | undefined;
  if (!h) throw new Error(`no handler ${e.method} ${e.route}`);
  return h(await buildRequest(e, o), { params: Promise.resolve(e.params ?? {}) });
}

export const HTTP_METHODS: Method[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const API_DIR = join(process.cwd(), "src", "app", "api");

/** Every route.ts below src/app/api, as "kep/[id]/decision". */
export function discoverRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name === "route.ts" || d.name === "route.tsx" || d.name === "route.js") out.push(relative(API_DIR, dir).split(sep).join("/"));
    }
  };
  walk(API_DIR);
  return out.sort();
}

let routes: Map<string, Record<string, unknown>> | null = null;
export async function loadRoutes(): Promise<Map<string, Record<string, unknown>>> {
  if (routes) return routes;
  const m = new Map<string, Record<string, unknown>>();
  for (const r of discoverRoutes()) m.set(r, (await import(pathToFileURL(join(API_DIR, r, "route.ts")).href)) as Record<string, unknown>);
  routes = m;
  return m;
}

export const classify = (status: number) => (status === 401 || status === 403 || status === 404 || status >= 500 ? status : "ok");
