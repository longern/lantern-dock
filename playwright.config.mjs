import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  outputDir: "test-results/browser",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:8788",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 8788",
    url: "http://127.0.0.1:8788/api/config",
    reuseExistingServer: !process.env.CI,
    env: { DEMO_MODE: "true" },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "narrow",
      use: {
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
