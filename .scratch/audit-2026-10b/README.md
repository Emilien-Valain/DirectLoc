# Audit 2026-10 (b): Must fix, Should fix, Nice to have

Source: second `/ponytail-audit` run on 2026-10-24 (whole repo, after the fixes from `.scratch/audit-2026-10/`). Assumed load: one Docker instance, tens of tenants, a few rooms each, public internet.

Each issue is self-contained. Work them in number order: 01–02 are **Must fix**, 03–09 are **Should fix**, 10 is **Nice to have**.

## Rules for every agent (from CLAUDE.md)
- Read `AGENTS.md`: Next.js 16 differs from your training data. Check `node_modules/next/dist/docs/` before touching routing or actions.
- Add or update Playwright tests in `/e2e/`: the happy path plus one case that tries to break it. Tests must clean up their data.
- Update the Obsidian spec `Tests de non-régression.md` for any behaviour change (real vault path: see memory `obsidian-vault-path`).
- Stop any running `next dev` on :3000 before `npm test`, because Playwright starts its own server.
- Make the smallest fix that works. No new layers or dependencies.
- When done: set `Status: resolved — <one line>` at the top and append notes under `## Comments`.
- `ready-for-human` issues: do NOT implement them. Leave them as they are.

## Index
| # | Group | Status | Issue |
|---|-------|--------|-------|
| 01 | Must | implemented (needs test-mode check) | `issues/01-stripe-fees-on-platform.md`: the platform may pay the Stripe fees |
| 02 | Must | resolved | `issues/02-public-booking-form-no-rate-limit.md`: a bot can hold every room, OTAs included |
| 03 | Should | resolved | `issues/03-one-bound-rule-not-more-specific.md`: `Infinity / 2 === Infinity` |
| 04 | Should | resolved | `issues/04-public-api-tenant-from-query.md`: the caller picks the tenant |
| 05 | Should | resolved | `issues/05-uploads-path-prefix-check.md` |
| 06 | Should | resolved | `issues/06-room-photos-malformed-uuid-500.md` |
| 07 | Should | resolved | `issues/07-test-ical-html-guard.md` |
| 08 | Should | resolved | `issues/08-test-cancel-orphan-pending.md` |
| 09 | Should | resolved | `issues/09-dead-tenantid-columns.md` |
| 10 | Nice | resolved | `issues/10-webhook-rate-limit.md` |

Dependencies: 02, 04 and 10 all touch `proxy.ts` / rate limiting, so do them one after another. 04 changes how e2e tests call the public APIs, so run the full suite after it. 09 needs a Drizzle migration (`npm run db:generate`).
