import "server-only";
import type { ZodError } from "zod";
import { json } from "@/lib/http/auth-http";

/** 422 with one static Indonesian message per field. Never echoes submitted values (health data is in there). */
export function validationError(err: ZodError): Response {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const key = i.path.map(String).join(".") || "_";
    if (!(key in fields)) fields[key] = i.message;
  }
  return json({ error: "Data tidak valid. Periksa isian yang ditandai.", fields }, 422);
}

export const DEFAULT_FLOOR_MS = 6000;
/** REG_MIN_RESPONSE_MS -> ms; empty, garbage, zero or negative fall back to the default. */
export function responseFloorMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_MS;
}

/** Same body for an invalid token, an unknown event and a KEP that is not (or no longer) open. */
export const notAvailable = () => json({ error: "Pendaftaran tidak tersedia" }, 404);
