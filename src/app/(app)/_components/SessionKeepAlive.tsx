"use client";

import { useEffect } from "react";

export const PING_URL = "/api/sesi/ping";
export const PING_EVERY_MS = 5 * 60_000;
export const ACTIVE_WINDOW_MS = 5 * 60_000;

/**
 * Keeps the 15-minute sliding session alive while someone is actually working on a server-rendered page: every
 * 5 minutes, only when the tab is visible and there was pointer/keyboard activity in the last 5 minutes, it calls
 * GET /api/sesi/ping (which renews the cookie, never beyond the 8 h cap). A 401 stops it and sends the user to
 * /login with a message. Idle or hidden tabs do not ping, so an unattended screen still logs out after 15 minutes.
 */
export function startKeepAlive(w: Window & typeof globalThis, opts: { every?: number; active?: number } = {}): () => void {
  const every = opts.every ?? PING_EVERY_MS;
  const active = opts.active ?? ACTIVE_WINDOW_MS;
  let lastActivity = Date.now();
  let stopped = false;
  const mark = () => (lastActivity = Date.now());
  const events = ["pointerdown", "keydown"] as const;
  for (const e of events) w.addEventListener(e, mark, { passive: true });
  const tick = async () => {
    if (stopped || w.document.visibilityState !== "visible" || Date.now() - lastActivity > active) return;
    try {
      const res = await w.fetch(PING_URL, { method: "GET", credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        stop();
        w.location.replace("/login?sesi=habis");
      }
    } catch {
      /* offline: try again next time */
    }
  };
  const timer = w.setInterval(() => void tick(), every);
  function stop() {
    stopped = true;
    w.clearInterval(timer);
    for (const e of events) w.removeEventListener(e, mark);
  }
  return stop;
}

export default function SessionKeepAlive() {
  useEffect(() => startKeepAlive(window), []);
  return null;
}
