export function buildCsp(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${isDev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    // data: is needed for the server-rendered TOTP QR code (PNG data URI); no other directive allows it.
    "img-src 'self' data: blob: https://i.ytimg.com",
    "font-src 'self'",
    // Explicit: with 'strict-dynamic' in script-src a worker would otherwise inherit a policy that ignores 'self'.
    "worker-src 'self'",
    "manifest-src 'self'",
    "connect-src 'self'",
    "frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ];
  return directives.join("; ");
}
