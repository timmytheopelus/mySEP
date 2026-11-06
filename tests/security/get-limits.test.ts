import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClientModule } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import * as airtable from "@/lib/airtable/client";
import { MATRIX } from "./matrix";
import { call, cookieFor, seedFixture } from "./harness";

beforeEach(seedFixture);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("authenticated GET APIs are limited per account (base-wide Airtable budget)", () => {
  it("after 600 GETs in 10 minutes an account gets 429 before any Airtable read", async () => {
    const e = MATRIX.find((x) => x.route === "pewarta/[id]" && x.method === "GET")!;
    const cookie = await cookieFor("PIC");
    for (let i = 0; i < 600; i++) expect((await call(e, { cookie })).status).toBe(200);
    vi.mocked(airtable.listRecords).mockClear();
    vi.mocked(airtable.getRecord).mockClear();
    const res = await call(e, { cookie });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(airtable.getRecord).not.toHaveBeenCalled();
    // another account is unaffected
    expect((await call(e, { cookie: await cookieFor("ADMIN") })).status).toBe(200);
  });
});
