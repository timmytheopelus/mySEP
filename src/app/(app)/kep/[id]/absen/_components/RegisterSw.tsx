"use client";
import { useEffect } from "react";

/** Registers the app-shell service worker (same-origin file; allowed by CSP worker-src 'self'). */
export default function RegisterSw() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* optional enhancement: the page works without it */
    });
  }, []);
  return null;
}
