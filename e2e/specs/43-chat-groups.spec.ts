import type { APIRequestContext, Page } from "@playwright/test";

import {
  createPerson,
  listAddresses,
  listApartments,
  moveIn,
} from "../src/api";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { ensureAccountFor, ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * A group chat, as far as a deployed instance can show it.
 *
 * What is here is the half that only exists once the image is serving one origin
 * and three people with real residencies are looking at it.
 *
 * **A resident makes a room the board did not appoint.** No capability beyond
 * the one that opens the endpoints, no approval, no list for the board to read:
 * somebody types a name and the room exists, and a neighbour they pick can read
 * it on the next screen.
 *
 * **A group is invisible to somebody who is not in it.** Asserted against the
 * endpoint rather than the screen, and as an equality rather than a status: the
 * room they are not in and a room that does not exist have to answer with the
 * same body, or the identifier space can be walked to learn what rooms the house
 * has made.
 *
 * **The board reaches the room through one report and nothing else.** A member
 * reports a message, the board reads that message in its queue, strikes it
 * through, and the room loses the text while its author keeps it. That whole
 * path crosses three sessions and two capabilities, which is what makes it a
 * test only a served instance can carry.
 *
 * Deliberately absent: the poll. `specs/40-board-chat.spec.ts` holds the
 * two-browser delivery test, and a second copy of it here would assert the same
 * mechanism against a different room.
 *
 * Every person here is created by this spec. The shared fixture writes
 * residencies and not the member register, and specs 24, 27 and 35 seat the
 * shared administrator - so a test built on either would pass or fail on the
 * order the suite happened to run in.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "krattan-sommaraeng-2026";

interface Neighbour {
  personId: string;
  email: string;
  name: string;
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
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await submitSignIn(page, email, password);
  await expect(page).not.toHaveURL(/\/sign-in(\?|$)/);
}

/** Puts this browser on one person's own client address. */
async function browseAs(
  page: Page,
  clientAddress: string,
  persona: string,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
}

/**
 * Somebody who lives here, created and moved in by this spec.
 *
 * A residency is what a place in a group rests on, and the move-in path is the
 * one that writes one. Nothing in this suite can delete a person again - the
 * member register is append-only by design - so the name and the address are
 * unique to this run.
 */
async function ensureResident(
  request: APIRequestContext,
  input: { firstName: string; local: string; clientAddress: string },
): Promise<Neighbour> {
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
    password: PASSWORD,
    clientAddress: input.clientAddress,
  });

  return { personId, email, name: `${input.firstName} ${lastName}` };
}

/** A board member with a seat and no home here: the moderation half. */
async function ensureBoardMember(
  request: APIRequestContext,
  clientAddress: string,
): Promise<Neighbour> {
  const lastName = uniqueSurname("Styrelse");
  const email = uniqueEmail("gruppchatt-styrelse");
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: "Bo",
    lastName,
    email,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: PASSWORD,
    clientAddress,
  });
  await grantBoardSeat(personId);

  return { personId, email, name: `Bo ${lastName}` };
}

/** The identifier of a room this account is in, by name, read over HTTP. */
async function groupIdNamed(page: Page, name: string): Promise<string> {
  const response = await page.request.get(`${stack.baseUrl}/api/chat`);
  expect(response.ok()).toBe(true);
  const { rooms } = (await response.json()) as {
    rooms: { id: string; kind: string; name: string | null }[];
  };
  const room = rooms.find(
    (each) => each.kind === "GROUP" && each.name === name,
  );
  if (room === undefined) {
    throw new Error(`this account is in no group called ${name}`);
  }
  return room.id;
}

/** One group, made through the screen, with its name unique to this run. */
const GROUP_NAME = `Trädgårdsgruppen ${String(Date.now())}`;

/*
 * The two people the first test makes, held for the tests after it.
 *
 * The file is serial and runs in one worker, so this is the order the tests are
 * written in rather than an assumption about them. A test that finds them
 * missing says so on the line that needs them, which is what a serial file owes
 * the run that failed before it.
 */
let maker: Neighbour | null = null;
let neighbour: Neighbour | null = null;

function made(who: Neighbour | null, what: string): Neighbour {
  if (who === null) {
    throw new Error(`${what} was not created: the first test did not finish`);
  }
  return who;
}

test.describe("a group chat", () => {
  test("is made by a resident, who then puts a neighbour in it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    maker = await ensureResident(request, {
      firstName: "Nils",
      local: "gruppchatt-nils",
      clientAddress: clientAddressFor(clientAddress, "maker"),
    });
    neighbour = await ensureResident(request, {
      firstName: "Astrid",
      local: "gruppchatt-astrid",
      clientAddress: clientAddressFor(clientAddress, "neighbour"),
    });

    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(page, maker.email, PASSWORD);
    await page.goto(appPath("/chat"));

    /*
     * Nobody appoints this room. There is no request to the board, no approval
     * and no capability beyond the one that opened the screen: a name, and the
     * room exists.
     */
    await page.getByLabel("Gruppens namn").fill(GROUP_NAME);
    await page.getByRole("button", { name: "Skapa gruppen" }).click();
    await expect(page.getByRole("heading", { name: GROUP_NAME })).toBeVisible();

    // The picker is the neighbours, searched by name. getByRole for the select,
    // because a label element's text carries every option inside it.
    await page.getByLabel("Sök bland grannarna").fill(neighbour.name);
    const picker = page.getByRole("combobox", { name: "Lägg till någon" });
    // By the person's own identifier rather than by the label the option
    // carries: the label spells the apartment after the name, and a test that
    // matched on it would be asserting how the picker words a row.
    await picker.selectOption(neighbour.personId);
    await page.getByRole("button", { name: "Lägg till", exact: true }).click();

    // The room says who is in it, and who started it. Exact, because the
    // picker below it spells the same name with an apartment after it.
    await expect(page.getByText(neighbour.name, { exact: true })).toBeVisible();
    await expect(page.getByText("Startade gruppen")).toBeVisible();

    // And the neighbour finds the room on their own screen.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, neighbour.email, PASSWORD);
    await page.goto(appPath("/chat"));
    await expect(page.getByRole("heading", { name: GROUP_NAME })).toBeVisible();
  });

  test("is invisible to somebody who is not in it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    const outsider = await ensureResident(request, {
      firstName: "Sven",
      local: "gruppchatt-sven",
      clientAddress: clientAddressFor(clientAddress, "outsider"),
    });

    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(
      page,
      made(maker, "the maker").email,
      PASSWORD,
    );
    const chatId = await groupIdNamed(page, GROUP_NAME);

    await browseAs(page, clientAddress, "outsider");
    await signInThroughTheScreen(page, outsider.email, PASSWORD);
    await page.goto(appPath("/chat"));

    // Not on their screen, and not on the list the screen reads.
    await expect(page.getByRole("heading", { name: GROUP_NAME })).toHaveCount(
      0,
    );

    /*
     * The two answers have to be one answer. A status alone would not be
     * enough: a body that differed would be as good a signal, and either is a
     * way to find out which rooms this house has made.
     */
    const refused = await page.request.get(
      `${stack.baseUrl}/api/chat/${chatId}`,
      { failOnStatusCode: false },
    );
    const absent = await page.request.get(
      `${stack.baseUrl}/api/chat/chat-nothing-at-all`,
      { failOnStatusCode: false },
    );
    expect(refused.status()).toBe(404);
    expect(absent.status()).toBe(refused.status());
    expect(await absent.json()).toEqual(await refused.json());
  });

  test("gives the board one message when somebody in the room reports it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    const board = await ensureBoardMember(
      request,
      clientAddressFor(clientAddress, "board"),
    );

    // --- the neighbour writes something --------------------------------
    const said = `Det har borde ingen skriva. ${String(Date.now())}`;
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(
      page,
      made(neighbour, "the neighbour").email,
      PASSWORD,
    );
    await page.goto(appPath("/chat"));
    await expect(page.getByRole("heading", { name: GROUP_NAME })).toBeVisible();
    await page.getByLabel("Ditt meddelande").fill(said);
    await page.getByRole("button", { name: "Skicka meddelandet" }).click();
    await expect(page.getByText(said)).toBeVisible();

    // --- the maker reports it -------------------------------------------
    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(
      page,
      made(maker, "the maker").email,
      PASSWORD,
    );
    await page.goto(appPath("/chat"));
    await expect(page.getByText(said)).toBeVisible();
    await page.getByRole("button", { name: /^Anmäl meddelandet från/ }).click();
    await page
      .getByLabel("Vad vill du säga om meddelandet?")
      .fill("Det har handlar om min lagenhet.");
    await page.getByRole("button", { name: "Skicka anmälan" }).click();
    await expect(
      page.getByText("Meddelandet är anmält till styrelsen."),
    ).toBeVisible();

    // --- the board reads that message and strikes it through -------------
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, board.email, PASSWORD);
    await page.goto(appPath("/chat"));

    /*
     * The queue is the board's whole way in. The room itself is not on this
     * screen and there is no control that would open it: what is here is the
     * message that was carried out, with the room's name beside it.
     */
    await expect(
      page.getByRole("heading", { name: "Anmälda chattmeddelanden" }),
    ).toBeVisible();
    await expect(page.getByText(said)).toBeVisible();
    await expect(page.getByText(GROUP_NAME)).toBeVisible();
    await page
      .getByRole("button", { name: "Stryk över meddelandet" })
      .first()
      .click();
    await expect(page.getByText("Ingenting är anmält.")).toBeVisible();

    // --- the room loses the text, and its author keeps it ----------------
    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(
      page,
      made(maker, "the maker").email,
      PASSWORD,
    );
    await page.goto(appPath("/chat"));
    await expect(
      page.getByText("Styrelsen har strukit över meddelandet och dolt texten."),
    ).toBeVisible();
    await expect(page.getByText(said)).toHaveCount(0);

    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(
      page,
      made(neighbour, "the neighbour").email,
      PASSWORD,
    );
    await page.goto(appPath("/chat"));
    // A strike is a strike-through and never a disappearance.
    await expect(page.getByText(said)).toBeVisible();
    await expect(page.getByText("Struket")).toBeVisible();
  });
});
