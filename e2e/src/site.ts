import { randomUUID } from "node:crypto";

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

/**
 * Writes one page and publishes it, returning what it says.
 *
 * The slug and the text are unique per call so a rerun against a kept stack
 * cannot collide with the page a previous run left, and so an assertion that
 * finds the text on a page found the page this call wrote.
 *
 * The caller's context has to be signed in as somebody holding site:manage.
 */
export async function createSitePage(
  request: APIRequestContext,
  input: { visibility: "PUBLIC" | "MEMBER"; publish?: boolean },
): Promise<SitePageFixture> {
  const suffix = randomUUID().slice(0, 8);
  const page = {
    slug: `${input.visibility === "MEMBER" ? "medlemssidan" : "sidan"}-${suffix}`,
    title: `Sida ${suffix}`,
    paragraph: `Endast för denna körning, ${suffix}.`,
  };

  const created = await request.post(`${stack.baseUrl}/api/site/pages`, {
    data: {
      slug: page.slug,
      title: page.title,
      visibility: input.visibility,
      content: {
        blocks: [{ type: "paragraph", runs: [{ text: page.paragraph }] }],
      },
    },
  });
  await expectOk(created, "POST /api/site/pages");
  const { id } = (await created.json()) as { id: string };

  if (input.publish !== false) {
    const published = await request.post(
      `${stack.baseUrl}/api/site/pages/${id}/publish`,
      { data: { published: true } },
    );
    await expectOk(published, "POST /api/site/pages/:id/publish");
  }

  return { id, ...page };
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
