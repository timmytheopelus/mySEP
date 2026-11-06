import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeClientModule } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.50", "x-nonce": "n" }) }));

import LandingPage from "@/app/(public)/page";
import DaftarPage from "@/app/(public)/daftar/[token]/page";
import { POST as daftarPost } from "@/app/api/daftar/[token]/route";
import { testimonials, visibleTestimonials } from "../../content/testimonials";
import { getKepHub } from "@/lib/kep/hub";
import { listPesertaView, publicStats } from "@/lib/kep/readModel";
import { signRegistrationToken } from "@/lib/kep/registration";
import { MATRIX } from "./matrix";
import { BPK_SECRET, EV_A, HEALTH, KEP_A, PII, SESSIONS, call, cookieFor, seedFixture } from "./harness";

beforeEach(seedFixture);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SECRET_VALUES = [...Object.values(PII), ...Object.values(HEALTH), BPK_SECRET];
const FIELD_ID = /fld[A-Za-z0-9]{14}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+62|\b0)8\d{7,12}\b/;

function assertNoPii(where: string, text: string) {
  for (const v of SECRET_VALUES) expect(text, `${where} leaks "${v}"`).not.toContain(v);
  expect(text, `${where} leaks a field id`).not.toMatch(FIELD_ID);
  expect(text, `${where} contains a phone number`).not.toMatch(PHONE);
}
const assertNoHealth = (where: string, text: string) => {
  for (const v of Object.values(HEALTH)) expect(text, `${where} leaks health data "${v}"`).not.toContain(v);
  expect(text).not.toMatch(/riwayatPenyakit|riwayatAlergi|obatRutin|kesehatan"/);
};

describe("public surfaces never carry personal, health or BPK data", () => {
  it("landing page (with live public stats from the fixture)", async () => {
    await publicStats(); // warm instance (a cold one renders the static fallback, see readModel tests)
    const html = renderToStaticMarkup(await LandingPage());
    expect(html).toContain("Santa Anna"); // stats really rendered from the fixture
    assertNoPii("landing", html);
    expect(html.replace(/mailto:[^"]*/g, "")).not.toMatch(EMAIL);
  });

  it("public stats: only the allowlisted aggregate keys", async () => {
    const s = await publicStats();
    expect(Object.keys(s).sort()).toEqual(["angkatan", "daftarParoki", "lulusan", "paroki"]);
    for (const p of s.daftarParoki) expect(Object.keys(p).sort()).toEqual(["angkatan", "nama"]);
    assertNoPii("publicStats", JSON.stringify(s));
  });

  it("testimonials: quotes only unless consent; no contact data in shipped content", () => {
    const shipped = JSON.stringify(visibleTestimonials(testimonials));
    expect(shipped).not.toMatch(EMAIL);
    expect(shipped).not.toMatch(PHONE);
    visibleTestimonials(testimonials).forEach((t, i) => {
      for (const k of Object.keys(t)) expect(["quote", ...(testimonials[i].consent ? ["name", "photo"] : [])]).toContain(k);
    });
  });

  it("/daftar/[token] page: KEP name and parish names only", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    const html = renderToStaticMarkup(await DaftarPage({ params: Promise.resolve({ token: signRegistrationToken(EV_A) }) }));
    expect(html).toContain("Pendaftaran peserta");
    expect(html).toContain("Paroki Santo Bonifasius");
    assertNoPii("/daftar page", html);
    expect(html).not.toMatch(EMAIL);
  });

  it("public API responses (auth flows, registration) echo nothing personal", async () => {
    for (const e of MATRIX.filter((x) => x.kind === "public")) {
      const res = await call(e, { cookie: await cookieFor("ANON") });
      assertNoPii(`${e.method} ${e.route}`, (await res.text()) + JSON.stringify([...res.headers]));
    }
  });

  it("public registration: a rejected submission never echoes the submitted values", async () => {
    const token = signRegistrationToken(EV_A);
    const body = { namaLengkap: "Agnes Lestari", email: PII.email, noWhatsapp: PII.phone, riwayatPenyakit: HEALTH.penyakit, alamat: PII.alamat, tanggalLahir: "bukan-tanggal" };
    const req = new Request(`https://kep.test/api/daftar/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.9" },
      body: JSON.stringify(body),
    });
    const res = await daftarPost(req, { params: Promise.resolve({ token }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    assertNoPii("POST /api/daftar (invalid)", await res.text());
  });
});

describe("SEP never receives health data", () => {
  it("peserta view: health only for the owning parish, never SEP (positive control for PIC)", async () => {
    const sep = JSON.stringify(await listPesertaView(SESSIONS.SEP, KEP_A));
    expect(sep).toContain("Agnes Lestari");
    assertNoHealth("listPesertaView(SEP)", sep);
    const pic = JSON.stringify(await listPesertaView(SESSIONS.PIC, KEP_A));
    expect(pic).toContain(HEALTH.penyakit); // the fixture really carries health data
  });

  it("KEP hub for SEP", async () => {
    assertNoHealth("getKepHub(SEP)", JSON.stringify(await getKepHub(SESSIONS.SEP, KEP_A)));
  });

  it("every GET API route answered as SEP, and every report as SEP", async () => {
    const gets = MATRIX.filter((e) => e.method === "GET" && e.kind === "auth");
    const extra = ["rekap-angkatan", "tren", "profil"].map((jenis) => ({ ...gets.find((g) => g.route === "laporan/[jenis]")!, params: { jenis }, query: "" }));
    const csv = ["kehadiran", "rekap-angkatan", "profil"].map((jenis) => ({ ...gets.find((g) => g.route === "laporan/[jenis]")!, params: { jenis }, query: `format=csv&kep=${KEP_A}` }));
    for (const e of [...gets, ...extra, ...csv]) {
      const res = await call(e, { cookie: await cookieFor("SEP") });
      const ct = res.headers.get("content-type") ?? "";
      const text = ct.startsWith("image/") ? "" : await res.text();
      assertNoHealth(`SEP GET ${e.route} ${e.query ?? ""}`, text);
      expect(text).not.toContain(BPK_SECRET);
    }
  });
});
