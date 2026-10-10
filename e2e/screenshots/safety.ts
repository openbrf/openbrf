import type { BrowserContext, Page } from "@playwright/test";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { expect } from "../src/fixtures";

/**
 * What must never reach an image, and how the page is held still while one is
 * taken.
 *
 * Separate from the capture so that both can be exercised on their own: CI
 * walks the screens only for a change that touches what the walk photographs,
 * while `specs/92-screenshot-safety` runs this file on every change, and a
 * safety mechanism nothing runs is a safety mechanism nobody knows the state
 * of.
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
 * A Swedish mobile number, written the ways people write one: 070-123 45 67,
 * 0701234567, +46 70 123 45 67, 0046 (0)70-1234567.
 *
 * Mobile numbers only, because those are what a person gives the association
 * and what the demo data the capture never runs is full of. Ten digits with at
 * most one space or hyphen between any two, and not touching a digit on either
 * side: a date (2026-07-01), a time or an amount runs out of digits or meets
 * another separator long before ten, and a longer run of digits - a reference,
 * an account - is not cut into a number from its middle. A letter may touch
 * it: a label in an element of its own reads as "Mobil0701234567" in the text,
 * and the picture still shows the number.
 */
const PHONE_NUMBER =
  /(?<!\d)(?:(?:\+|00)46[\s-]?(?:\(0\)[\s-]?)?|0)7\d(?:[\s-]?\d){7}(?!\d)/g;

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
  // What the picture paints and what `innerText` returns are not the same set,
  // and the difference is where something would hide. A filled-in form carries
  // its content in the field's value and an empty one paints its placeholder;
  // generated content is painted from a stylesheet and reaches no text node at
  // all; SVG text drawn by a `<use>` from a hidden sprite sheet is painted from
  // a definition `innerText` skips. The
  // first of those is not hypothetical - the setup wizard is photographed with
  // its forms filled in - and the rest are cheap to read while the page is
  // already held still.
  //
  // Every frame, not only the top one: an embedded document paints into the
  // same picture, and neither `innerText` nor a query reaches into it.
  const read = await Promise.all(
    page.frames().map((frame) => frame.evaluate(readPaintedText)),
  );
  const text = read.flat().join("\n");

  // The product's own scanner, so that what is refused here is what the
  // platform refuses on a published page: either form, with or without the
  // separator, put through the calendar and the check digit. The calendar is
  // also what lets a Swedish organisation number through - the cooperative's
  // own, and the example under the field asking for it - since its month digits
  // are issued past twelve precisely so that it cannot be read as a date.
  const identityNumbers = scanForPersonalIdentityNumbers(text).map(
    (match) => match.value,
  );
  expect(
    identityNumbers,
    `${name} shows something shaped like a personal identity number. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);

  const phoneNumbers = [...text.matchAll(PHONE_NUMBER)].map(
    (match) => match[0],
  );
  expect(
    phoneNumbers,
    `${name} shows something shaped like a phone number. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);

  const addresses = [...text.matchAll(EMAIL_ADDRESS)]
    .map((match) => match[0])
    .filter((candidate) => !candidate.endsWith(RESERVED_EMAIL_SUFFIX));
  expect(
    addresses,
    `${name} shows an email address outside the reserved ${RESERVED_EMAIL_SUFFIX} domain. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);
}

/**
 * One document's rendered text and what it paints besides. Runs in the
 * browser, once per frame.
 */
function readPaintedText(): string[] {
  const found: string[] = [document.body.innerText];

  for (const field of document.querySelectorAll("input, textarea")) {
    const typed = field as HTMLInputElement | HTMLTextAreaElement;
    found.push(typed.value, typed.placeholder);
  }

  for (const element of document.querySelectorAll("*")) {
    for (const part of ["::before", "::after"]) {
      const { content } = getComputedStyle(element, part);
      // `none` and `normal` are the two ways of saying there is nothing
      // there; anything else is a string the browser draws.
      if (content !== "none" && content !== "normal") {
        found.push(content);
      }
    }
  }

  for (const drawn of document.querySelectorAll("text, tspan")) {
    found.push(drawn.textContent ?? "");
  }

  return found.filter((value) => value !== "");
}
