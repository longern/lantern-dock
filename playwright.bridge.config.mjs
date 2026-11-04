import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/integration",
  testMatch: "*.spec.mjs",
  outputDir: "test-results/bridge",
  workers: 1,
  timeout: 60000,
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "bridge-desktop",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "bridge-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
