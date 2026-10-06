import { testPersonalIdentityNumber } from "@openbrf/shared/testing";

import { expect, test } from "../src/fixtures";
import { assertSafeToPublish, freezeScripts } from "../screenshots/safety";

/**
 * The guard between a screen and a published image.
 *
 * The screenshot task photographs every screen and attaches the images to pull
 * requests on a public repository about a statutory personal-data register, so
 * each screen is read for personal identity numbers and real email addresses
 * first. Reading and photographing are two acts, and content arriving between
 * them would be in the image and in nothing that was read.
 *
 * CI walks the screens only for a change that touches what the walk
 * photographs, and the walk needs a stack of its own, so what runs here on
 * every change is the mechanism underneath it, against a page this spec writes
 * rather than against the product. That is the point: a safety mechanism
 * nothing runs is a safety mechanism nobody knows the state of.
 */

/**
 * A valid personal identity number from the range the repository's fixtures
 * draw from, in its twelve digits with no separator.
 */
const COMPACT_PERSONAL_IDENTITY_NUMBER = testPersonalIdentityNumber(0);

/** The same number written with the hyphen, as most screens print one. */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = `${COMPACT_PERSONAL_IDENTITY_NUMBER.slice(0, 8)}-${COMPACT_PERSONAL_IDENTITY_NUMBER.slice(8)}`;

/** The same screen before anything has filled it, and with nothing due to. */
const NOTHING_YET = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <div id="rows"></div>
    </body>
  </html>
`;

/**
 * A page that puts the forbidden content up shortly after it loads.
 *
 * Which is the case the guard exists for: a `waitFor` that is a static heading
 * is satisfied before the request filling the screen comes back, so the read
 * can happen while the page still looks empty.
 */
const LATE_CONTENT = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <div id="rows"></div>
      <script>
        setTimeout(() => {
          document.getElementById("rows").textContent =
            "${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}";
        }, 50);
      </script>
    </body>
  </html>
`;

test("refuses a screen showing something shaped like a personal identity number", async ({
  page,
}) => {
  await page.setContent(LATE_CONTENT);
  await expect(page.locator("#rows")).toHaveText(
    LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER,
  );

  await expect(assertSafeToPublish(page, "late-content")).rejects.toThrow(
    /personal identity number/,
  );
});

/**
 * The same number, painted from a stylesheet rather than written into the
 * document. Generated content reaches no text node, so `innerText` does not
 * return it - and the picture paints it all the same.
 */
const GENERATED_BY_CSS = `
  <!doctype html>
  <html lang="sv">
    <head>
      <style>
        #stamp::after {
          content: "${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}";
        }
      </style>
    </head>
    <body>
      <h1>Adressbok</h1>
      <p id="stamp"></p>
    </body>
  </html>
`;

/** And again as a placeholder, which an empty field paints and no value holds. */
const PAINTED_AS_PLACEHOLDER = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <input
        aria-label="Personnummer"
        placeholder="${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}"
      />
    </body>
  </html>
`;

/** A field somebody filled in, whose value no text node holds either. */
const HELD_AS_A_VALUE = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <input aria-label="Personnummer" value="${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}" />
    </body>
  </html>
`;

/**
 * SVG text defined in a sprite sheet the page hides, and drawn where a `<use>`
 * places it - the way an icon set ships its symbols. Chromium's `innerText`
 * returns SVG text laid out in place, so that case needs no branch of its own;
 * a definition inside a hidden subtree is skipped by it and painted all the
 * same.
 */
const DRAWN_AS_SVG_TEXT = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <svg style="display: none">
        <defs>
          <text id="label" x="0" y="20">${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}</text>
        </defs>
      </svg>
      <svg width="240" height="40"><use href="#label" /></svg>
    </body>
  </html>
`;

/**
 * Inside an embedded document, which paints into the same picture and is a
 * document of its own to every query made in the page around it.
 */
const INSIDE_AN_IFRAME = `
  <!doctype html>
  <html lang="sv">
    <body>
      <h1>Adressbok</h1>
      <iframe srcdoc="<p>${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}</p>"></iframe>
    </body>
  </html>
`;

// One placement per case, and nothing carrying the number twice: a page that
// hid it in two places at once would pass this file with either half of the
// guard removed.
for (const [placement, markup] of [
  ["generated content", GENERATED_BY_CSS],
  ["a placeholder", PAINTED_AS_PLACEHOLDER],
  ["a field's value", HELD_AS_A_VALUE],
  ["SVG text", DRAWN_AS_SVG_TEXT],
  ["an iframe's text", INSIDE_AN_IFRAME],
] as const) {
  test(`refuses one shown as ${placement}, which the document's text does not carry`, async ({
    page,
  }) => {
    await page.setContent(markup);

    // The gap this covers, stated rather than assumed: a check reading the
    // document's text alone would pass this screen.
    const written = await page.locator("body").innerText();
    expect(written).not.toContain(LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);

    await expect(assertSafeToPublish(page, placement)).rejects.toThrow(
      /personal identity number/,
    );
  });
}

/** A page carrying `text` and nothing else worth reading. */
function pageShowing(text: string): string {
  return `
    <!doctype html>
    <html lang="sv">
      <body>
        <h1>Adressbok</h1>
        <p>${text}</p>
      </body>
    </html>
  `;
}

test("refuses a personal identity number written without its separator", async ({
  page,
}) => {
  await page.setContent(pageShowing(COMPACT_PERSONAL_IDENTITY_NUMBER));

  await expect(assertSafeToPublish(page, "compact")).rejects.toThrow(
    /personal identity number/,
  );
});

test("lets the example organisation number through", async ({ page }) => {
  // The example the hint under the organisation number field prints. It
  // carries a valid check digit, so only the calendar keeps it apart from a
  // personal identity number - and it is on the screens the walk photographs.
  await page.setContent(pageShowing("Organisationsnummer 769600-1234"));

  await assertSafeToPublish(page, "organisation-number");
});

for (const written of ["070-123 45 67", "+46 70 123 45 67", "0701234567"]) {
  test(`refuses a mobile number written as ${written}`, async ({ page }) => {
    await page.setContent(pageShowing(`Telefon ${written}`));

    await expect(assertSafeToPublish(page, "phone")).rejects.toThrow(
      /phone number/,
    );
  });
}

test("lets a date, a time and an amount through", async ({ page }) => {
  await page.setContent(
    pageShowing("2026-07-01 – 2026-07-31, kl. 07:30, 1 070 123,45 kr"),
  );

  await assertSafeToPublish(page, "dates-and-amounts");
});

test("refuses an email address outside the reserved domain, and only that", async ({
  page,
}) => {
  await page.setContent(pageShowing("ingrid@eksemplet.test"));
  await assertSafeToPublish(page, "reserved-email");

  await page.setContent(pageShowing("ingrid@eksemplet.se"));
  await expect(assertSafeToPublish(page, "email")).rejects.toThrow(
    /email address/,
  );
});

test("holds the page still, so nothing arrives between the read and the picture", async ({
  page,
  context,
}) => {
  await page.setContent(NOTHING_YET);

  // Frozen first and the content set in motion afterwards, so the timer is
  // certain to come due inside the window the guard closes: a page read now and
  // photographed a moment later would otherwise be photographed with the row in
  // it. A timer armed before the freeze would race it on a slow runner. The
  // call itself still runs, because it arrives over the protocol rather than
  // from the page; the callback it schedules is the page's own script.
  const thaw = await freezeScripts(page, context);
  try {
    await page.evaluate((value) => {
      setTimeout(() => {
        document.querySelector("#rows")!.textContent = value;
      }, 10);
    }, LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);
    await assertSafeToPublish(page, "frozen");
    await page.waitForTimeout(400);
    // Still nothing: the timer cannot fire, so the page that was read is the
    // page that would be photographed.
    await expect(page.locator("#rows")).toBeEmpty();
    await assertSafeToPublish(page, "frozen");
  } finally {
    await thaw();
  }

  // Thawed, the page runs again. Asked for the row a second time rather than
  // waiting for the first: a timer that came due while script was disabled is
  // dropped rather than deferred, which is more than the freeze promises and
  // not something to rest on. What matters here is that the freeze was lifted
  // and the same check still refuses the content.
  await page.evaluate((value) => {
    setTimeout(() => {
      document.querySelector("#rows")!.textContent = value;
    }, 10);
  }, LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER);

  await expect(page.locator("#rows")).toHaveText(
    LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER,
  );
  await expect(assertSafeToPublish(page, "thawed")).rejects.toThrow(
    /personal identity number/,
  );
});
