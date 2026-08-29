import { randomUUID } from "node:crypto";

import pg from "pg";

import { stack } from "./stack";

/**
 * Pages on the association's own website, written straight into the database.
 *
 * The one place in the suite that writes rather than reads, and it needs saying
 * why. There is no endpoint that creates a page: the storage and the public
 * renderer land first, and the board's page editor is a later change. The
 * property under test - that a member-only page is byte-identical to a missing
 * one for anyone not signed in - cannot wait for the editor, because it is the
 * property the editor will be built on top of.
 *
 * The connection is the owner's, like the audit-log reads, and the table is
 * service tier: no append-only trigger, nothing statutory, nothing personal.
 * Deleting these rows again is therefore allowed, unlike everything the suite
 * creates in a register.
 */

async function withClient<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: stack.databaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

export interface SitePageFixture {
  slug: string;
  title: string;
  paragraph: string;
}

/**
 * Writes one published page and returns what it says.
 *
 * The slug and the text are unique per call so a rerun against a kept stack
 * cannot collide with the row a previous run left, and so an assertion that
 * finds the text on a page found the page this call wrote.
 */
export async function insertPage(input: {
  visibility: "PUBLIC" | "MEMBER";
  sortOrder?: number;
}): Promise<SitePageFixture> {
  const suffix = randomUUID().slice(0, 8);
  const page: SitePageFixture = {
    slug: `${input.visibility === "MEMBER" ? "medlemssidan" : "sidan"}-${suffix}`,
    title: `Sida ${suffix}`,
    paragraph: `Endast för denna körning, ${suffix}.`,
  };

  await withClient(async (client) => {
    // Prisma maps the model to "page" but leaves the column names in camel
    // case, so every one of them has to be quoted.
    await client.query(
      `INSERT INTO public.page
         (id, slug, title, content, visibility, published, "publishedAt",
          "sortOrder", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5::"PageVisibility", true, now(),
               $6, now(), now())`,
      [
        `e2e-${randomUUID()}`,
        page.slug,
        page.title,
        JSON.stringify({
          version: 1,
          blocks: [{ type: "paragraph", text: page.paragraph }],
        }),
        input.visibility,
        input.sortOrder ?? 100,
      ],
    );
  });

  return page;
}

/** Removes a page this suite wrote. Service tier, so this is allowed. */
export async function deletePage(slug: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM public.page WHERE slug = $1", [slug]);
  });
}
