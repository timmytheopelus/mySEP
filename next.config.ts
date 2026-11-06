import type { NextConfig } from "next";

// Content-Security-Policy memakai nonce per-request, jadi diset di src/proxy.ts
// (lihat src/lib/csp.ts). Header statis lain diset di sini.
// Build id inlined into the client; versions the service-worker cache (old caches are pruned on activate).
const BUILD_ID = process.env.BUILD_ID ?? Date.now().toString(36);

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        // Health data of the participants: never stored by a browser, proxy or CDN.
        source: "/kep/:id/kesehatan",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        // The service worker must always be revalidated so updates reach installed copies.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, max-age=0" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
