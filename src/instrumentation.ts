import { reportProductionConfig } from "@/lib/config/prodEnv";

/** Server start: log missing/invalid production settings (names only). src/proxy.ts then answers 503. */
export function register(): void {
  reportProductionConfig();
}
