import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
const hdr = vi.hoisted(() => ({ ip: "203.0.113.7" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": hdr.ip, "x-nonce": "n" }) }));

import DaftarPage from "@/app/(public)/daftar/[token]/page";
import * as airtable from "@/lib/airtable/client";
import { signRegistrationToken } from "@/lib/kep/registration";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const EV = "recEVENT00000001";
const view = async (token: string) => renderToStaticMarkup(await DaftarPage({ params: Promise.resolve({ token }) }));

beforeEach(() => {
  vi.stubEnv("REG_TOKEN_SECRET", "r".repeat(40));
  resetStore();
  resetRateLimitMemory();
  hdr.ip = "203.0.113.7";
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("/daftar/[token] page limits (shared links must not drain the Airtable budget)", () => {
  it("per IP: after 120 views in 10 minutes the page answers without any Airtable read", async () => {
    const token = signRegistrationToken(EV);
    for (let i = 0; i < 120; i++) await view(token);
    vi.mocked(airtable.listRecords).mockClear();
    vi.mocked(airtable.getRecord).mockClear();
    const html = await view(token);
    expect(html).toContain("Terlalu banyak permintaan");
    expect(airtable.listRecords).not.toHaveBeenCalled();
    expect(airtable.getRecord).not.toHaveBeenCalled();
  });

  it("per link: many IPs on one link are capped too", async () => {
    const token = signRegistrationToken(EV);
    for (let i = 0; i < 600; i++) {
      hdr.ip = `198.51.100.${i % 250}-${i}`;
      await view(token);
    }
    hdr.ip = "192.0.2.1";
    vi.mocked(airtable.listRecords).mockClear();
    expect(await view(token)).toContain("Terlalu banyak permintaan");
    expect(airtable.listRecords).not.toHaveBeenCalled();
  });

  it("the AuditKEP rotation lookup stays fail-closed: a read error never shows the form", async () => {
    vi.mocked(airtable.listRecords).mockRejectedValueOnce(new Error("Airtable request failed: HTTP 503"));
    await expect(view(signRegistrationToken(EV))).rejects.toThrow();
  });
});
