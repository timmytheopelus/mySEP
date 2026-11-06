import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAudit: vi.fn(async () => {}) }));
const session = vi.hoisted(() => ({ role: "PIC" as string }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  renewSession: vi.fn(async () => ({ token: "t", session: { accountId: "recACC0000000001", email: "a@x.id", role: session.role, parokiId: session.role === "SEP" ? null : "recPAROKIA0000001" } })),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), limitKey: (...a: string[]) => a.join(":") }));

import { PATCH, GET } from "@/app/api/pewarta/[id]/route";
import { GET as FOTO } from "@/app/api/pewarta/[id]/foto/route";

const P1 = "recPEWARTA000001";
const ctx = { params: Promise.resolve({ id: P1 }) };
const patch = (body: unknown) =>
  new Request("https://app.test/api/pewarta/x", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://app.test", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

beforeEach(() => {
  resetStore();
  session.role = "PIC";
  store[T.pengajarKep] = [{ id: P1, fields: { [F.pengajarKep.nama]: "A", [F.pengajarKep.status]: "Aktif", [F.pengajarKep.photo]: [{ url: "https://v5.airtableusercontent.com/a.jpg" }] } }];
  store[T.babKep] = [];
});

describe("pewarta routes", () => {
  it("PATCH by PIC is 403", async () => expect((await PATCH(patch({ bioSingkat: "x" }), ctx)).status).toBe(403));
  it("PATCH with unknown key is 422 for SEP", async () => {
    session.role = "SEP";
    expect((await PATCH(patch({ noHp: "1" }), ctx)).status).toBe(422);
  });
  it("GET detail is no-store", async () => {
    const r = await GET(new Request("https://app.test/api/pewarta/x"), ctx);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("foto proxy streams an image with short private cache and refuses non-images", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } }));
    const ok = await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=300");
    expect(f.mock.calls[0][0]).toBe("https://v5.airtableusercontent.com/a.jpg");
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
    f.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx)).status).toBe(404);
    f.mockRestore();
  });
});
