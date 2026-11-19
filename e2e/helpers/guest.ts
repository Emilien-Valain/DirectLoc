import { expect, type Page } from "@playwright/test";

/** Remplit « Pour vous joindre » du formulaire public (tous les champs sont obligatoires). */
export async function fillGuestContact(
  page: Page,
  opts: { firstName?: string; lastName: string; email: string; phone?: string; address?: string; country?: string },
) {
  await page.fill("#guestFirstName", opts.firstName ?? "Client");
  await page.fill("#guestLastName", opts.lastName);
  await page.fill("#guestEmail", opts.email);
  await page.fill("#guestPhone", opts.phone ?? "06 01 02 03 04");
  await page.fill("#guestAddress", opts.address ?? "12 rue des Lilas, 84000 Avignon");
  if (opts.country) await page.selectOption("#guestCountry", opts.country);
}

/** Formulaire admin (création/modification) : « Marie Dupont » → Prénom « Marie », Nom « Dupont » ; un mot = Nom. */
function split(full: string) {
  const i = full.indexOf(" ");
  return i < 0 ? { first: "", last: full } : { first: full.slice(0, i), last: full.slice(i + 1) };
}

export async function fillAdminGuestName(page: Page, full: string) {
  const { first, last } = split(full);
  await page.locator('[name="guestFirstName"]').fill(first);
  await page.locator('[name="guestLastName"]').fill(last);
}

export async function expectAdminGuestName(page: Page, full: string) {
  const { first, last } = split(full);
  await expect(page.locator('[name="guestFirstName"]')).toHaveValue(first);
  await expect(page.locator('[name="guestLastName"]')).toHaveValue(last);
}
