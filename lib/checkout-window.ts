/** Durée de vie d'une session Checkout : passé ce délai sans paiement, le webhook `expired` annule la réservation. */
export const CHECKOUT_TTL_MINUTES = 30;

/** Heure limite d'une session Checkout encore ouverte, sinon null (paiement absent, abouti ou expiré). */
export function openCheckoutDeadline(
  payment: { status: string; createdAt: Date | null } | undefined,
  now = new Date(),
): Date | null {
  if (payment?.status !== "pending" || !payment.createdAt) return null;
  const deadline = new Date(new Date(payment.createdAt).getTime() + CHECKOUT_TTL_MINUTES * 60_000);
  return deadline > now ? deadline : null;
}
