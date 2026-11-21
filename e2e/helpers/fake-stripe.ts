import http from "http";

/**
 * Faux Stripe local : le webServer E2E envoie l'API Stripe vers STRIPE_API_BASE
 * (http://localhost:3995, voir playwright.config.ts et lib/stripe.ts). Sans ce serveur, la
 * connexion est refusée = « paiement momentanément indisponible » (comportement des autres specs).
 *
 * Seule la création de session Checkout est simulée : on garde chaque requête (corps décodé)
 * pour vérifier les line items et montants, et on renvoie une session dont l'url est le
 * success_url demandé (le navigateur atterrit sur la page de confirmation).
 */

export type CheckoutRequest = {
  sessionId: string;
  /** Corps x-www-form-urlencoded décodé : `line_items[0][price_data][unit_amount]` → "12000". */
  params: Record<string, string>;
  stripeAccount?: string;
};

export type FakeStripe = {
  sessions: CheckoutRequest[];
  /** Line items de la session : nom, montant unitaire en centimes, quantité. */
  lineItems(s: CheckoutRequest): { name: string; unitAmount: number; quantity: number }[];
  close(): Promise<void>;
};

export async function startFakeStripe(port = 3995): Promise<FakeStripe> {
  const sessions: CheckoutRequest[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/v1/checkout/sessions")) {
        const params = Object.fromEntries(new URLSearchParams(body));
        const sessionId = `cs_test_fake_${Date.now()}_${++n}`;
        sessions.push({ sessionId, params, stripeAccount: req.headers["stripe-account"] as string | undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: sessionId,
            object: "checkout.session",
            url: (params.success_url ?? "").replace("{CHECKOUT_SESSION_ID}", sessionId),
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Non simulé" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    sessions,
    lineItems(s) {
      const out: { name: string; unitAmount: number; quantity: number }[] = [];
      for (let i = 0; s.params[`line_items[${i}][quantity]`] !== undefined; i++) {
        out.push({
          name: s.params[`line_items[${i}][price_data][product_data][name]`],
          unitAmount: Number(s.params[`line_items[${i}][price_data][unit_amount]`]),
          quantity: Number(s.params[`line_items[${i}][quantity]`]),
        });
      }
      return out;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
