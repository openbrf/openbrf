import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

/**
 * Records one rate through the fee form.
 *
 * By role and accessible name, not by label: `getByLabel` compares the label
 * ELEMENT's text, and a label that wraps a select carries every option with it,
 * so no exact match can ever equal it.
 */
export async function recordFee(
  page: Page,
  fee: { apartmentId: string; appliesFrom: string; monthlyAmount: string },
): Promise<void> {
  await page
    .getByRole("combobox", { name: "Lägenhet", exact: true })
    .selectOption(fee.apartmentId);
  await page.getByLabel("Gäller från").fill(fee.appliesFrom);
  const amount = page.getByLabel("Belopp per månad i kronor");
  await amount.fill(fee.monthlyAmount);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/fees") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Registrera avgiften" }).click();

  // A refused rate leaves the amount in place, so the wait below would only
  // time out on "expected '' received '2500.00'". Say what the server answered.
  const response = await answered;
  expect(
    response.ok(),
    `recording ${fee.monthlyAmount} for ${fee.apartmentId} answered ${String(response.status())}`,
  ).toBe(true);

  // The screen empties the amount once the server has taken the rate, and that
  // lands after the response. A caller that fills the form again before then
  // writes into a form that is about to be reset, and the submit stays disabled
  // on the empty amount.
  await expect(amount).toHaveValue("");
}
