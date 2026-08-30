import * as api from "../src/api";
import { grantBoardSeat } from "../src/board";
import {
  documentFixture,
  fileDocument,
  removeDocument,
} from "../src/documents";
import { expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import { ADMINISTRATOR, ensureRegisterFixture } from "../src/provision";

/**
 * The four blocks that put what the instance already holds on a page.
 *
 * Not one of the numbered exit criteria. It is here because two of these
 * blocks make a promise no unit test can hold them to: what a real browser,
 * with no account and no cookie, is served at a real address.
 *
 * The document list follows the archive rather than the page. A page anybody
 * can open lists the public shelf to a visitor and never the members'
 * - so the block cannot become a way around the archive by being put on the
 * wrong page.
 *
 * The board roster follows each person's own publication consent
 * (publiceringssamtycke). A board member who has given one is named; one who
 * has not is absent from the page, not greyed out and not initialled. Both
 * people below hold a seat, so what tells them apart in the rendered page is
 * the consent and nothing else.
 *
 * The association facts and the questions are the two that carry no rule about
 * people, and they are asserted here for one thing each: that the facts on an
 * ordinary page are the same recorded facts the broker page is generated from,
 * and that a FAQ is the board's own writing with no second screen behind it.
 *
 * The labels are Swedish because the website renders its chrome in the
 * visitor's own language and the suite's browser context asks for Swedish.
 */

test.describe.configure({ mode: "serial" });

/** This run's own page, documents and questions, so a rerun reads its own rows. */
const SLUG = `om-foreningen-${uniqueSurname("b").toLowerCase()}`;
const PUBLISHED_DOCUMENT = documentFixture({
  title: "Stadgar",
  category: `Stadgar ${uniqueSurname("p")}`,
});
const MEMBERS_DOCUMENT = documentFixture({
  title: "Stämmoprotokoll",
  category: `Protokoll ${uniqueSurname("m")}`,
});

const QUESTION = `Var finns tvättstugan, ${uniqueSurname("fraga")}?`;
const ANSWER = `I källaren i port 12, ${uniqueSurname("svar")}.`;
const BUILD_YEAR = 1948;

/** The board member who has agreed to be named, and the one who has not. */
const CONSENTED = ADMINISTRATOR;
const SILENT = { firstName: "Astrid", lastName: "Lindqvist" } as const;

test("a visitor reads what the association publishes and nothing else", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);

  const consentedId = await requirePerson(
    request,
    `${CONSENTED.firstName} ${CONSENTED.lastName}`,
  );
  const silentId = await requirePerson(
    request,
    `${SILENT.firstName} ${SILENT.lastName}`,
  );

  /*
   * Two seats and one consent. Nothing in phase 1 elects anybody, so the seats
   * are written straight to the database; the consent goes through the
   * endpoint the board's own screen uses, because the consent is the thing
   * under test.
   */
  await grantBoardSeat(consentedId);
  await grantBoardSeat(silentId);
  await api.setPublicationConsent(request, stack.baseUrl, consentedId, {
    scope: "BOARD_ROSTER",
    granted: true,
    note: "Sagt vid styrelsemötet.",
  });
  // Explicitly withdrawn rather than merely never granted, which is the harder
  // of the two: the row exists, and it must still keep the name off the page.
  await api.setPublicationConsent(request, stack.baseUrl, silentId, {
    scope: "BOARD_ROSTER",
    granted: false,
  });

  const published = await fileDocument(request, {
    ...PUBLISHED_DOCUMENT,
    audience: "PUBLIC",
  });
  const members = await fileDocument(request, {
    ...MEMBERS_DOCUMENT,
    audience: "MEMBER",
  });

  await api.saveAssociationFacts(request, stack.baseUrl, {
    buildYear: BUILD_YEAR,
  });

  const written = await api.createSitePage(request, stack.baseUrl, {
    slug: SLUG,
    title: "Om föreningen",
    visibility: "PUBLIC",
    blocks: [
      { type: "documentList" },
      { type: "boardRoster" },
      { type: "associationFacts" },
      {
        type: "faq",
        items: [{ question: QUESTION, answer: [{ text: ANSWER }] }],
      },
    ],
  });
  await api.publishSitePage(request, stack.baseUrl, written.id);

  try {
    await page.goto(`/${SLUG}`);

    // The public shelf, and only it. A member-only document on a page anybody
    // can open would be the block becoming a way around the archive.
    await expect(
      page.getByRole("link", { name: PUBLISHED_DOCUMENT.title }),
    ).toBeVisible();
    await expect(page.getByText(MEMBERS_DOCUMENT.title)).toHaveCount(0);

    // The board member who consented, with the seat they hold; the one who did
    // not is absent rather than masked.
    await expect(
      page.getByText(`${CONSENTED.firstName} ${CONSENTED.lastName}`),
    ).toBeVisible();
    await expect(page.getByText("Ordförande").first()).toBeVisible();
    await expect(
      page.getByText(`${SILENT.firstName} ${SILENT.lastName}`),
    ).toHaveCount(0);

    // The same recorded fact the broker page is generated from, on a page the
    // board arranged itself.
    await expect(page.getByText(String(BUILD_YEAR)).first()).toBeVisible();

    // The one block of the four whose content is the board's own writing.
    await expect(page.getByText(QUESTION)).toBeVisible();
    await expect(page.getByText(ANSWER)).toBeVisible();

    // And the promise the whole website makes, on a page that now carries the
    // archive and a person's name: no script, and no cookie.
    const response = await request.get(`${stack.baseUrl}/${SLUG}`);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect((await response.text()).includes("<script")).toBe(false);
  } finally {
    await api.deleteSitePage(request, stack.baseUrl, written.id);
    await removeDocument(request, published.id);
    await removeDocument(request, members.id);
    await api.clearAssociationFacts(request, stack.baseUrl);
  }
});

async function requirePerson(
  request: Parameters<typeof api.findPersonIdByName>[0],
  name: string,
): Promise<string> {
  const id = await api.findPersonIdByName(request, stack.baseUrl, name);
  if (id === undefined) {
    throw new Error(`${name} is not in the address book`);
  }
  return id;
}
