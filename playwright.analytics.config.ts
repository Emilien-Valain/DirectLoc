import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * Suite PostHog (e2e/analytics/) : seul serveur de test lancé AVEC une clé, pour
 * que le bandeau de consentement n'interfère pas avec la suite principale.
 * Les événements serveur partent vers un faux PostHog local (port 3998) ;
 * ceux du navigateur sont interceptés par page.route.
 */
const webServer = base.webServer as NonNullable<Exclude<typeof base.webServer, unknown[]>>;

export default defineConfig({
  ...base,
  projects: [
    {
      name: "analytics",
      testMatch: ["**/analytics/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    ...webServer,
    env: { ...webServer.env, POSTHOG_KEY: "phc_test", POSTHOG_HOST: "http://localhost:3998" },
  },
});
