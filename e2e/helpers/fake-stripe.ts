import http from "http";

/**
 * Faux Stripe local : le webServer E2E envoie l'API Stripe vers STRIPE_API_BASE
 * (http://localhost:3995, voir playwright.config.ts et lib/stripe.ts). Sans ce serveur, la
 * connexion est refusée = « paiement momentanément indisponible » (comportement des autres specs).
 *
 * Simulé : création de session Checkout (v1, corps x-www-form-urlencoded) — on garde chaque
 * requête pour vérifier les line items et montants, et on renvoie une session dont l'url est le
 * success_url demandé (le navigateur atterrit sur la page de confirmation). Onboarding Connect
 * en Accounts v2 (corps JSON) : `POST /v2/core/accounts`, `POST /v2/core/account_links`,
 * `GET /v2/core/accounts/:id` (statut de `card_payments` réglable via `capabilityStatus`).
 */

export type CheckoutRequest = {
  sessionId: string;
  /** Corps x-www-form-urlencoded décodé : `line_items[0][price_data][unit_amount]` → "12000". */
  params: Record<string, string>;
  stripeAccount?: string;
};

export type V2Request = {
  /** Corps JSON envoyé par le SDK. */
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
};

export type FakeStripe = {
  sessions: CheckoutRequest[];
  /** `POST /v2/core/accounts` reçus. */
  accountCreates: V2Request[];
  /** `POST /v2/core/account_links` reçus. */
  accountLinks: V2Request[];
  /** `GET /v2/core/accounts/:id` reçus (url complète, avec `include`). */
  accountRetrieves: string[];
  /** Statut renvoyé pour `configuration.merchant.capabilities.card_payments` (défaut : pending). */
  capabilityStatus: Record<string, "active" | "pending" | "restricted">;
  /** true : `POST /v2/core/accounts` refusé (400), comme un rejet Stripe. */
  rejectAccountCreate: boolean;
  /** Line items de la session : nom, montant unitaire en centimes, quantité. */
  lineItems(s: CheckoutRequest): { name: string; unitAmount: number; quantity: number }[];
  close(): Promise<void>;
};

export async function startFakeStripe(port = 3995): Promise<FakeStripe> {
  const sessions: CheckoutRequest[] = [];
  const accountCreates: V2Request[] = [];
  const accountLinks: V2Request[] = [];
  const accountRetrieves: string[] = [];
  const capabilityStatus: FakeStripe["capabilityStatus"] = {};
  let n = 0;
  const json = (res: http.ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const v2Account = (id: string) => {
    const status = capabilityStatus[id] ?? "pending";
    return {
      id,
      object: "v2.core.account",
      dashboard: "full",
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { status, status_details: [] },
            stripe_balance: { payouts: { status, status_details: [] } },
          },
        },
      },
    };
  };
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
      const url = req.url ?? "";
      if (url.startsWith("/v2/")) {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(body || "{}");
        } catch {
          return json(res, 400, { error: { type: "invalid_request_error", message: "JSON invalide" } });
        }
        if (req.method === "POST" && url === "/v2/core/accounts") {
          accountCreates.push({ body: data, headers: req.headers });
          if (fake.rejectAccountCreate) {
            return json(res, 400, { error: { type: "invalid_request_error", code: "fake_rejected", message: "Refus simulé" } });
          }
          return json(res, 200, v2Account(`acct_fake_${Date.now()}_${++n}`));
        }
        if (req.method === "POST" && url === "/v2/core/account_links") {
          accountLinks.push({ body: data, headers: req.headers });
          return json(res, 200, {
            object: "v2.core.account_link",
            account: data.account,
            url: `http://localhost:${port}/onboarding/${String(data.account)}`,
          });
        }
        const m = req.method === "GET" && url.match(/^\/v2\/core\/accounts\/([^/?]+)/);
        if (m) {
          accountRetrieves.push(url);
          return json(res, 200, v2Account(decodeURIComponent(m[1])));
        }
      }
      if (req.method === "GET" && url.startsWith("/onboarding/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Onboarding Stripe (faux)</title><h1>Onboarding Stripe (faux)</h1>");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Non simulé" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const fake: FakeStripe = {
    rejectAccountCreate: false,
    sessions,
    accountCreates,
    accountLinks,
    accountRetrieves,
    capabilityStatus,
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
  return fake;
}
