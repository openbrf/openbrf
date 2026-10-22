import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import { ensureInstance } from "../src/provision";
import { uploadSitePicture } from "../src/site";

/**
 * The four layout blocks, as a visitor's browser lays them out.
 *
 * Not one of the numbered exit criteria. It is here because what these blocks
 * promise is about the page a real browser draws, which no unit test renders:
 * a banner, columns and a picture beside text side by side on a desktop and
 * one under the other on a telephone, nothing wider than the screen, and
 * every one of them passing the accessibility rules at both widths - with no
 * script on the page to rearrange anything.
 *
 * The page is written through the board's own API, as in the data blocks'
 * spec: the editor has its own coverage in 22-site-editing, and what is under
 * test here is what the website serves.
 *
 * This spec navigates the instance root, which the guard in
 * 93-public-site.spec.ts allows it by name.
 */

test.describe.configure({ mode: "serial" });

const RUN = uniqueSurname("l").toLowerCase();
const SLUG = `valkommen-${RUN}`;
const TARGET_SLUG = `stadgar-${RUN}`;
const MEMBERS_SLUG = `medlemmar-${RUN}`;

const BANNER_HEADING = `Välkommen till föreningen ${RUN}`;
const BANNER_ALT = "Gården en morgon i maj, med björken i full lövsprickning";
const IMAGE_TEXT_ALT =
  "Tvättstugan i källaren, med två maskiner och en torktumlare";
const COLUMN_HEADING = "Styrelsen";

/** The two widths the website is read at: a desktop, and a telephone. */
const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 900 }, sideBySide: true },
  {
    name: "telephone",
    viewport: { width: 375, height: 812 },
    sideBySide: false,
  },
] as const;

/**
 * The accessibility rules a public page is held to: WCAG 2.1 A and AA.
 *
 * Asked of the four blocks and what is inside them, so a rule the site's
 * chrome breaks - which other specs answer for - cannot hide behind this one,
 * and one these blocks break cannot hide behind the chrome.
 */
async function accessibilityViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include(".site-banner")
    .include(".site-image-text")
    .include(".site-columns")
    .include(".site-button-row")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) {
    throw new Error("the element is not laid out");
  }
  return found;
}

test("the layout blocks lay out on a desktop and a telephone, and pass the accessibility rules", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);

  const picture = await uploadSitePicture(request);
  const target = await api.createSitePage(request, stack.baseUrl, {
    slug: TARGET_SLUG,
    title: "Stadgar",
    blocks: [{ type: "paragraph", runs: [{ text: "Föreningens stadgar." }] }],
  });
  const members = await api.createSitePage(request, stack.baseUrl, {
    slug: MEMBERS_SLUG,
    title: "För medlemmar",
    blocks: [{ type: "paragraph", runs: [{ text: "Bara för medlemmar." }] }],
  });
  const written = await api.createSitePage(request, stack.baseUrl, {
    slug: SLUG,
    title: "Välkommen",
    blocks: [
      {
        type: "banner",
        mediaFileId: picture,
        alt: BANNER_ALT,
        heading: BANNER_HEADING,
        text: "Ett hus på Söder, byggt 1948 och förvaltat av de som bor här.",
        button: {
          label: "Läs stadgarna",
          target: { kind: "page", pageId: target.id },
        },
      },
      {
        type: "imageText",
        mediaFileId: picture,
        alt: IMAGE_TEXT_ALT,
        side: "right",
        paragraphs: [
          [
            { text: "Tvättstugan bokas på tavlan vid dörren. " },
            { text: "Ta med eget tvättmedel.", bold: true },
          ],
          [{ text: "Nyckeln finns hos styrelsen." }],
        ],
      },
      {
        type: "columns",
        columns: [
          {
            blocks: [
              {
                type: "heading",
                level: 2,
                runs: [{ text: COLUMN_HEADING }],
              },
              {
                type: "paragraph",
                runs: [
                  { text: "Styrelsen träffas första måndagen i månaden." },
                ],
              },
            ],
          },
          {
            blocks: [
              { type: "image", mediaFileId: picture, alt: "Entrén mot gatan" },
            ],
          },
          {
            blocks: [
              {
                type: "button",
                label: "Medlemssidan",
                target: { kind: "page", pageId: members.id },
                style: "primary",
              },
              {
                type: "button",
                label: "Kalendern",
                // A built-in page, named by the id every instance gives it.
                target: { kind: "page", pageId: "built-in-calendar" },
                style: "secondary",
              },
            ],
          },
        ],
      },
    ],
  });
  await api.publishSitePage(request, stack.baseUrl, target.id);
  await api.publishSitePage(request, stack.baseUrl, members.id, "MEMBERS_ONLY");
  await api.publishSitePage(request, stack.baseUrl, written.id);

  try {
    for (const width of WIDTHS) {
      await test.step(`on a ${width.name}`, async () => {
        await page.setViewportSize(width.viewport);
        await page.goto(`/${SLUG}`);

        // The banner: a described picture and the heading, with the button
        // leading to the page by the address it has today.
        await expect(
          page.getByRole("heading", { name: BANNER_HEADING }),
        ).toBeVisible();
        await expect(page.getByRole("img", { name: BANNER_ALT })).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Läs stadgarna" }),
        ).toHaveAttribute("href", `/${TARGET_SLUG}`);

        // A button to a page kept for the members is not shown to a visitor,
        // and the page's address is not on the page at all.
        await expect(page.getByText("Medlemssidan")).toHaveCount(0);
        expect(await page.content()).not.toContain(MEMBERS_SLUG);
        await expect(
          page.getByRole("link", { name: "Kalendern" }),
        ).toHaveAttribute("href", "/kalender");

        const columns = page.locator(".site-column");
        await expect(columns).toHaveCount(3);
        const [first, second, third] = [
          await box(columns.nth(0)),
          await box(columns.nth(1)),
          await box(columns.nth(2)),
        ];
        const image = await box(
          page.getByRole("img", { name: IMAGE_TEXT_ALT }),
        );
        const text = await box(page.locator(".site-image-text-body"));

        if (width.sideBySide) {
          // Side by side, in the order the board wrote them, and the picture
          // on the side the board chose.
          expect(second.x).toBeGreaterThan(first.x);
          expect(third.x).toBeGreaterThan(second.x);
          expect(Math.abs(second.y - first.y)).toBeLessThan(1);
          expect(image.x).toBeGreaterThan(text.x);
        } else {
          // One under the other, first column first, and the picture above
          // the text whichever side it stands on where there is room.
          expect(second.y).toBeGreaterThan(first.y);
          expect(third.y).toBeGreaterThan(second.y);
          expect(Math.abs(second.x - first.x)).toBeLessThan(1);
          expect(image.y).toBeLessThan(text.y);
        }

        // Nothing wider than the screen, which on a telephone is the first
        // thing a layout gets wrong.
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        expect(await accessibilityViolations(page)).toEqual([]);
      });
    }

    // And the promise the whole website makes, on a page laid out without
    // one: no script, and no cookie.
    const response = await request.get(`${stack.baseUrl}/${SLUG}`);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect((await response.text()).includes("<script")).toBe(false);
  } finally {
    for (const id of [written.id, members.id, target.id]) {
      await api.deleteSitePage(request, stack.baseUrl, id);
    }
  }
});
