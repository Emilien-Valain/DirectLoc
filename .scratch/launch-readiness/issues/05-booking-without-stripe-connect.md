# Tenant sans Stripe Connect encaisse sur le compte plateforme

Status: needs-info

`lib/actions/bookings-public.ts:187` : sans `stripeAccountId`, la session Checkout est créée sur le compte plateforme → l'argent du voyageur arrive chez l'opérateur.

## Question

Voulu (ton propre hôtel, sans Connect) ou à bloquer (réservation en ligne refusée tant que l'hôtel n'est pas connecté / `charges_enabled`) ?

## Comments
