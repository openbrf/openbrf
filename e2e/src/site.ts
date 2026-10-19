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
