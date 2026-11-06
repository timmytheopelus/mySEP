"use client";
import { useEffect } from "react";

/** Registers the app-shell service worker (same-origin file; allowed by CSP worker-src 'self'). */
export default function RegisterSw() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID ?? "0"}`, { scope: "/" }).catch(() => {
      /* optional enhancement: the page works without it */
    });
  }, []);
  return null;
}
