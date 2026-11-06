import type { BrowserContext } from "@playwright/test";
import { SignJWT } from "jose";
import { ACC, SESSION_SECRET, sessionClaims } from "./e2e-data";

export type Who = keyof typeof ACC;

/** Puts a valid session cookie for a seeded account into the browser context (no login form). */
export async function login(context: BrowserContext, who: Who) {
  const a = ACC[who];
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sa: now, amr: ["pwd", "otp"], ...sessionClaims(a) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("kep")
    .setAudience("kep-session")
    .setSubject(a.id)
    .setJti(`e2e-${who}-${now}-${Math.random().toString(36).slice(2)}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SESSION_SECRET));
  await context.addCookies([{ name: "__Host-kep_session", value: token, domain: "localhost", path: "/", secure: true, httpOnly: true }]);
}
