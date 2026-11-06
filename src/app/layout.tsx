import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// Dinamis agar nonce CSP per-request diterapkan pada skrip Next.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "KEP Keuskupan Bandung" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
