import type { APIRequestContext, Page } from "@playwright/test";

import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { listMessages, type Message, waitForMessage } from "../src/mailpit";
import { listNews, type NewsRow } from "../src/news";
import {
  ADMINISTRATOR,
  ensureInstance,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * What a connected app may ask the association to do, and what it may not.
 *
 * Not one of the numbered exit criteria. It is here because the registry's
 * central promise is a negative one - something that may write the association's
 * news and publish it may not mail the members - and a negative is only worth
 * anything against the whole deployed instance. The request is a column, the
 * notice is a screen, the answer is the ordinary publish, the mailing is a
 * transaction, a queue, a worker and a real mail server; a test of any one of
 * them can show that the notice renders, and none of them can show that nothing
 * left the building while it stood there. That is the first test: a mailing is
 * asked for twice and nobody is written to until a board member publishes, and
 * then exactly once.
 *
 * The second is the catalogue, which is the document a connected app reads
 * before it does anything at all. Two things about it are load-bearing and
 * neither can be read off a source file: which names this instance actually
 * offers, since that is the registry as the deployed image assembled it and as
 * the calling person's capabilities filtered it; and the published input schema
 * of page_update, where the absence of photoConsentConfirmed is the whole point.
 * That field is a board member declaring that the people in a photograph have
 * consented to being published, which is an attestation a person makes and not
 * a value a caller fills in - so an input document offering it would be the
 * platform inviting a model to assert it on the board's behalf.
 */

test.describe.configure({ mode: "serial" });

/** Run-unique, so a rerun against a kept stack cannot collide with its own rows. */
const suffix = Date.now().toString(36);

const ITEM = {
  slug: `sopsortering-${suffix}`,
  title: `Ny sopsortering ${suffix}`,
  paragraph: `Matavfallet hämtas på tisdagar från och med nästa vecka, ${suffix}.`,
} as const;

/** The standing notice, word for word as the board reads it. */
const MAILING_REQUESTED =
  "En ansluten app har begärt att nyheten skickas till medlemmarna";

/**
 * A member of the shared register fixture: Storgatan 12, with a
 * tenant-ownership, so the mailing is hers.
 *
 * One member is enough here. That every member is written to, each in their own
 * language, and that a resident who holds no tenant-ownership is not, is spec
 * 23's subject; what this file needs her for is the two moments around the
 * publish - nothing in her mailbox while the request stands, and one thing in it
 * afterwards.
 */
const MEMBER_EMAIL = "astrid@eksemplet.test";

/**
 * The twenty-four actions the first slice registers: the association's news,
 * its pages and its menu.
 *
 * Written out rather than read back from the instance, because a list read from
 * the instance would only assert that the instance agrees with itself. This is
 * the set a connected app is promised, and a name appearing here that no
 * registrar declares - or a name reaching the catalogue that is not here - is
 * the failure this is for.
 */
const FIRST_SLICE: readonly string[] = [
  "news_list",
  "news_get",
  "news_create",
  "news_update",
  "news_publish",
  "news_unpublish",
  "news_set_visibility",
  "news_delete",
  "news_request_mailing",
  "page_list",
  "page_get",
  "page_create",
  "page_update",
  "page_publish",
  "page_unpublish",
  "page_set_visibility",
  "page_reorder",
  "page_delete",
  "menu_list",
  "menu_generated_keys",
  "menu_create",
  "menu_update",
  "menu_reorder",
  "menu_remove",
];

/**
 * A dotted token carrying no space: what i18next answers with when a string is
 * missing, and what a title must never be.
 */
const LOOKS_LIKE_A_KEY = /^\S*\.\S*$/;

/** One entry of the catalogue, as far as this file reads it. */
interface CatalogueEntry {
  readonly name: string;
  readonly title: string;
}

async function signInAsBoard(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * The item this file wrote, as the board's own list reports it.
 *
 * Narrowed here rather than read through `?.` at the call sites: a run that
 * lost the item has to fail on the line that says so, rather than several
 * assertions later on a field that is missing for a different reason.
 */
async function newsBySlug(
  request: APIRequestContext,
  slug: string,
): Promise<NewsRow> {
  const found = (await listNews(request)).find((one) => one.slug === slug);
  if (found === undefined) {
    throw new Error(`the news item ${slug} is not in the board's list`);
  }
  return found;
}

/**
 * The mail this notice caused, whoever it went to.
 *
 * By subject rather than by recipient, and the mailbox is never emptied first:
 * nothing in the suite can unsend a message, so a member's mailbox holds
 * whatever the specs above this one put there - an invitation among them. The
 * claim being made is about one notice, so that is what is counted.
 */
async function mailingsAbout(title: string): Promise<readonly Message[]> {
  return (await listMessages()).filter((message) =>
    message.Subject.includes(title),
  );
}

/**
 * Holds for a few seconds, and fails if anything about this notice is sent.
 *
 * A window rather than an instant. A mailing is claimed in a request handler
 * and handed to a worker, so one that had been ordered arrives a moment after
 * the call that ordered it - and a mailbox read straight away would be empty
 * either way.
 */
async function expectNothingSentAbout(
  title: string,
  windowMs = 4000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    expect(
      (await mailingsAbout(title)).map((message) => message.Subject),
      "a mailing went out that no board member decided",
    ).toEqual([]);
    if (Date.now() > deadline) {
      return;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

/**
 * Asks for the mailing over the API.
 *
 * The board's own route, because it is the only way into this state that the
 * first slice has: the registry publishes news_request_mailing to a connected
 * app, and nothing in this build carries a call from one to the registry yet.
 * What the notice is about is therefore exactly what is exercised here - a
 * caller that may write and publish asking for something it may not do itself.
 */
async function requestTheMailing(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  const response = await request.post(
    `${stack.baseUrl}/api/news/${id}/mailing-request`,
  );
  expect(
    response.status(),
    `asking for the mailing answered ${String(response.status())}`,
  ).toBe(200);
}

test.describe("the action registry", () => {
  test("a mailing is asked for over the API and decided by a board member", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureRegisterFixture(request);

    /*
     * Two clients, and two addresses. The board is a person at a browser and
     * signing in costs about four of the twenty requests a minute an address is
     * allowed; the caller asking for the mailing is something else, somewhere
     * else, and keeps the address the fixture gave this test. Giving them one
     * between them would spend the board's sign-in budget on a request that is
     * not a sign-in at all.
     */
    await page.setExtraHTTPHeaders({
      "x-forwarded-for": clientAddressFor(clientAddress, "board"),
    });
    await signInAsBoard(page);

    let written: string | null = null;
    try {
      // --- the board writes the notice, on its own screen ---------------------
      await page.goto(appPath("/admin/site/news"));
      await expect(
        page.getByRole("heading", { name: "Nyheter", exact: true }),
      ).toBeVisible();

      /*
       * Anchored at the start of each label, as spec 23 writes them: a field's
       * <label> wraps its hint as well as its word, and the body's hint explains
       * how to write a subheading and so contains the word the first field is
       * called.
       */
      await page.getByLabel(/^Rubrik/).fill(ITEM.title);
      await page.getByLabel(/^Adress/).fill(ITEM.slug);
      await page.getByLabel(/^Text/).fill(ITEM.paragraph);
      await page.getByRole("button", { name: "Spara nyheten" }).click();
      await expect(page.getByText("Nyheten är sparad.")).toBeVisible();

      const panel = page.getByRole("article").filter({ hasText: ITEM.title });
      await expect(panel).toBeVisible();

      const item = await newsBySlug(request, ITEM.slug);
      written = item.id;
      // Nothing has been claimed: this is a draft nobody has asked anything
      // about, which is what makes the assertions below say something.
      expect(item.emailQueuedAt).toBeNull();

      // --- something asks for the mailing ------------------------------------
      await requestTheMailing(request, item.id);

      /*
       * Reloaded rather than waited on. The screen reads the list when it is
       * opened and after an act of its own, and a request placed elsewhere is
       * neither - so the board learns of one the next time they look, which is
       * what this is.
       */
      await page.reload();
      const notice = panel.getByText(MAILING_REQUESTED);
      await expect(notice).toBeVisible();

      /*
       * And it names nobody. The board is being asked one question - should this
       * go out - and a requester printed beside it would turn that into a
       * question about whoever asked. Who did is in the audit log.
       */
      const wording = (await notice.innerText()).toLowerCase();
      for (const naming of [
        ADMINISTRATOR.firstName,
        ADMINISTRATOR.lastName,
        ADMINISTRATOR.email,
      ]) {
        expect(
          wording,
          "the standing notice names the person who asked",
        ).not.toContain(naming.toLowerCase());
      }

      /*
       * A property of what the screen was given, not only of what it rendered.
       * The item carries a boolean, so there is no requester on this screen for
       * a later edit to start printing.
       */
      const asked = await newsBySlug(request, ITEM.slug);
      expect(
        Object.keys(asked).filter((field) =>
          /person|requestedby|author|actor/i.test(field),
        ),
        "the board's news row carries who asked",
      ).toEqual([]);

      // --- the board says no -------------------------------------------------
      await panel
        .getByRole("button", { name: "Avfärda begäran", exact: true })
        .click();
      await expect(panel.getByText("Begäran är avfärdad")).toBeVisible();
      await expect(panel.getByText(MAILING_REQUESTED)).toHaveCount(0);

      // On the server rather than on the screen: the notice is still gone when
      // the list is read again.
      await page.reload();
      await expect(panel.getByText(MAILING_REQUESTED)).toHaveCount(0);

      // --- and it is asked for again -----------------------------------------
      await requestTheMailing(request, item.id);
      await page.reload();
      await expect(panel.getByText(MAILING_REQUESTED)).toBeVisible();

      /*
       * The heart of it: two requests have been placed and one dismissed, and
       * nothing has reached a member. Asking is not sending, and the only thing
       * that sends is the act below.
       */
      await expectNothingSentAbout(ITEM.title);

      // --- a board member answers it, the only way there is -------------------
      await panel
        .getByRole("radio", { name: "Medlemmarna", exact: true })
        .check();
      // Left as the screen offers it. There is no second way to send: the answer
      // to a request is the publish the board already does, with the mailing
      // where it already stands.
      await expect(
        panel.getByRole("checkbox", { name: /^Mejla medlemmarna/ }),
      ).toBeChecked();
      await panel
        .getByRole("button", { name: "Publicera", exact: true })
        .click();
      await expect(
        panel.getByText(/Nyheten är publicerad och är på väg till \d+ medlem/),
      ).toBeVisible();

      // The request has been answered, so the notice goes - and stays gone when
      // the screen reads the item again.
      await expect(panel.getByText(MAILING_REQUESTED)).toHaveCount(0);
      await page.reload();
      await expect(panel.getByText(MAILING_REQUESTED)).toHaveCount(0);

      /*
       * Claimed, once and for good. The screen no longer offers the mailing at
       * all and says so in words, because the column the server writes here is
       * never cleared: there is no second mailing left to ask for or to make.
       */
      await expect(panel.getByText("En nyhet mejlas en gång.")).toBeVisible();
      await expect(
        panel.getByRole("checkbox", { name: /^Mejla medlemmarna/ }),
      ).toHaveCount(0);

      const mailed = await newsBySlug(request, ITEM.slug);
      expect(mailed.emailQueuedAt).not.toBeNull();

      // Asking again is refused on those grounds, in the API's own vocabulary.
      const late = await request.post(
        `${stack.baseUrl}/api/news/${item.id}/mailing-request`,
        { failOnStatusCode: false },
      );
      expect(late.status()).toBe(422);
      expect(((await late.json()) as { reason?: string }).reason).toBe(
        "already-mailed",
      );

      // And in the mailbox, where the promise is actually kept: one message
      // about this notice, and one only.
      const delivered = await waitForMessage(MEMBER_EMAIL, {
        subjectMatch: new RegExp(ITEM.title),
      });
      expect(delivered.text).toContain(ITEM.paragraph);

      const hers = (await mailingsAbout(ITEM.title)).filter((message) =>
        message.To.some((to) => to.Address.toLowerCase() === MEMBER_EMAIL),
      );
      expect(hers).toHaveLength(1);
    } finally {
      // The notice leaves the website with the row, and the instance is left as
      // the specs before this one wrote it.
      if (written !== null) {
        await request.delete(`${stack.baseUrl}/api/news/${written}`, {
          failOnStatusCode: false,
        });
      }
    }
  });

  test("the catalogue names what a connected app may ask for, and no consent", async ({
    api: request,
  }) => {
    await ensureInstance(request);

    /*
     * The language named on the request rather than left to the default. The
     * catalogue resolves its text server-side - @openbrf/i18n is private, so a
     * connector cannot look a key up for itself - and a run that asked for
     * nothing in particular would be asserting against whatever the default
     * happens to be rather than against the association's own language.
     */
    const listed = await request.get(
      `${stack.baseUrl}/api/actions?surface=mcp`,
      {
        headers: { "accept-language": "sv-SE" },
      },
    );
    expect(listed.status()).toBe(200);

    const { actions } = (await listed.json()) as {
      actions: readonly CatalogueEntry[];
    };

    // The set, both ways round: nothing missing and nothing extra.
    expect(actions.map((action) => action.name).sort()).toEqual(
      [...FIRST_SLICE].sort(),
    );

    for (const action of actions) {
      /*
       * A sentence, not the key i18next falls back to when a string is missing.
       * An unresolved key is the one failure that would reach a connected app
       * looking like a working catalogue, because every other field would be
       * right.
       */
      expect(
        action.title,
        `${action.name} answered with its translation key`,
      ).not.toMatch(LOOKS_LIKE_A_KEY);
    }

    // And the language is the one that was asked for, not the fallback the API
    // is written in.
    expect(actions.find((action) => action.name === "page_update")?.title).toBe(
      "Ändra en sida",
    );

    const described = await request.get(
      `${stack.baseUrl}/api/actions/page_update`,
      { headers: { "accept-language": "sv-SE" } },
    );
    expect(described.status()).toBe(200);

    const { inputSchema } = (await described.json()) as {
      inputSchema: Record<string, unknown>;
    };

    /*
     * A key the document does not declare is refused rather than dropped. A
     * schema that accepted one would promise a caller that it had been stored,
     * and the write would then happen without it.
     */
    expect(inputSchema.additionalProperties).toBe(false);

    /*
     * The revision is required, and this is the one call that claims on it. A
     * save carries the whole page, so two callers who each read it and then
     * wrote would leave the second one's copy standing and the first one's work
     * gone - requiring the number that was read means a model rewriting a page
     * has to read it first.
     */
    expect(inputSchema.required).toContain("expectedRevision");

    /*
     * And nowhere in the document, at any depth, is the attestation. A board
     * member confirms in the web interface that the identifiable people in a
     * photograph have consented to being published; an input offering the field
     * would let a caller holding a token assert it on their behalf, and the
     * page would go up. Left out, the strict object above answers 400 to a
     * caller that invents it.
     */
    expect(JSON.stringify(inputSchema)).not.toContain("photoConsentConfirmed");
  });
});
