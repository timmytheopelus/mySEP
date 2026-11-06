import { defineConfig } from "@playwright/test";

import { MOCK_PORT, SESSION_SECRET } from "./tests/e2e/e2e-data";
// Optional: use a preinstalled browser (sandbox/CI) instead of the one Playwright downloads.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 390, height: 844 },
    ...(channel ? { channel } : {}),
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: [
    // Fake Airtable: e2e never touches the real base.
    {
      command: "node tests/e2e/mock-airtable.ts",
      url: `http://127.0.0.1:${MOCK_PORT}/tblx`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_AIRTABLE_PORT: String(MOCK_PORT) },
    },
    {
      command: "pnpm build && pnpm start",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        // Production build against the local fake Airtable: KEP_E2E_MODE=1 allows ONLY the API URL override, the
        // in-memory limiter and http://localhost (src/lib/config/prodEnv.ts); it is ignored on Vercel.
        KEP_E2E_MODE: "1",
        MFA_ENC_KEY: "ZTJlLW1mYS1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyE=",
        AIRTABLE_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
        AIRTABLE_TOKEN: "e2e-token",
        AIRTABLE_BASE_ID: "appE2E",
        SESSION_SECRET,
        ABSEN_RECHECK_MS: "10",
        REG_TOKEN_SECRET: "e2e-registration-token-secret-0123456789",
        APP_BASE_URL: "http://localhost:3000",
      },
    },
  ],
});
