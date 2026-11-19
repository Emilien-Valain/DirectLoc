import type { Page } from "@playwright/test";

/** Remplit « Pour vous joindre » du formulaire public (tous les champs sont obligatoires). */
export async function fillGuestContact(
  page: Page,
  opts: { firstName?: string; lastName: string; email: string; phone?: string; address?: string },
) {
  await page.fill("#guestFirstName", opts.firstName ?? "Client");
  await page.fill("#guestLastName", opts.lastName);
  await page.fill("#guestEmail", opts.email);
  await page.fill("#guestPhone", opts.phone ?? "06 01 02 03 04");
  await page.fill("#guestAddress", opts.address ?? "12 rue des Lilas, 84000 Avignon");
}
