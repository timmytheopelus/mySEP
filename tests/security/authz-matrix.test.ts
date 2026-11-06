import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClientModule } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { ACTORS, MATRIX, expected, type Entry } from "./matrix";
import { HTTP_METHODS, call, classify, cookieFor, discoverRoutes, loadRoutes, seedFixture } from "./harness";

beforeEach(seedFixture);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const key = (e: { route: string; method: string }) => `${e.method} ${e.route}`;

describe("authz matrix covers every API route handler", () => {
  it("every exported handler under src/app/api has exactly one matrix entry, and vice versa", async () => {
    const routes = await loadRoutes();
    expect([...routes.keys()]).toEqual(discoverRoutes());
    expect(routes.size).toBeGreaterThanOrEqual(30);
    const handlers: string[] = [];
    for (const [r, mod] of routes) for (const m of HTTP_METHODS) if (typeof mod[m] === "function") handlers.push(`${m} ${r}`);
    const entries = MATRIX.map(key);
    expect(new Set(entries).size).toBe(entries.length);
    expect(handlers.filter((h) => !entries.includes(h)), "route handler without a matrix entry").toEqual([]);
    expect(entries.filter((x) => !handlers.includes(x)), "matrix entry without a route handler").toEqual([]);
  });

  it("no route exports a DELETE (or PUT) handler: the app has no delete code", async () => {
    for (const [r, mod] of await loadRoutes()) {
      expect(mod.DELETE, r).toBeUndefined();
      expect(mod.PUT, r).toBeUndefined();
    }
  });
});

describe.each(MATRIX.map((e) => [key(e), e] as [string, Entry]))("%s", (_k, e) => {
  it.each(ACTORS)("as %s", async (actor) => {
    const res = await call(e, { cookie: await cookieFor(actor) });
    const want = expected(e, actor);
    const got = e.kind === "public" ? res.status : classify(res.status);
    expect(got, `${key(e)} as ${actor}: HTTP ${res.status} ${await res.clone().text().then((t) => t.slice(0, 160))}`).toBe(want);
  });
});
