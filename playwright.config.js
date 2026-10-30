import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server/index.js",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    env: {
      PORT: "3100",
      HOST: "127.0.0.1",
      DATABASE_PATH: "test-results/browser.sqlite",
      NODE_ENV: "development",
      APP_PASSWORD: "",
      MEETSTREAM_API_KEY: "",
      PUBLIC_ORIGIN: "",
      GOOGLE_TRANSLATE_API_KEY: "",
      AZURE_TRANSLATOR_KEY: "",
      SLACK_BOT_TOKEN: "",
      GOOGLE_DRIVE_REFRESH_TOKEN: "",
    },
  },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
});
