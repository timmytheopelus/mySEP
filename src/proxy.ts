import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

export function proxy(request: NextRequest) {
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
