import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Bundlé par Turbopack, node-ical (temporal-polyfill) plante : « e.BigInt is not a function ».
  // Bundlé en dev, le scrypt JS de @noble/hashes (mots de passe Better Auth) est ~13x plus lent :
  // une connexion prenait ~4,5 s (tests de login au bord du timeout).
  serverExternalPackages: ["node-ical", "@noble/hashes"],
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        {
          key: "X-Frame-Options",
          value: "DENY",
        },
        {
          key: "X-Content-Type-Options",
          value: "nosniff",
        },
        {
          key: "Referrer-Policy",
          value: "strict-origin-when-cross-origin",
        },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            // PostHog (Cloud UE) : scripts distants (config, recorder) + envois ; worker blob: pour le replay.
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://eu-assets.i.posthog.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob: https://tile.openstreetmap.org",
            "connect-src 'self' https://api.stripe.com https://eu.i.posthog.com https://eu-assets.i.posthog.com",
            "worker-src 'self' blob:",
            "frame-src https://js.stripe.com https://hooks.stripe.com https://www.openstreetmap.org",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join("; "),
        },
      ],
    },
  ],
};

export default nextConfig;
