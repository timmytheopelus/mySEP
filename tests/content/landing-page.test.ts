import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Plain function (not vi.fn): a vi.fn returning a rejected promise is reported by vitest as a test error.
let impl: () => Promise<unknown>;
vi.mock("@/lib/kep/readModel", () => ({ publicStats: () => impl() }));

import LandingPage from "../../src/app/(public)/page";

const render = async () => renderToStaticMarkup(await LandingPage());

beforeEach(() => {
  impl = async () => {
    throw new Error("unset");
  };
});

describe("landing page stats", () => {
  it("degrades gracefully when publicStats rejects (no throw, no stats band, fallback text, no error leak)", async () => {
    impl = () => Promise.reject(new Error("Airtable request failed: HTTP 500 SECRET-DETAIL"));
    const html = await render();
    expect(html).toContain("Apa itu KEP?");
    expect(html).toContain("Daftar paroki belum dapat ditampilkan");
    expect(html).not.toContain("stat-paroki");
    expect(html).not.toMatch(/Airtable|HTTP 500|SECRET-DETAIL/);
    expect(html).toContain('href="/login"');
  });
  it("renders numbers and parish list when publicStats resolves", async () => {
    impl = async () => ({ paroki: 2, angkatan: 3, lulusan: 4, daftarParoki: [{ nama: "St. Laurentius", angkatan: 18 }] });
    const html = await render();
    expect(html).toContain("stat-lulusan");
    expect(html).toContain("St. Laurentius");
    expect(html).not.toContain("Daftar paroki belum dapat ditampilkan");
  });
});
