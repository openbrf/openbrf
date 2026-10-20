import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The application's navigation, read the way a person uses it.
 *
 * The band groups the destinations into sections, and a closed section renders
 * no links at all. So an assertion that a link is absent from the page passes
 * whatever the navigation offers, and one that a link is present fails for a
 * destination that is merely behind a closed sign. Every spec that asks what an
 * account is offered asks here instead, where every section is opened and read.
 */

/** How long one sign may take to answer before the read is tried again. */
const STEP = { timeout: 5_000 };

/**
 * The band.
 *
 * The suite's window is wider than the switch at 1024px, so the phone bar is
 * `display: none` and a role query skips it: this is the one navigation a
 * person at this window can see.
 */
export function primaryNavigation(page: Page): Locator {
  return page.getByRole("navigation", {
    name: "Huvudnavigering",
    exact: true,
  });
}

/** The band's signs, in band order: each a link or a section's button. */
function signs(page: Page): Locator {
  return primaryNavigation(page).locator(":scope > ul > li > :first-child");
}

/** The element a section's button controls, while it is open. */
function panelOf(page: Page, id: string | null): Locator {
  if (id === null) {
    throw new Error("an open section names no panel");
  }
  // An attribute selector, because an id React generates is not a valid CSS
  // id selector.
  return page.locator(`[id="${id}"]`);
}

async function open(sign: Locator): Promise<void> {
  await sign.click(STEP);
  await expect(sign).toHaveAttribute("aria-expanded", "true", STEP);
}

async function close(page: Page, sign: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(sign).toHaveAttribute("aria-expanded", "false", STEP);
}

/**
 * A link's name as it reads, without the letter case the band sets it in. With
 * `plate` it is also as the count plate that follows it reads, e.g. the feed's
 * unread posts; without, it is the name alone: how many there are depends on
 * what earlier specs wrote, and no destination's name ends in a digit.
 */
async function namesOf(links: Locator, plate: boolean): Promise<string[]> {
  return (await links.allTextContents()).map((name) =>
    (plate ? name : name.replace(/\d+$/, "")).trim(),
  );
}

/**
 * Every destination this account is offered in the band, in band order.
 *
 * A sign that is a link is read as it stands; a section's sign is opened, its
 * links read, and closed again, so the page is left as it was found.
 *
 * The band only gains: while the viewer is unknown it carries the settings
 * alone. A caller therefore polls this for a destination the account has
 * before asserting that another one is absent, so the absence is read from the
 * whole offer rather than from a band that had not filled in yet.
 */
export async function offeredDestinations(page: Page): Promise<string[]> {
  return read(page, false);
}

/**
 * The same destinations, each as it reads with its count plate, e.g. "Flöde3":
 * for a spec that asks what the count says.
 */
export async function offeredDestinationsWithCounts(
  page: Page,
): Promise<string[]> {
  return read(page, true);
}

async function read(page: Page, plate: boolean): Promise<string[]> {
  const names: string[] = [];
  const all = signs(page);
  const count = await all.count();

  for (let index = 0; index < count; index++) {
    const sign = all.nth(index);
    if ((await sign.getAttribute("aria-expanded")) === null) {
      names.push(...(await namesOf(sign, plate)));
      continue;
    }
    await open(sign);
    const panel = panelOf(page, await sign.getAttribute("aria-controls"));
    names.push(...(await namesOf(panel.getByRole("link"), plate)));
    await close(page, sign);
  }

  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Goes to a destination the way a person does: through the sign that is it,
 * or by opening the section that holds it and pressing it there.
 *
 * Waits first for the band to offer it, since the band only gains: straight
 * after a sign-in it may still carry the settings alone.
 */
export async function goToDestination(page: Page, name: string): Promise<void> {
  await expect.poll(() => offeredDestinations(page)).toContain(name);
  const all = signs(page);
  const count = await all.count();
  const before = page.url();

  for (let index = 0; index < count; index++) {
    const sign = all.nth(index);
    if ((await sign.getAttribute("aria-expanded")) === null) {
      if ((await namesOf(sign, false)).includes(name)) {
        await sign.click();
        await expect(page).not.toHaveURL(before);
        return;
      }
      continue;
    }
    await open(sign);
    const panel = panelOf(page, await sign.getAttribute("aria-controls"));
    // The destination's name alone, or followed by its count plate.
    const link = panel
      .getByRole("link")
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\d*\\s*$`) });
    if ((await link.count()) > 0) {
      await link.first().click();
      await expect(page).not.toHaveURL(before);
      return;
    }
    await close(page, sign);
  }

  throw new Error(`the band offers no destination named ${name}`);
}
