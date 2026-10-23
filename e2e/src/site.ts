import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import type { APIRequestContext } from "@playwright/test";

import { stack } from "./stack";

/**
 * Pages on the association's own website, through the endpoints the board uses.
 *
 * This was SQL until the page editor existed, because there was no endpoint
 * that created a page and the property under test - that a member-only page is
 * byte-identical to a missing one for anyone not signed in - could not wait for
 * one. It writes through the API now, which is the better fixture for the
 * ordinary reason: a page created the way the board creates one is a page the
 * publication guardrails have already seen, so a spec cannot arrange a state
 * the product itself would refuse.
 *
 * Pages are service tier - no append-only trigger, nothing statutory, nothing
 * personal - so removing them again afterwards is allowed, unlike everything
 * the suite creates in a register.
 */

export interface SitePageFixture {
  id: string;
  slug: string;
  title: string;
  paragraph: string;
}

async function expectOk(
  response: {
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  },
  what: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${what} answered ${String(response.status())}: ${await response.text()}`,
    );
  }
}

/** Whether a page is on the website, and who may read it there. */
export type SitePageStatus = "DRAFT" | "MEMBERS_ONLY" | "PUBLIC";

/**
 * Writes one page and gives it a status, returning what it says.
 *
 * The slug and the text are unique per call so a rerun against a kept stack
 * cannot collide with the page a previous run left, and so an assertion that
 * finds the text on a page found the page this call wrote.
 *
 * The caller's context has to be signed in as somebody holding site:manage.
 */
export async function createSitePage(
  request: APIRequestContext,
  input: { status: SitePageStatus },
): Promise<SitePageFixture> {
  const suffix = randomUUID().slice(0, 8);
  const page = {
    slug: `${input.status === "MEMBERS_ONLY" ? "medlemssidan" : "sidan"}-${suffix}`,
    title: `Sida ${suffix}`,
    paragraph: `Endast för denna körning, ${suffix}.`,
  };

  const created = await request.post(`${stack.baseUrl}/api/site/pages`, {
    data: {
      slug: page.slug,
      title: page.title,
      content: {
        blocks: [{ type: "paragraph", runs: [{ text: page.paragraph }] }],
      },
    },
  });
  await expectOk(created, "POST /api/site/pages");
  const { id } = (await created.json()) as { id: string };

  // Written as a draft, as every page is; the status is its own act.
  if (input.status !== "DRAFT") {
    const changed = await request.post(
      `${stack.baseUrl}/api/site/pages/${id}/status`,
      { data: { status: input.status } },
    );
    await expectOk(changed, "POST /api/site/pages/:id/status");
  }

  return { id, ...page };
}

/** The page the root serves by the board's choice, or null when none is. */
export async function frontPage(
  request: APIRequestContext,
): Promise<{ id: string; title: string } | null> {
  const listed = await request.get(`${stack.baseUrl}/api/site/pages`);
  await expectOk(listed, "GET /api/site/pages");
  const pages = (await listed.json()) as {
    id: string;
    title: string;
    frontPage: boolean;
  }[];
  const chosen = pages.find((page) => page.frontPage);
  return chosen === undefined ? null : { id: chosen.id, title: chosen.title };
}

/** Makes a public page the front page, as the board's switch does. */
export async function chooseFrontPage(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  const chosen = await request.post(
    `${stack.baseUrl}/api/site/pages/${id}/front-page`,
    { data: {} },
  );
  await expectOk(chosen, "POST /api/site/pages/:id/front-page");
}

/**
 * Puts a page in the menu or takes it out, as the page's "Show in menu"
 * switch does, and returns whether the page says it is in the menu after.
 */
export async function setInMenu(
  request: APIRequestContext,
  id: string,
  inMenu: boolean,
): Promise<boolean> {
  const changed = await request.post(
    `${stack.baseUrl}/api/site/pages/${id}/menu`,
    { data: { inMenu } },
  );
  await expectOk(changed, "POST /api/site/pages/:id/menu");
  return ((await changed.json()) as { inMenu: boolean }).inMenu;
}

/** Whether a page is in the menu now, from the page the board's list shows. */
export async function isInMenu(
  request: APIRequestContext,
  id: string,
): Promise<boolean> {
  const page = await request.get(`${stack.baseUrl}/api/site/pages/${id}`);
  await expectOk(page, "GET /api/site/pages/:id");
  return ((await page.json()) as { inMenu: boolean }).inMenu;
}

/** Removes a page this suite wrote. Service tier, so this is allowed. */
export async function deleteSitePage(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  const response = await request.delete(
    `${stack.baseUrl}/api/site/pages/${id}`,
  );
  // A page a spec already removed is not a failure of the cleanup after it, so
  // only a refusal that is not "there is no such page" is reported.
  if (!response.ok() && response.status() !== 404) {
    await expectOk(response, "DELETE /api/site/pages/:id");
  }
}

/**
 * A picture the size of a banner, as PNG bytes, in one flat colour.
 *
 * Generated rather than checked in, because what a spec about layout needs of
 * a picture is that it is one: the media route sniffs the bytes, so a file
 * that only claimed to be an image would be refused before any page saw it.
 */
export function pngPicture(width = 960, height = 540): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Eight bits per channel, RGB, no interlace.
  header.set([8, 2, 0, 0, 0], 8);
  // Each row is a filter byte and then its pixels, a muted green throughout.
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row.set([96, 128, 104], 1 + x * 3);
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Uploads a picture for the website, declared as showing nobody, through the
 * route the page editor uses, and returns its id.
 *
 * The caller's context has to be signed in as somebody holding site:manage.
 */
export async function uploadSitePicture(
  request: APIRequestContext,
  name = "garden.png",
): Promise<string> {
  const response = await request.post(`${stack.baseUrl}/api/site/images`, {
    // A form body names where it came from, as the editor's does, or the API
    // takes it for a form posted from a sibling site.
    headers: { origin: new URL(stack.baseUrl).origin },
    multipart: {
      showsIdentifiablePersons: "false",
      file: { name, mimeType: "image/png", buffer: pngPicture() },
    },
  });
  await expectOk(response, "POST /api/site/images");
  return ((await response.json()) as { id: string }).id;
}
