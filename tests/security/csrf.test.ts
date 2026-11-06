import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClientModule } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import * as airtable from "@/lib/airtable/client";
import { MATRIX, isMutating, type Actor, type Entry } from "./matrix";
import { call, cookieFor, seedFixture } from "./harness";

beforeEach(seedFixture);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const mutating = MATRIX.filter((e) => isMutating(e.method));
/** An actor the route would otherwise accept, so a rejection can only come from the CSRF guard. */
const actorFor = (e: Entry): Actor => (e.kind === "public" ? "ANON" : e.roles[0] === "ADMIN" ? "ADMIN" : e.roles[0]);

const CROSS: [string, Record<string, string>][] = [
  ["Origin of another site", { origin: "https://evil.example", "sec-fetch-site": "" }],
  ["Origin 'null' (sandboxed iframe / file)", { origin: "null", "sec-fetch-site": "" }],
  ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site", origin: "" }],
  ["Sec-Fetch-Site: same-site (sibling subdomain)", { "sec-fetch-site": "same-site", origin: "" }],
  ["cross-site with a forged same Origin", { "sec-fetch-site": "cross-site", origin: "https://kep.test" }],
  ["preview deployment posting to production", { origin: "https://kep-git-x.vercel.app", "sec-fetch-site": "" }],
  ["neither Origin nor Sec-Fetch-Site", { origin: "", "sec-fetch-site": "" }],
];

const writes = () => vi.mocked(airtable.createRecords).mock.calls.length + vi.mocked(airtable.updateRecords).mock.calls.length;

describe.each(mutating.map((e) => [`${e.method} ${e.route}`, e] as [string, Entry]))("%s", (_k, e) => {
  it.each(CROSS)("rejects %s with 403 and writes nothing", async (_n, headers) => {
    const before = writes();
    const res = await call(e, { cookie: await cookieFor(actorFor(e)), headers });
    expect(res.status).toBe(403);
    expect(writes()).toBe(before);
  });

  const multipart = e.body === "xlsx";
  const wrongTypes = multipart
    ? ["application/json", "text/plain", "application/x-www-form-urlencoded", null]
    : ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null];
  it.each(wrongTypes)("rejects content-type %s with 415 and writes nothing", async (ct) => {
    const before = writes();
    const res = await call(e, { cookie: await cookieFor(actorFor(e)), contentType: ct, rawBody: "{}" });
    expect(res.status).toBe(415);
    expect(writes()).toBe(before);
  });

  it("a same-origin request with the right content type passes the guard", async () => {
    const res = await call(e, { cookie: await cookieFor(actorFor(e)) });
    expect([403, 415]).not.toContain(res.status);
  });
});

it("every mutating route is covered (multipart import routes included)", () => {
  expect(mutating.length).toBeGreaterThanOrEqual(23);
  expect(mutating.filter((e) => e.body === "xlsx").map((e) => e.route).sort()).toEqual(["kep/[id]/import/commit", "kep/[id]/import/preview"]);
});
