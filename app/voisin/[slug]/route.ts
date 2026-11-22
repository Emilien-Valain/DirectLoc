import { type NextRequest, NextResponse } from "next/server";
import { getVoisinTarget, recordReferral } from "@/lib/network";
import { parisToday } from "@/lib/date-windows";
import { isStayTooLong, isUuid, MAX_PARTY } from "@/lib/validation";

const notFound = () => new NextResponse("Not Found", { status: 404 });

const isoDate = (v: string | null): v is string =>
  !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().startsWith(v);
const count = (v: string | null, min: number) => (v !== null && /^\d{1,3}$/.test(v) && Number(v) >= min ? Number(v) : null);

/**
 * GET /voisin/<slug>?checkIn&checkOut&adults&minors[&kind=shared&dossier=<id>] — le Renvoi (Réseau des Voisins, ADR-0013).
 * Enregistre le clic (aucune donnée voyageur) puis redirige vers le site du Voisin, recherche
 * pré-remplie, `via=<slug de l'hôtel d'origine>`. Slug inconnu, Voisin hors réseau ou paramètres
 * invalides : 404, jamais 500. L'hôtel d'origine vient du proxy (x-tenant-id), jamais du client.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const originId = request.headers.get("x-tenant-id");
  const sp = request.nextUrl.searchParams;
  const checkIn = sp.get("checkIn");
  const checkOut = sp.get("checkOut");
  const adults = count(sp.get("adults"), 1);
  const kindRaw = sp.get("kind");
  const minors = sp.get("minors") === null ? 0 : count(sp.get("minors"), 0);

  // Seuls « full » (défaut) et « shared » existent ; toute autre valeur est refusée.
  if (kindRaw !== null && kindRaw !== "shared" && kindRaw !== "full") return notFound();
  const kind = kindRaw === "shared" ? "shared" : "full";
  if (!originId || !isUuid(originId) || !/^[a-z0-9-]{1,63}$/.test(slug)) return notFound();
  if (!isoDate(checkIn) || !isoDate(checkOut) || checkOut <= checkIn || checkIn < parisToday()) return notFound();
  if (adults === null || minors === null || adults + minors > MAX_PARTY) return notFound();
  const from = new Date(checkIn + "T00:00:00Z");
  const to = new Date(checkOut + "T00:00:00Z");
  if (isStayTooLong(from, to)) return notFound();

  const hit = await getVoisinTarget(originId, slug);
  if (!hit) return notFound();

  await recordReferral({
    fromTenantId: hit.origin.id,
    toTenantId: hit.target.id,
    checkIn: from,
    checkOut: to,
    guestCount: adults + minors,
    kind,
    // Partage : le Dossier de l'hôte qui envoie (lien de sa page de confirmation), revérifié.
    fromDossierId: kind === "shared" ? sp.get("dossier") : null,
  });

  // Dev/test : les sous-domaines <slug>.localhost remplacent les domaines (même logique que le proxy).
  const hostHeader = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? request.headers.get("host") ?? "";
  const [host, port] = hostHeader.split(":");
  const base =
    host === "localhost" || host.endsWith(".localhost")
      ? `${request.nextUrl.protocol}//${hit.target.slug}.localhost${port ? `:${port}` : ""}`
      : `https://${hit.target.domain}`;
  const q = new URLSearchParams({ checkIn, checkOut, adults: String(adults), minors: String(minors), via: hit.origin.slug });
  return NextResponse.redirect(`${base}/?${q}#dates`, 302);
}
