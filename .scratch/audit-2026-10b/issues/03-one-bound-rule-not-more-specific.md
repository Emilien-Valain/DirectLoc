# A rule with only one date bound never beats an all-year rule

Status: resolved — Number.MAX_VALUE au lieu de Infinity / 2
Group: Should fix

## Problem

`lib/rule-precedence.ts:54` returns `Infinity / 2` for a rule with only `validFrom` or only `validTo`, meaning "more specific than all-year". But `Infinity / 2 === Infinity`, so it ties with an all-year rule and precedence falls through to recency (newest wins).

Failure case: a global "Été" rule (validFrom = June 1, no end, +20%, priority 0) created first, then a global "Promo" (all year, -10%, priority 0) created later. Summer nights get -10% instead of +20%. The same bug affects booking rules (shared primitive).

## Fix

`return Number.MAX_VALUE;` instead of `Infinity / 2`. A finite value smaller than `Infinity`, larger than any real window.

## Acceptance

- New case in `e2e/admin/rule-resolution.spec.ts`: an older one-bound rule beats a newer all-year rule at the same priority (pricing). Fails on the old code, passes on the new one.
- Obsidian spec updated.

## Comments

- `lib/rule-precedence.ts` : une seule borne → `Number.MAX_VALUE`.
- Test : `e2e/admin/rule-resolution.spec.ts` « une règle à une seule borne (plus ancienne) bat une toute-l'année plus récente » (Été +20 % créé avant Promo −10 % → 120 €).
- Vérifié par mutation : avec `Infinity / 2` le test échoue (90 €), passe avec le fix.
- Obsidian : section « Résolution des règles ».
