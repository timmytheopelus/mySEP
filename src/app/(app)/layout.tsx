import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { readSession } from "@/lib/auth/session";
import AppNav from "./_components/AppNav";
import SessionKeepAlive from "./_components/SessionKeepAlive";

export const metadata: Metadata = { manifest: "/manifest.webmanifest" };

/** Menu utama untuk pengguna yang sudah masuk; halaman masuk / lupa password tetap polos. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await readSession((await cookies()).toString()).catch(() => null);
  return (
    <>
      {session ? <AppNav sep={session.role === "SEP"} owner={session.accountId} /> : null}
      {session ? <SessionKeepAlive /> : null}
      {children}
    </>
  );
}
