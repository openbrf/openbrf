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
 * The task itself is not part of CI - it needs its own stack and it writes
 * files a reviewer looks at - so what runs here is the mechanism underneath it,
 * against a page this spec writes rather than against the product. That is the
 * point: a safety mechanism nothing runs is a safety mechanism nobody knows the
 * state of.
 */

/** Shaped like a personal identity number, and belonging to nobody. */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19850101-0000";

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

// One placement per case, and nothing carrying the number twice: a page that
// hid it in two places at once would pass this file with either half of the
// guard removed.
for (const [placement, markup] of [
  ["generated content", GENERATED_BY_CSS],
  ["a placeholder", PAINTED_AS_PLACEHOLDER],
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

test("holds the page still, so nothing arrives between the read and the picture", async ({
  page,
  context,
}) => {
  await page.setContent(LATE_CONTENT);

  // Frozen before the content is due, which is the window the guard closes: a
  // page read now and photographed a moment later would otherwise be
  // photographed with the row in it.
  const thaw = await freezeScripts(page, context);
  try {
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
