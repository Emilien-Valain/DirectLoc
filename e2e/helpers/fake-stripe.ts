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
 * Remboursements : `POST /v1/refunds` (en-tête Stripe-Account, Idempotency-Key et corps gardés ;
 * statut renvoyé `refundStatus`, refus simulé `refundError` ; une clé rejouée renvoie le même Refund).
 * Litiges : `POST /v1/disputes/:id` (preuves, `submit`) et `POST /v1/disputes/:id/close` (corps et
 * en-tête Stripe-Account gardés dans `disputes` ; refus simulé `disputeError`).
 */

export type DisputeRequest = {
  id: string;
  action: "update" | "close";
  /** Corps décodé : `evidence[product_description]`, `submit`… */
  params: Record<string, string>;
  stripeAccount?: string;
};

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

export type RefundRequest = {
  /** Corps décodé : `payment_intent`, `amount` (centimes), `metadata[dossierId]`… */
  params: Record<string, string>;
  stripeAccount?: string;
  idempotencyKey?: string;
  /** Id du Refund renvoyé (absent si refusé). */
  refundId?: string;
};

export type FakeStripe = {
  /** `POST /v1/disputes/:id` et `/close` reçus. */
  disputes: DisputeRequest[];
  /** Non null : appels litige refusés avec ce code HTTP et ce message. */
  disputeError: { status: number; message: string } | null;
  /** `POST /v1/refunds` reçus (rejeux compris). */
  refunds: RefundRequest[];
  /** Statut des Refunds créés (défaut : succeeded). */
  refundStatus: "succeeded" | "pending" | "failed";
  /** Réponse de `GET /v1/refunds` (liste des Refunds d'un payment_intent, relue pour `charge.refunded`). */
  listedRefunds: unknown[];
  /** `GET /v1/refunds` reçus : url et compte connecté. */
  refundLists: { url: string; stripeAccount?: string }[];
  /** Non null : `POST /v1/refunds` refusé avec ce code HTTP et ce message (402 = carte, 500 = panne). */
  refundError: { status: number; message: string } | null;
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
  const refunds: RefundRequest[] = [];
  const refundByKey = new Map<string, unknown>();
  const refundLists: { url: string; stripeAccount?: string }[] = [];
  const disputes: DisputeRequest[] = [];
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
      const dm = req.method === "POST" && url.match(/^\/v1\/disputes\/([^/?]+)(\/close)?$/);
      if (dm) {
        const params = Object.fromEntries(new URLSearchParams(body));
        const id = decodeURIComponent(dm[1]);
        const action = dm[2] ? "close" : "update";
        disputes.push({ id, action, params, stripeAccount: req.headers["stripe-account"] as string | undefined });
        if (fake.disputeError) {
          const { status, message } = fake.disputeError;
          return json(res, status, {
            error: { type: status >= 500 ? "api_error" : "invalid_request_error", code: "fake_dispute_refused", message },
          });
        }
        const submitted = params.submit === "true";
        return json(res, 200, {
          id,
          object: "dispute",
          currency: "eur",
          status: action === "close" ? "lost" : submitted ? "under_review" : "needs_response",
          evidence: Object.fromEntries(
            Object.entries(params)
              .filter(([k]) => k.startsWith("evidence["))
              .map(([k, v]) => [k.slice(9, -1), v]),
          ),
          evidence_details: { submission_count: submitted ? 1 : 0, has_evidence: true, past_due: false, due_by: null },
        });
      }
      if (req.method === "GET" && url.startsWith("/v1/refunds")) {
        refundLists.push({ url, stripeAccount: req.headers["stripe-account"] as string | undefined });
        return json(res, 200, { object: "list", data: fake.listedRefunds, has_more: false, url: "/v1/refunds" });
      }
      if (req.method === "POST" && url.startsWith("/v1/refunds")) {
        const params = Object.fromEntries(new URLSearchParams(body));
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        const rec: RefundRequest = { params, stripeAccount: req.headers["stripe-account"] as string | undefined, idempotencyKey };
        refunds.push(rec);
        if (idempotencyKey && refundByKey.has(idempotencyKey)) return json(res, 200, refundByKey.get(idempotencyKey));
        if (fake.refundError) {
          const { status, message } = fake.refundError;
          return json(res, status, {
            error: { type: status >= 500 ? "api_error" : "invalid_request_error", code: "fake_refund_refused", message },
          });
        }
        const refund = {
          id: `re_fake_${Date.now()}_${++n}`,
          object: "refund",
          amount: Number(params.amount),
          currency: "eur",
          payment_intent: params.payment_intent,
          status: fake.refundStatus,
          failure_reason: fake.refundStatus === "failed" ? "expired_or_canceled_card" : null,
          metadata: Object.fromEntries(
            Object.entries(params)
              .filter(([k]) => k.startsWith("metadata["))
              .map(([k, v]) => [k.slice(9, -1), v]),
          ),
        };
        rec.refundId = refund.id;
        if (idempotencyKey) refundByKey.set(idempotencyKey, refund);
        return json(res, 200, refund);
      }
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
    disputes,
    disputeError: null,
    refunds,
    refundStatus: "succeeded",
    refundError: null,
    listedRefunds: [],
    refundLists,
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
