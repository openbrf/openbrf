import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { createPerson, listAddresses, listApartments, moveIn } from "./api";
import { grantBoardSeat } from "./board";
import { clientAddressFor, expect, stack } from "./fixtures";
import { uniqueEmail, uniqueSurname } from "./identity";
import { ensureAccountFor } from "./provision";
import { appPath } from "./stack";

/**
 * What the feed's specs share: the people they invent, signing them in, and
 * the screen's own controls by the names a reader is given.
 *
 * Three specs drive the feed - the board's audience (40), a group (43) and the
 * house (46) - and each needs the same handful of acts. Kept here rather than
 * copied three times, because a control renamed on the screen is then renamed
 * in one place and every spec follows.
 */

/** Somebody a feed spec made: who they are, and how they sign in. */
export interface FeedPerson {
  personId: string;
  email: string;
  name: string;
  password: string;
}

/** Fills in the sign-in form on screen and waits for the answer. */
async function submitSignIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  // exact, because "Logga in" is a prefix of the passkey button's
  // "Logga in med en nyckel" and the accessible-name match is a substring one.
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
}

/** Signs in through the screen, from a browser holding no session. */
export async function signInThroughTheScreen(
  page: Page,
  person: { email: string; password: string },
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await submitSignIn(page, person.email, person.password);
  await expect(page).not.toHaveURL(/\/sign-in(\?|$)/);
}

/**
 * Puts this browser on one person's own client address.
 *
 * The sign-in endpoints are rate-limited per client address, and the people a
 * spec signs in would in life sign in from homes of their own: sharing one
 * address makes the suite throttle itself.
 */
export async function browseAs(
  page: Page,
  clientAddress: string,
  persona: string,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
}

/**
 * Somebody who lives here, created and moved in by the spec.
 *
 * A residency is what Alla and a place in a group rest on, and the move-in path
 * is the one that writes one. Nothing in this suite can delete a person again -
 * the member register is append-only by design - so the name and the address are
 * unique to this run.
 */
export async function ensureResident(
  request: APIRequestContext,
  input: {
    firstName: string;
    local: string;
    clientAddress: string;
    password: string;
  },
): Promise<FeedPerson> {
  const addresses = await listAddresses(request, stack.baseUrl);
  const address = addresses[0];
  if (address === undefined) {
    throw new Error("the instance has no address to move anybody into");
  }
  const apartments = await listApartments(request, stack.baseUrl, address.id);
  const apartment = apartments[0];
  if (apartment === undefined) {
    throw new Error("the instance has no apartment to move anybody into");
  }

  const lastName = uniqueSurname("Krattan");
  const email = uniqueEmail(input.local);
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: input.firstName,
    lastName,
    email,
  });
  await moveIn(request, stack.baseUrl, {
    personId,
    apartmentId: apartment.id,
    role: "RESIDENT",
    movedInOn: "2026-01-01",
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: input.password,
    clientAddress: input.clientAddress,
  });

  return {
    personId,
    email,
    name: `${input.firstName} ${lastName}`,
    password: input.password,
  };
}

/**
 * A person on the board and nowhere else: a seat and no home here.
 *
 * A person needs no apartment, no residency and no membership to hold a seat,
 * which is what lets a cooperative seat an external board member at all. Created
 * by the spec rather than borrowed: specs 24, 27 and 35 put the shared
 * administrator on the board, so a test built on them would pass or fail on the
 * order the suite happened to run in.
 */
export async function ensureBoardMember(
  request: APIRequestContext,
  input: {
    firstName: string;
    local: string;
    clientAddress: string;
    password: string;
  },
): Promise<FeedPerson> {
  const lastName = uniqueSurname(`Styrelse-${input.local}`);
  const email = uniqueEmail(input.local);
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: input.firstName,
    lastName,
    email,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: input.password,
    clientAddress: input.clientAddress,
  });
  await grantBoardSeat(personId);

  return {
    personId,
    email,
    name: `${input.firstName} ${lastName}`,
    password: input.password,
  };
}

/**
 * Opens the feed and answers the audiences the screen was given.
 *
 * Read off the request the screen itself makes on opening, armed before the
 * navigation so the answer cannot arrive before anything is listening for it.
 * The list is the claim: an audience missing from the screen could be one the
 * screen had not drawn yet, and one missing from what it was sent cannot be
 * drawn at all.
 */
export async function openFeed(
  page: Page,
): Promise<{ id: string; kind: string; name: string | null }[]> {
  const listed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/feed/audiences",
  );
  await page.goto(appPath("/feed"));
  const response = await listed;
  expect(response.ok()).toBe(true);
  const { audiences } = (await response.json()) as {
    audiences: { id: string; kind: string; name: string | null }[];
  };
  return audiences;
}

/** The identifier of the audience of a kind, or of a group by name. */
export async function audienceId(
  page: Page,
  which: { kind: "ALL" | "BOARD" } | { group: string },
): Promise<string> {
  const response = await page.request.get(
    `${stack.baseUrl}/api/feed/audiences`,
  );
  expect(response.ok()).toBe(true);
  const { audiences } = (await response.json()) as {
    audiences: { id: string; kind: string; name: string | null }[];
  };
  const found = audiences.find((audience) =>
    "kind" in which
      ? audience.kind === which.kind
      : audience.kind === "GROUP" && audience.name === which.group,
  );
  if (found === undefined) {
    throw new Error(`this account is in no audience ${JSON.stringify(which)}`);
  }
  return found.id;
}

/**
 * The audience in the panel on the side, by its name.
 *
 * Anchored at the start, because the button's name goes on with what is unread
 * in it ("Styrelsen 3 olästa inlägg"), and scoped to the panel's own landmark,
 * because a board post's ⋯ is named after Styrelsen too.
 */
export function audienceButton(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Målgrupper" })
    .getByRole("button", { name: new RegExp(`^${escaped(name)}`) });
}

/** The post on screen whose card carries this text. */
export function postCard(page: Page, text: string): Locator {
  return page.getByRole("article").filter({ hasText: text });
}

/**
 * Writes a post through the composer, to whichever audience is open, and waits
 * until the feed has read it back.
 */
export async function writePostThroughTheScreen(
  page: Page,
  text: string,
  images: readonly { name: string; buffer: Buffer }[] = [],
): Promise<void> {
  await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
  const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
  await dialog.getByLabel("Text").fill(text);
  if (images.length > 0) {
    await dialog.getByLabel("Bifoga bilder").setInputFiles(
      images.map((image) => ({
        name: image.name,
        mimeType: "image/png",
        buffer: image.buffer,
      })),
    );
    await expect(dialog.getByText("Klar")).toHaveCount(images.length);
  }
  await dialog.getByRole("button", { name: "Skapa" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(postCard(page, text)).toBeVisible();
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
