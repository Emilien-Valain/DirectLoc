import type { MetadataRoute } from "next";
import { headers } from "next/headers";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const headersList = await headers();
  const host = headersList.get("host") ?? "localhost";
  const proto = headersList.get("x-forwarded-proto") ?? "https";
  const baseUrl = `${proto}://${host}`;

  return {
    rules: {
      userAgent: "*",
      // Photos servies par /api/uploads : à laisser lisibles (Google Images, aperçus, JSON-LD).
      allow: ["/", "/api/uploads/"],
      // /essayer ouvre une session démo à chaque passage : les robots gonflaient demo_opened.
      disallow: ["/admin/", "/api/", "/login", "/essayer"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
