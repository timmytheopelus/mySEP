import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";
import { reportProductionConfig } from "@/lib/config/prodEnv";

export function proxy(request: NextRequest) {
  // Production with missing/invalid secrets or without the shared store (Upstash): refuse every request instead of
  // running with a per-process limiter/denylist or a redirected Airtable URL. Names are logged once, never values.
  if (reportProductionConfig().length > 0) {
    return new NextResponse("Layanan belum dikonfigurasi dengan benar. Hubungi pengelola aplikasi.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
    });
  }
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
