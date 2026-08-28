import type { BrowserContext, Page } from "@playwright/test";

import { expect } from "../src/fixtures";

/**
 * What must never reach an image, and how the page is held still while one is
 * taken.
 *
 * Separate from the capture so that both can be exercised on their own: the
 * screenshot task is not part of CI, and a safety mechanism nothing runs is a
 * safety mechanism nobody knows the state of.
 */

/**
 * Stops the page changing, and gives back the undo.
 *
 * Reading the page and photographing it are two acts, and anything arriving
 * between them would be in the image and in nothing that was checked. Narrowing
 * that window is not the same as closing it, so the window is removed instead:
 * with script execution disabled the DOM cannot change at all - a timer does
 * not fire, a pending response has no handler to run, and the page that is
 * checked is the page that is photographed.
 *
 * Chromium only, which is the browser this suite runs. Reversed rather than
 * left set, because the client re-themes itself from a media-query listener and
 * that listener is script: a page left frozen would photograph the next theme
 * in the colours of the one before it.
 */
export async function freezeScripts(
  page: Page,
  context: BrowserContext,
): Promise<() => Promise<void>> {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setScriptExecutionDisabled", { value: true });

  return async () => {
    await session.send("Emulation.setScriptExecutionDisabled", {
      value: false,
    });
    await session.detach();
  };
}

/**
 * A personal identity number, in either of the forms the register accepts.
 *
 * These images are attached to pull requests on a public repository about a
 * statutory personal-data register, so this is checked rather than trusted:
 * every screen is scanned before it is written, and a match fails the run.
 */
const IDENTITY_NUMBER = /\b\d{6}(?:\d{2})?[-+]\d{4}\b/g;

/**
 * Whether a match could be a personal identity number at all.
 *
 * A Swedish organisation number has the same shape and appears all over these
 * screens - the cooperative's own, and the example in the hint under the field
 * asking for it. The two are told apart by the date: a personal identity
 * number begins with one, and an organisation number is issued with its month
 * digits raised past twelve precisely so that it cannot. A coordination number
 * is a personal identity number with sixty added to the day, so the day is
 * allowed to run past the end of a month.
 */
function couldBeADate(candidate: string): boolean {
  const [date = ""] = candidate.split(/[-+]/);
  const month = Number(date.slice(-4, -2));
  const day = Number(date.slice(-2));
  return month >= 1 && month <= 12 && day >= 1 && day <= 91;
}

const EMAIL_ADDRESS = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

/**
 * Reserved by RFC 2606 and resolvable by nobody, which is why the fixtures use
 * it. An address on any other domain is a real one until proved otherwise.
 */
const RESERVED_EMAIL_SUFFIX = ".test";

/**
 * Reads the page and refuses anything that must not be published.
 *
 * Run on both sides of the shutter. The page is read and the picture is taken
 * as two separate acts, so a screen whose data arrives while it is being
 * photographed can put content in the image that the read before it never saw:
 * a `waitFor` that is a static heading is satisfied before the request filling
 * the page comes back. The read after the picture is the one that covers the
 * picture - whatever reached the image is in the page by then - and the read
 * before it is what fails a bad screen without spending a picture on it.
 */
export async function assertSafeToPublish(
  page: Page,
  name: string,
): Promise<void> {
  // What a filled-in form shows is in the field's value, not in the document's
  // text, and the setup wizard is photographed with its forms filled in.
  const typed = await page
    .locator("input, textarea")
    .evaluateAll((fields) =>
      fields
        .map((field) => (field as HTMLInputElement | HTMLTextAreaElement).value)
        .filter((value) => value !== ""),
    );
  const text = [await page.locator("body").innerText(), ...typed].join("\n");

  const identityNumbers = [...text.matchAll(IDENTITY_NUMBER)]
    .map((match) => match[0])
    .filter(couldBeADate);
  expect(
    identityNumbers,
    `${name} shows something shaped like a personal identity number. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);

  const addresses = [...text.matchAll(EMAIL_ADDRESS)]
    .map((match) => match[0])
    .filter((candidate) => !candidate.endsWith(RESERVED_EMAIL_SUFFIX));
  expect(
    addresses,
    `${name} shows an email address outside the reserved ${RESERVED_EMAIL_SUFFIX} domain. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);
}
