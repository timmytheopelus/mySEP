import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { PASSWORD, fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/auth/reauth", () => ({ reauthenticate: vi.fn(async () => true) }));

import {
  LinkError,
  changeAccount,
  clearGoogleBinding,
  confirmPasswordReset,
  createAccount,
  deactivateAccount,
  reactivateAccount,
  requestPasswordReset,
  resetMfa,
} from "@/lib/accounts/manage";
import { setMailer, type Mailer } from "@/lib/email";
import { SESSION_COOKIE, clearSessionCache, issueSession, readSession, type Session } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { reauthenticate } from "@/lib/auth/reauth";
import * as airtable from "@/lib/airtable/client";
import { flushBackground } from "@/lib/background";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import { HttpError } from "@/lib/http/errors";

const A = F.akunKep;
const PA = "recPAROKIA0000001";
const sepA: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const sepB: Session = { accountId: "recSEPB000000001", email: "sepb@x.id", role: "SEP", parokiId: null };
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;
const audits = () => store[T.auditKep] ?? [];

let sent: { to: string; template: string; link: string }[];
const mailer: Mailer = {
  send: vi.fn(async (to, template, data) => void sent.push({ to, template, link: data.link })),
};
const tokenOf = (link: string) => new URL(link).hash.replace(/^#token=/, "");
const STEP = { code: "123456" };
const strong = "tangga-biru-melompat-77!";

function stubHibp(breached = false, down = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (down) throw new Error("network");
      expect(String(url)).toContain("pwnedpasswords.com/range/");
      if (!breached) return new Response("0000000000000000000000000000000000A:0\r\n");
      return new Response("");
    }),
  );
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  sent = [];
  setMailer(mailer);
  stubHibp();
  store[T.paroki] = [{ id: PA, fields: {} }];
  await seedAccount({ id: sepA.accountId, email: sepA.email, peran: "SEP" });
  await seedAccount({ id: sepB.accountId, email: sepB.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setMailer(null);
});

const status = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as HttpError | null)?.status ?? null;

describe("createAccount", () => {
  const input = { email: "Baru@Paroki.id ", nama: "Baru", role: "PIC" as const, parokiId: PA };

  it("non-SEP actors get 403 and nothing is written or sent", async () => {
    expect(await status(createAccount(pic, input, STEP))).toBe(403);
    expect(store[T.akunKep]).toHaveLength(3);
    expect(sent).toHaveLength(0);
  });

  it("PIC/ADMIN require a parokiId; SEP must not have one; unknown paroki rejected", async () => {
    expect(await status(createAccount(sepA, { ...input, parokiId: null }, STEP))).toBe(422);
    expect(await status(createAccount(sepA, { ...input, role: "ADMIN", parokiId: null }, STEP))).toBe(422);
    expect(await status(createAccount(sepA, { ...input, role: "SEP", parokiId: PA }, STEP))).toBe(422);
    expect(await status(createAccount(sepA, { ...input, parokiId: "recNOPE000000001" }, STEP))).toBe(422);
    expect(await status(createAccount(sepA, { ...input, email: "not-an-email" }, STEP))).toBe(422);
    expect(await status(createAccount(sepA, { ...input, role: "BOSS" as never }, STEP))).toBe(422);
  });

  it("creates an active account without a password, audits it and mails a 72 h invite", async () => {
    const acc = await createAccount(sepA, input, STEP);
    expect(acc.email).toBe("baru@paroki.id");
    const r = row(acc.id);
    expect(r.fields[A.peran]).toBe("PIC Paroki");
    expect(r.fields[A.paroki]).toEqual([PA]);
    expect(r.fields[A.statusAktif]).toBe(true);
    expect(String(r.fields[A.hashPassword])).toMatch(/^unset:/);
    expect(audits().map((a) => a.fields[F.auditKep.aksi])).toContain("akun_buat");
    await flushBackground();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "baru@paroki.id", template: "invite" });
    expect(sent[0].link.startsWith("https://kep.example.org/atur-password#token=")).toBe(true);
  });

  it("rejects a duplicate email, also when the existing account is inactive", async () => {
    await createAccount(sepA, input, STEP);
    expect(await status(createAccount(sepA, input, STEP))).toBe(409);
    await seedAccount({ id: "recOLD0000000001", email: "lama@x.id", peran: "SEP", active: false });
    expect(await status(createAccount(sepA, { ...input, email: "LAMA@x.id" }, STEP))).toBe(409);
  });

  it("the invite is single use, lasts 72 h and sets the first password", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const acc = await createAccount(sepA, input, STEP);
    await flushBackground();
    const tok = tokenOf(sent[0].link);
    await confirmPasswordReset(tok, strong);
    expect(await verifyPassword(String(row(acc.id).fields[A.hashPassword]), strong)).toBe(true);
    expect((await confirmPasswordReset(tok, strong + "x").catch((e) => e)) as LinkError).toBeInstanceOf(LinkError);
    // expiry
    const acc2 = await createAccount(sepA, { ...input, email: "dua@paroki.id" }, STEP);
    await flushBackground();
    const tok2 = tokenOf(sent[1].link);
    vi.setSystemTime(Date.now() + 72 * 3600_000 + 60_000);
    await expect(confirmPasswordReset(tok2, strong)).rejects.toBeInstanceOf(LinkError);
    expect(String(row(acc2.id).fields[A.hashPassword])).toMatch(/^unset:/);
  });

  it("an invite still works at 71 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await createAccount(sepA, input, STEP);
    await flushBackground();
    vi.setSystemTime(Date.now() + 71 * 3600_000);
    await expect(confirmPasswordReset(tokenOf(sent[0].link), strong)).resolves.toBeUndefined();
  });
});

describe("requestPasswordReset", () => {
  it("unknown, inactive and known emails all resolve; only the known active one gets mail", async () => {
    await seedAccount({ id: "recOFF0000000001", email: "off@x.id", peran: "SEP", active: false });
    await expect(requestPasswordReset("nobody@x.id")).resolves.toBeUndefined();
    await expect(requestPasswordReset("off@x.id")).resolves.toBeUndefined();
    await flushBackground();
    expect(sent).toHaveLength(0);
    await expect(requestPasswordReset(" SEPA@x.id")).resolves.toBeUndefined();
    await flushBackground();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sepa@x.id", template: "reset" });
  });

  it("a mailer failure never surfaces", async () => {
    setMailer({ send: vi.fn(async () => { throw new Error("resend down"); }) });
    await expect(requestPasswordReset("sepa@x.id")).resolves.toBeUndefined();
    await flushBackground();
  });
});

describe("confirmPasswordReset", () => {
  async function link(email = "sepa@x.id") {
    await requestPasswordReset(email);
    await flushBackground();
    return tokenOf(sent[sent.length - 1].link);
  }

  it("sets the password, clears the failure count/lock, and the token cannot be used twice", async () => {
    row(sepA.accountId).fields[A.gagalLogin] = 4;
    row(sepA.accountId).fields[A.waktuKunci] = new Date(Date.now() + 600_000).toISOString();
    const tok = await link();
    await confirmPasswordReset(tok, strong);
    expect(await verifyPassword(String(row(sepA.accountId).fields[A.hashPassword]), strong)).toBe(true);
    expect(row(sepA.accountId).fields[A.gagalLogin]).toBe(0);
    expect(row(sepA.accountId).fields[A.waktuKunci]).toBeUndefined();
    await expect(confirmPasswordReset(tok, strong + "2")).rejects.toBeInstanceOf(LinkError);
    expect(await verifyPassword(String(row(sepA.accountId).fields[A.hashPassword]), strong)).toBe(true);
  });

  it("rejects a token at 31 minutes but accepts one at 29", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t1 = await link();
    vi.setSystemTime(Date.now() + 29 * 60_000);
    await expect(confirmPasswordReset(t1, strong)).resolves.toBeUndefined();
    const t2 = await link("sepb@x.id");
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await expect(confirmPasswordReset(t2, strong)).rejects.toBeInstanceOf(LinkError);
  });

  it("a newer reset does not leave older links usable once the password changed (hash binding)", async () => {
    const t1 = await link();
    const t2 = await link();
    await confirmPasswordReset(t2, strong);
    await expect(confirmPasswordReset(t1, strong + "9")).rejects.toBeInstanceOf(LinkError);
  });

  it("rejects an 11 character password, a breached one, and fails closed when HIBP is down; token stays usable", async () => {
    const tok = await link();
    await expect(confirmPasswordReset(tok, "abcdefghijk")).rejects.toMatchObject({ code: "weak" });
    stubHibp(false, true);
    await expect(confirmPasswordReset(tok, strong)).rejects.toMatchObject({ code: "breach_unavailable" });
    const sha1 = createHash("sha1").update(strong).digest("hex").toUpperCase();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${sha1.slice(5)}:12\r\n`)));
    await expect(confirmPasswordReset(tok, strong)).rejects.toMatchObject({ code: "breached" });
    expect(row(sepA.accountId).fields[A.hashPassword]).toBeDefined();
    expect(await verifyPassword(String(row(sepA.accountId).fields[A.hashPassword]), PASSWORD)).toBe(true);
    stubHibp();
    await expect(confirmPasswordReset(tok, strong)).resolves.toBeUndefined();
  });

  it("garbage, tampered and cross-purpose tokens are rejected", async () => {
    await expect(confirmPasswordReset("garbage", strong)).rejects.toBeInstanceOf(LinkError);
    const tok = await link();
    await expect(confirmPasswordReset(tok.slice(0, -3) + "abc", strong)).rejects.toBeInstanceOf(LinkError);
    const session = await issueSession(sepA, { amr: ["pwd", "otp"] });
    await expect(confirmPasswordReset(session, strong)).rejects.toBeInstanceOf(LinkError);
  });

  it("a deactivated account cannot complete a reset", async () => {
    const tok = await link();
    row(sepA.accountId).fields[A.statusAktif] = false;
    await expect(confirmPasswordReset(tok, strong)).rejects.toBeInstanceOf(LinkError);
  });

  it("older sessions are void after the reset", async () => {
    const old = await issueSession(sepA, { amr: ["pwd", "otp"] });
    expect(await readSession(`${SESSION_COOKIE}=${old}`)).not.toBeNull();
    await confirmPasswordReset(await link(), strong);
    expect(await readSession(`${SESSION_COOKIE}=${old}`)).toBeNull();
    const fresh = await issueSession(sepA, { amr: ["pwd", "otp"] });
    expect(await readSession(`${SESSION_COOKIE}=${fresh}`)).not.toBeNull();
  });
});

describe("round 1 fixes", () => {
  const input = { email: "baru@paroki.id", nama: "Baru", role: "PIC" as const, parokiId: PA };

  it("links issued in an earlier no-password period die on reactivation (also with a cold limiter)", async () => {
    const acc = await createAccount(sepA, input, STEP);
    const invite = tokenOf(sent[0].link);
    await requestPasswordReset(input.email); // reset link while no password exists
    await flushBackground();
    const reset = tokenOf(sent[1].link);
    const hash1 = String(row(acc.id).fields[A.hashPassword]);
    await deactivateAccount(sepA, acc.id);
    await reactivateAccount(sepA, acc.id);
    expect(String(row(acc.id).fields[A.hashPassword])).not.toBe(hash1);
    resetRateLimitMemory(); // cold start / other instance
    await expect(confirmPasswordReset(invite, strong)).rejects.toBeInstanceOf(LinkError);
    await expect(confirmPasswordReset(reset, strong)).rejects.toBeInstanceOf(LinkError);
    await flushBackground();
    await expect(confirmPasswordReset(tokenOf(sent.at(-1)!.link), strong)).resolves.toBeUndefined(); // the new invite works
  });

  it("an unusable placeholder password can never verify", async () => {
    await createAccount(sepA, input, STEP);
    const h = String(store[T.akunKep].find((r) => r.fields[A.email] === input.email)!.fields[A.hashPassword]);
    expect(await verifyPassword(h, "unset")).toBe(false);
    expect(await verifyPassword(h, h)).toBe(false);
  });

  it("reactivation also clears the Google binding", async () => {
    row(pic.accountId).fields[A.idGoogle] = "g-sub-1";
    await deactivateAccount(sepA, pic.accountId);
    await reactivateAccount(sepA, pic.accountId);
    expect(row(pic.accountId).fields[A.idGoogle]).toBeUndefined();
  });

  it("SEP-impacting actions need a fresh step-up from the acting SEP; PIC creation does not", async () => {
    const deny = () => vi.mocked(reauthenticate).mockResolvedValueOnce(false);
    deny();
    expect(await status(createAccount(sepA, { ...input, role: "SEP", parokiId: null }, STEP))).toBe(403);
    deny();
    expect(await status(changeAccount(sepA, pic.accountId, { role: "SEP", parokiId: null }, STEP))).toBe(403);
    expect(row(pic.accountId).fields[A.peran]).toBe("PIC Paroki");
    row(pic.accountId).fields[A.idGoogle] = "g-sub-1";
    deny();
    expect(await status(clearGoogleBinding(sepA, pic.accountId, STEP))).toBe(403);
    expect(row(pic.accountId).fields[A.idGoogle]).toBe("g-sub-1");
    deny();
    expect(await status(resetMfa(sepA, pic.accountId, STEP))).toBe(403);
    vi.mocked(reauthenticate).mockClear();
    await createAccount(sepA, input, STEP);
    expect(reauthenticate).not.toHaveBeenCalled();
    await createAccount(sepA, { ...input, email: "s@paroki.id", role: "SEP", parokiId: null }, STEP);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
  });

  it("emails are trimmed and lower-cased on create; a concurrent duplicate is deactivated and reported 409", async () => {
    const real = vi.mocked(airtable.createRecords).getMockImplementation()!;
    vi.mocked(airtable.createRecords).mockImplementationOnce(async (table, rows, extra) => {
      // a rival create slips in between the pre-check and our insert
      store[T.akunKep].push({ id: "recRIVAL000000001", fields: { [A.email]: "baru@paroki.id", [A.peran]: "SEP", [A.statusAktif]: true } });
      return real(table, rows, extra);
    });
    expect(await status(createAccount(sepA, { ...input, email: "  BARU@Paroki.ID " }, STEP))).toBe(409);
    const mine = store[T.akunKep].filter((r) => r.fields[A.email] === "baru@paroki.id" && r.id !== "recRIVAL000000001");
    expect(mine).toHaveLength(1);
    expect(mine[0].fields[A.statusAktif]).toBe(false); // deactivated, never deleted
    expect(sent).toHaveLength(0);
  });

  it("an Airtable outage while checking the paroki is 503, not 422", async () => {
    vi.mocked(airtable.getRecord).mockRejectedValueOnce(new Error("Airtable request failed: HTTP 500"));
    expect(await status(createAccount(sepA, input, STEP))).toBe(503);
    vi.mocked(airtable.getRecord).mockRejectedValueOnce(new Error("Airtable request failed: HTTP 404"));
    expect(await status(createAccount(sepA, input, STEP))).toBe(422);
  });

  it("SEPs that never set a password do not count as another active SEP", async () => {
    await deactivateAccount(sepA, sepB.accountId);
    await createAccount(sepA, { ...input, email: "newsep@paroki.id", role: "SEP", parokiId: null }, STEP); // no password yet
    expect(await status(deactivateAccount(sepA, sepA.accountId))).toBe(409);
    expect(await status(changeAccount(sepA, sepA.accountId, { role: "PIC", parokiId: PA }, STEP))).toBe(409);
  });
});

describe("SEP account administration", () => {
  const cookieFor = async (s: Session) => `${SESSION_COOKIE}=${await issueSession(s, { amr: ["pwd", "otp"] })}`;

  it("non-SEP is refused for every admin action", async () => {
    expect(await status(deactivateAccount(pic, sepA.accountId))).toBe(403);
    expect(await status(reactivateAccount(pic, sepA.accountId))).toBe(403);
    expect(await status(changeAccount(pic, pic.accountId, { role: "SEP", parokiId: null }, STEP))).toBe(403);
    expect(await status(clearGoogleBinding(pic, sepA.accountId, STEP))).toBe(403);
    expect(await status(resetMfa(pic, sepA.accountId, STEP))).toBe(403);
  });

  it("deactivate revokes sessions and audits; reactivate re-invites with a fresh password", async () => {
    const c = await cookieFor(pic);
    expect(await readSession(c)).not.toBeNull();
    await deactivateAccount(sepA, pic.accountId);
    expect(row(pic.accountId).fields[A.statusAktif]).toBe(false);
    expect(await readSession(c)).toBeNull();
    expect(audits().some((a) => a.fields[F.auditKep.aksi] === "akun_nonaktif" && a.fields[F.auditKep.pelaku] === sepA.email)).toBe(true);
    await reactivateAccount(sepA, pic.accountId);
    expect(row(pic.accountId).fields[A.statusAktif]).toBe(true);
    // Reactivation clears the password and re-invites, so tokens from before can never revive.
    expect(String(row(pic.accountId).fields[A.hashPassword])).toMatch(/^unset:/);
    expect(await readSession(c)).toBeNull();
    await flushBackground();
    expect(sent.at(-1)).toMatchObject({ to: pic.email, template: "invite" });
  });

  it("unknown account id is 404", async () => {
    expect(await status(deactivateAccount(sepA, "recNOPE000000001"))).toBe(404);
    expect(await status(deactivateAccount(sepA, "not-an-id"))).toBe(404);
  });

  it("the last active SEP can be neither deactivated nor demoted", async () => {
    await deactivateAccount(sepA, sepB.accountId); // sepA remains
    expect(await status(deactivateAccount(sepA, sepA.accountId))).toBe(409);
    expect(await status(changeAccount(sepA, sepA.accountId, { role: "PIC", parokiId: PA }))).toBe(409);
    expect(row(sepA.accountId).fields[A.statusAktif]).toBe(true);
    // with a second active SEP the same actions are fine
    await reactivateAccount(sepA, sepB.accountId);
    await deactivateAccount(sepB, sepA.accountId);
    expect(row(sepA.accountId).fields[A.statusAktif]).toBe(false);
  });

  it("role/parish change validates like create and invalidates existing sessions", async () => {
    expect(await status(changeAccount(sepA, pic.accountId, { role: "PIC", parokiId: null }))).toBe(422);
    const c = await cookieFor(pic);
    await changeAccount(sepA, pic.accountId, { role: "ADMIN", parokiId: PA });
    expect(row(pic.accountId).fields[A.peran]).toBe("Admin Paroki");
    expect(await readSession(c)).toBeNull();
    const a = audits().find((x) => x.fields[F.auditKep.aksi] === "akun_ubah")!;
    expect(String(a.fields[F.auditKep.sebelum])).toContain("PIC");
    expect(String(a.fields[F.auditKep.sesudah])).toContain("ADMIN");
  });

  it("promoting to SEP clears the paroki link", async () => {
    await changeAccount(sepA, pic.accountId, { role: "SEP", parokiId: null }, STEP);
    expect(row(pic.accountId).fields[A.paroki]).toEqual([]);
    expect(row(pic.accountId).fields[A.peran]).toBe("SEP");
  });

  it("clearing a Google binding audits (no full sub) and revokes sessions", async () => {
    row(pic.accountId).fields[A.idGoogle] = "google-sub-abcdef1234";
    const c = await cookieFor(pic);
    await clearGoogleBinding(sepA, pic.accountId, STEP);
    expect(row(pic.accountId).fields[A.idGoogle]).toBeUndefined();
    expect(await readSession(c)).toBeNull();
    const a = audits().find((x) => x.fields[F.auditKep.aksi] === "google_unbind")!;
    expect(JSON.stringify(a.fields)).not.toContain("google-sub-abcdef1234");
    expect(String(a.fields[F.auditKep.sebelum])).toContain("1234");
    expect(await status(clearGoogleBinding(sepA, sepB.accountId, STEP))).toBe(409); // nothing bound
  });

  it("MFA reset clears secret and step, audits and revokes sessions", async () => {
    const { generateTotpSecret } = await import("@/lib/auth/totp");
    await seedAccount({ id: "recMFA0000000001", email: "mfa@x.id", peran: "PIC Paroki", mfaSecret: generateTotpSecret(), fields: { [A.paroki]: [PA], [A.langkahTotpTerakhir]: 5 } });
    const c = await cookieFor({ accountId: "recMFA0000000001", email: "mfa@x.id", role: "PIC", parokiId: PA });
    await resetMfa(sepA, "recMFA0000000001", STEP);
    expect(row("recMFA0000000001").fields[A.rahasiaMfa]).toBeUndefined();
    expect(row("recMFA0000000001").fields[A.langkahTotpTerakhir]).toBeUndefined();
    expect(await readSession(c)).toBeNull();
    expect(audits().some((a) => a.fields[F.auditKep.aksi] === "mfa_reset")).toBe(true);
  });

  it("an audit failure aborts the action (never an unaudited change)", async () => {
    const { createRecords } = await import("@/lib/airtable/client");
    vi.mocked(createRecords).mockRejectedValueOnce(new Error("audit down"));
    await expect(deactivateAccount(sepA, pic.accountId)).rejects.toThrow();
    expect(row(pic.accountId).fields[A.statusAktif]).toBe(true);
  });
});
