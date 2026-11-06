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

  it("foto: unauthenticated is 401 and never fetches upstream", async () => {
    const { renewSession } = await import("@/lib/auth/session");
    vi.mocked(renewSession).mockResolvedValueOnce(null);
    const f = vi.spyOn(globalThis, "fetch");
    expect((await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx)).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
  it("foto: an upstream redirect is refused (404) and its body cancelled", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 302, headers: { location: "http://169.254.169.254/", "content-type": "image/jpeg" } }));
    expect((await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx)).status).toBe(404);
    expect(cancel).toHaveBeenCalled();
    f.mockRestore();
  });
  it("foto: an oversize Content-Length is refused before reading the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) } }));
    expect((await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx)).status).toBe(404);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    f.mockRestore();
  });
  it("foto: a body that grows past the cap without Content-Length is cut off", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(c) { sent++; c.enqueue(chunk); }, cancel }, { highWaterMark: 0 });
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "image/png" } }));
    expect((await FOTO(new Request("https://app.test/api/pewarta/x/foto"), ctx)).status).toBe(404);
    expect(sent).toBeLessThanOrEqual(5);
    expect(cancel).toHaveBeenCalled();
    f.mockRestore();
  });
});
