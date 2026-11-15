import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { isDemoTenant } from "@/lib/demo";

// Domaine de l'hôtel démo : chaque visite ouvre sa propre session admin (2 h) puis va sur /admin.
// Le domaine vitrine redirige ici depuis proxy.ts ; tout autre tenant → 404.
export async function GET() {
  const h = await headers();
  const tenantId = h.get("x-tenant-id");
  if (!tenantId || !(await isDemoTenant(tenantId))) {
    return new Response("Not Found", { status: 404 });
  }

  const { headers: authHeaders } = await auth.api
    .demoSignIn({ headers: h, returnHeaders: true })
    .catch(() => ({ headers: null })); // compte démo absent (seed pas encore passé)
  if (!authHeaders) return new Response("Not Found", { status: 404 });

  const res = new Response(null, { status: 302, headers: { Location: "/admin", "Cache-Control": "no-store" } });
  for (const cookie of authHeaders.getSetCookie()) res.headers.append("Set-Cookie", cookie);
  return res;
}
