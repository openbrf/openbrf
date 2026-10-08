import { createHash, randomBytes } from "node:crypto";

import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { jsonBodyOrNothing } from "../src/api";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { goToDestination, offeredDestinations } from "../src/navigation";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * How a member points an external program at their own instance, as far as a
 * deployed one can show it.
 *
 * Not one of the numbered exit criteria. What is here is the half of the
 * arrangement that only exists once the image is running and serving one
 * origin: the documents a client reads before it holds anything at all, the
 * two screens the association answers through afterwards, and the hop through
 * sign-in that carries a person back to the address they asked for.
 *
 * The other half - a token presented on the resource route and accepted or
 * refused there - is deliberately absent, because this stack cannot reach it.
 * The resource is a connector plugin's own route; no plugin is installed here,
 * so none declares one, the guard's Bearer branch is never installed and no
 * path on this instance is Bearer-only. A test written against that branch
 * would be asserting about code the deployed image did not load.
 * `apps/api/src/plugins/plugin-http.int-spec.ts` exercises it against a plugin
 * that really is installed and really does serve the route.
 *
 * What is left is what nothing but a served origin reaches.
 *
 * The discovery documents answer at the root of the origin, over HTTP, to a
 * caller holding no session. RFC 8414 and RFC 9728 fix them at the root, and
 * the sign-in library is mounted under a base path, so where they answer from
 * is a property of the origin rather than of a handler - which an injected
 * request cannot tell apart. Needing no session is the same kind of fact: a
 * client fetches them before any token exists, so requiring one would be a
 * loop.
 *
 * The OpenID alias answers a refusal a client can read. An unclaimed path at
 * this root is answered by the association's own website with its not-found
 * page, and that page carries the same status as the refusal - so the
 * assertion is the contrast between them, and what it guards against is a
 * client parsing a web page as a document.
 *
 * The two screens are where the association answers for what it has let out:
 * a member reading what may act as them, and the board reading every
 * connection on the instance. Both are read empty, because the one test that
 * connects an app comes after them and takes its connection back. What the
 * board's screen can be held to is the address it prints, which has to be the
 * one the discovery document names, and which of its controls each seat is
 * offered.
 *
 * Then the sign-in hop, which is not about connected apps at all. A guarded
 * route turns a visitor with no session away before its screen renders, and
 * the address they asked for is lost unless it travels with them: every deep
 * link in the product was otherwise exchanged for the start page by the act of
 * signing in. It travels in the query string, which is a value whoever wrote
 * the link chose, so both halves are here - the address is honoured, and one
 * naming another host is not.
 *
 * Last, connecting an app the way a member does it: sent to the instance by
 * the app, through the sign-in screen to the consent screen, and back to the
 * app with a code. The signed request rides in the query string across two
 * document loads and a router that rewrites the address bar on each of them,
 * which only a browser reaches - and a request altered on the way is refused
 * on the same screen.
 */

test.describe.configure({ mode: "serial" });

/**
 * The resource an instance with no connector advertises, and the audience of
 * every token it would issue.
 *
 * Written out rather than read back from the instance, for the reason spec 36
 * writes out the action names: a value read from the instance would only
 * assert that the instance agrees with itself. This is the address a client is
 * promised, and the one the board's screen tells an administrator to configure
 * an app with.
 *
 * It is a plugin mount even though no plugin serves it. Core mounts no MCP
 * route, so a default under the sign-in library's own base would name a path
 * that is not a connector's and could never become one.
 */
const RESOURCE_PATH = "/api/plugin/mcp-connector/mcp";
const RESOURCE_URL = `${stack.baseUrl}${RESOURCE_PATH}`;

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this file's own invention would fail that probe,
 * fall through to an invitation, and be refused for an account that already
 * exists.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * From the shared fixture: 14/1001, and on no board.
 *
 * An ordinary member is the reader this file needs, because the association's
 * list of connections is refused to somebody holding neither the capability to
 * read it nor the one to cut a connection on it. Karl Berg rather than Astrid
 * Lindqvist, who holds a seat below, or Nils Lindqvist, who is recorded a
 * resident: what is being shown is that a member with nothing wrong with their
 * standing is still not the board.
 */
const ORDINARY_MEMBER = {
  name: "Karl Berg",
  email: "karl@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * From the shared fixture, with a seat on the board.
 *
 * The seat is granted here rather than relied on from the spec that first
 * granted it - nothing in phase 1 elects anybody, so it is written straight to
 * the database, idempotently and under an identifier derived from the person.
 * She is the one persona who reads the association's connections without being
 * able to reconfigure the instance, which is the split the board's screen is
 * built around.
 */
const ELECTED = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/** The card a heading of this name sits in, whichever screen carries it. */
function panel(page: Page, heading: string): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: heading, exact: true, level: 2 }),
  });
}

/**
 * Fills in the sign-in form that is already on screen and waits for the answer.
 *
 * Separate from the navigation below because one test arrives at this form by
 * being turned away from somewhere else, and what it is about is where the
 * sign-in then goes. Clicking only starts the request, so a caller that acted
 * on the next line would cancel it in flight and the route guard would put the
 * form back.
 */
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

/**
 * Signs in through the screen, from a browser holding no session.
 *
 * The cookies go first because these tests act as more than one person on one
 * page, and a second call would otherwise arrive still carrying the first
 * person's session - which the sign-in route sends away from the form this is
 * about to fill in.
 */
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
 * A fixture person, with an account they can sign in with.
 *
 * Narrowed here rather than read through `?.` at the call sites: a run whose
 * register is missing somebody has to fail on the line that says so, rather
 * than several assertions later on a sign-in that was never going to work.
 */
async function ensureFixtureAccount(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
  person: { name: string; email: string; password: string },
  clientAddress: string,
): Promise<string> {
  const personId = people.get(person.name);
  if (personId === undefined) {
    throw new Error(`${person.name} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId,
    email: person.email,
    password: person.password,
    clientAddress,
  });
  return personId;
}

/** What `returnTo` the sign-in screen was reached with, if any. */
function returnToOn(page: Page): string | null {
  return new URL(page.url()).searchParams.get("returnTo");
}

/**
 * Where the app in the last test is answered.
 *
 * On this machine, which is the one kind of address a client may be given
 * over plain HTTP, and nothing listens at it: the test answers it itself.
 */
const APP_CALLBACK = "http://127.0.0.1:8123/cb";

/**
 * The address an app sends a member to, to ask whether it may act for them.
 *
 * Composed the way a client composes it, with a fresh PKCE challenge each
 * time. The verifier is not kept: these tests stop at the code arriving, and
 * exchanging it is the integration suite's (oauth-client-registration).
 */
function authorizeAddress(clientId: string, state: string): string {
  const verifier = randomBytes(32).toString("base64url");
  return `${stack.baseUrl}/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: APP_CALLBACK,
    scope: "mcp:read",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE_URL,
  }).toString()}`;
}

/**
 * Says yes on the consent screen that is on screen.
 *
 * The acknowledgement is checked first because the button does nothing
 * without it, and waiting for it is also waiting for the screen to have read
 * who is asking.
 */
async function connect(page: Page): Promise<void> {
  await page
    .getByRole("checkbox", {
      name: "Jag har läst vad appen skulle kunna göra och vill koppla den till mitt konto.",
    })
    .check();
  await page.getByRole("button", { name: "Koppla appen", exact: true }).click();
}

/**
 * Waits for the browser to be handed back to the app, and reads the answer.
 *
 * An assertion rather than a wait, so a consent the instance refused fails
 * here, naming the consent screen it stayed on, instead of running the test
 * out of time - which would also close the browser before the test could take
 * its app back.
 */
async function landedOnTheApp(page: Page): Promise<URL> {
  await expect(page, "the consent did not hand the browser back").toHaveURL(
    (url) => url.href.startsWith(`${APP_CALLBACK}?`),
  );
  return new URL(page.url());
}

test.describe("signing an MCP client in", () => {
  test("the discovery documents answer at the root of the origin, to a caller with no session", async ({
    api: request,
  }) => {
    /*
     * The context this test holds has never signed in, and this is what says
     * so. A public document answering 200 means nothing unless the caller
     * could have been refused and was not, so an ordinary guarded route is
     * asked first, from the same context and the same cookie jar.
     */
    const guarded = await request.get(`${stack.baseUrl}/api/connected-apps`, {
      failOnStatusCode: false,
    });
    expect(
      guarded.status(),
      "this caller holds a session, so the documents below prove nothing",
    ).toBe(401);

    const server = await request.get(
      `${stack.baseUrl}/.well-known/oauth-authorization-server`,
      { failOnStatusCode: false },
    );
    expect(server.status()).toBe(200);
    expect(server.headers()["content-type"]).toContain("application/json");
    /*
     * And it starts nothing. A discovery document is fetched by a program that
     * holds no account here, so a response that set a session cookie would be
     * handing one to a caller that never asked for it.
     */
    expect(server.headers()["set-cookie"]).toBeUndefined();

    const named =
      ((await server.json()) as { token_endpoint?: string }).token_endpoint ??
      "";
    expect(
      named,
      "the authorization server document names no token endpoint",
    ).not.toBe("");

    /*
     * Where a client sends the code it was given in exchange for a credential,
     * so the one thing that has to be true of it is that it is this instance.
     * A document naming another origin would send a member's authorization
     * somewhere else entirely, and every field around it would still read as a
     * working document.
     */
    const tokenEndpoint = new URL(named);
    expect(tokenEndpoint.origin).toBe(new URL(stack.baseUrl).origin);
    expect(tokenEndpoint.pathname).toMatch(/\/oauth2\/token$/);

    /*
     * The resource document at both forms of the path. A client is given one
     * of two things and has to arrive at the same place from either: the
     * origin on its own, which is what a member types, or the route named in
     * the challenge a refused call answers with.
     */
    for (const path of [
      "/.well-known/oauth-protected-resource",
      `/.well-known/oauth-protected-resource${RESOURCE_PATH}`,
    ]) {
      const resource = await request.get(`${stack.baseUrl}${path}`, {
        failOnStatusCode: false,
      });
      expect(resource.status(), path).toBe(200);
      expect(resource.headers()["content-type"], path).toContain(
        "application/json",
      );
      expect(resource.headers()["set-cookie"], path).toBeUndefined();

      /*
       * The audience every token would be bound to, and the same one from
       * either path. It is a connector's own route: a document naming a path
       * under the sign-in library's base would name something no plugin can
       * ever serve, and every token issued for it would be worth nothing.
       */
      expect(
        ((await resource.json()) as { resource?: string }).resource,
        path,
      ).toBe(RESOURCE_URL);
    }
  });

  test("the OpenID alias is refused as a document, not as the association's not-found page", async ({
    api: request,
  }) => {
    /*
     * This instance is an OAuth authorization server and not an OpenID
     * provider: no identity scope is offered, no id token is issued, and a
     * connected app is never told whose account it acts for. So the refusal is
     * the correct answer, and what matters is that it is a refusal a program
     * can read.
     */
    const refused = await request.get(
      `${stack.baseUrl}/.well-known/openid-configuration`,
      { failOnStatusCode: false },
    );
    expect(refused.status()).toBe(404);
    expect(refused.headers()["content-type"]).toContain("application/json");
    expect(
      jsonBodyOrNothing(await refused.text()),
      "the refusal has no body a client can parse",
    ).not.toEqual({});

    /*
     * The contrast is the whole assertion. A path at this root that no route
     * claims falls through to the association's own website, which answers
     * with its not-found page - the same status, in HTML. Without the route
     * above, that page is what a client asking for the OpenID document would
     * receive, and a client parsing it would be reading a web page as
     * configuration.
     */
    const unclaimed = await request.get(
      `${stack.baseUrl}/.well-known/oauth-nothing-serves-this`,
      { failOnStatusCode: false },
    );
    expect(unclaimed.status()).toBe(404);
    expect(unclaimed.headers()["content-type"]).toContain("text/html");
  });

  test("a member reads their own connected apps, and the association's list is not theirs", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    const persona = clientAddressFor(clientAddress, "member");
    await ensureFixtureAccount(request, people, ORDINARY_MEMBER, persona);

    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(
      page,
      ORDINARY_MEMBER.email,
      ORDINARY_MEMBER.password,
    );

    // --- what he has let act as him, where the other ways in already are ---
    await page.goto(appPath("/settings"));
    const own = panel(page, "Anslutna appar");

    /*
     * The sentence rather than the heading. A card renders before the request
     * that fills it comes back, so the heading is on screen while the answer
     * is still in flight; this sentence exists only once his own list has been
     * read and is empty.
     */
    await expect(
      own.getByText("Du har inte anslutit någon app."),
    ).toBeVisible();

    /*
     * And it is his rather than the association's, which is the distinction
     * the two screens exist to keep: this card says what he has let act in his
     * stead, and needs no capability at all - a member who can let an app act
     * for them must not need the board in order to take it back.
     */
    await expect(own).toContainText(
      "Program du har låtit agera i ditt ställe.",
    );

    /*
     * Both halves of the refusal, as spec 30 writes them. The navigation does
     * not offer the destination, because a link to a screen that can only turn
     * somebody away teaches them a part of the product is broken for them. And
     * the screen itself, asked for by hand, which is the assertion that would
     * still hold if the navigation were rebuilt tomorrow. The navigation is
     * read from every section, after something he is offered, so the absence
     * is the whole offer's.
     */
    await expect
      .poll(() => offeredDestinations(page))
      .toContain("Inställningar");
    expect(await offeredDestinations(page)).not.toContain("Anslutna appar");

    await page.goto(appPath("/connected-apps"));
    await expect(
      page.getByRole("heading", { name: "Anslutna appar", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Ditt konto får inte se den här sidan."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Anslutningar i föreningen" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Registrera en app" }),
    ).toHaveCount(0);

    /*
     * The refusal is the server's and not the screen's. Hiding a control is
     * courtesy; what stops a member reading who else in the association has
     * connected something is the endpoint, asked here with his own session
     * from the browser holding it.
     *
     * On the capability rather than on the number alone: 403 is also what a
     * request refused for some other reason would answer, and a refusal that
     * had stopped being about `association:read` would be a different rule
     * wearing the same status.
     */
    const listed = await page.request.get(
      `${stack.baseUrl}/api/connected-apps`,
      { failOnStatusCode: false },
    );
    expect(listed.status()).toBe(403);
    expect(((await listed.json()) as { message?: string }).message).toContain(
      "association:read",
    );
  });

  test("the board reads every connection on the instance, and only an administrator may register a client", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    const seated = await ensureFixtureAccount(
      request,
      people,
      ELECTED,
      clientAddressFor(clientAddress, "elected"),
    );
    await grantBoardSeat(seated);

    // --- the administrator, who answers for how the instance is configured --
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    // Reached the way a board member reaches it: through the settings
    // section's sign.
    await goToDestination(page, "Anslutna appar");
    await expect(
      page.getByRole("heading", { name: "Anslutna appar", level: 1 }),
    ).toBeVisible();

    /*
     * Empty, and that is the honest picture of this screen on an instance
     * where nothing has been connected: the test at the end of this file that
     * connects an app takes the connection back again. So the sentence saying
     * nobody has connected anything is both what a board first meets here and
     * the marker that the list has actually been read.
     */
    const listed = panel(page, "Anslutningar i föreningen");
    await expect(
      listed.getByText("Ingen i föreningen har anslutit någon app."),
    ).toBeVisible();

    /*
     * The address an app has to ask for, printed for whoever configures one.
     * It is the same value the resource document names, which is the property
     * worth holding: the screen reads that document over the origin's own
     * root, so a document that moved, stopped being public or started naming
     * something else would leave an administrator copying an address no token
     * can be issued for.
     */
    const registration = panel(page, "Registrera en app");
    await expect(registration.getByText(RESOURCE_URL)).toBeVisible();

    // --- and an elected seat, which reads the same list ---------------------
    await browseAs(page, clientAddress, "elected");
    await signInThroughTheScreen(page, ELECTED.email, ELECTED.password);

    await page.goto(appPath("/connected-apps"));
    await expect(
      panel(page, "Anslutningar i föreningen").getByText(
        "Ingen i föreningen har anslutit någon app.",
      ),
    ).toBeVisible();

    /*
     * Without the panel above. Seeing what leaves the association comes with
     * the seat; minting a credential changes how the instance is configured
     * and stays with an administrator, so the screen offers one seat a control
     * the other is not shown - and the endpoint refuses it either way.
     */
    await expect(
      page.getByRole("heading", { name: "Registrera en app" }),
    ).toHaveCount(0);
    const refused = await page.request.post(
      `${stack.baseUrl}/api/oauth-clients`,
      {
        data: {
          clientName: "Nagot foreningen latit skriva",
          redirectUris: ["https://exempel.test/aterkoppling"],
        },
        failOnStatusCode: false,
      },
    );
    expect(refused.status()).toBe(403);
    // Named, so the refusal is the capability and not a body this seat sent
    // wrongly or a rule that has quietly become a different one.
    expect(((await refused.json()) as { message?: string }).message).toContain(
      "association:manage",
    );
  });

  test("signing in lands on the address that was asked for, and never on another origin", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    await ensureFixtureAccount(
      request,
      people,
      ORDINARY_MEMBER,
      clientAddressFor(clientAddress, "deep-link"),
    );

    // --- a guarded address, asked for by somebody with no session ----------
    await browseAs(page, clientAddress, "deep-link");
    await page.context().clearCookies();
    await page.goto(appPath("/settings"));

    /*
     * Turned away before the screen renders, and the address goes with them.
     * The value is the path inside this application rather than the whole URL:
     * the prefix the client is served under is a rewrite the router strips on
     * the way in and puts back on the way out.
     */
    await expect(page).toHaveURL(/\/app\/sign-in\?/);
    expect(returnToOn(page)).toBe("/settings");

    await submitSignIn(page, ORDINARY_MEMBER.email, ORDINARY_MEMBER.password);

    /*
     * And it is honoured. This is the whole of the defect: without it every
     * deep link in the product - a document, a booking, a thread - is
     * exchanged for the start page by the act of signing in, and the person
     * has to go and find the link again.
     */
    await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/settings")}`);
    await expect(
      page.getByRole("heading", { name: "Inställningar", level: 1 }),
    ).toBeVisible();

    // --- and an address on somebody else's host ---------------------------
    /*
     * The value travels in the query string, so it is chosen by whoever wrote
     * the link rather than by this application. An address on another host,
     * reached through this cooperative's own sign-in screen, is a credible
     * place to ask a member for the password they have just typed once
     * already - so a value that is not a path inside this application is
     * refused outright rather than repaired.
     */
    await browseAs(page, clientAddress, "open-redirect");
    await page.context().clearCookies();
    await page.goto(
      `${appPath("/sign-in")}?returnTo=${encodeURIComponent("//example.test/logga-in")}`,
    );
    await submitSignIn(page, ORDINARY_MEMBER.email, ORDINARY_MEMBER.password);

    await expect(page).toHaveURL(/\/app\/?$/);
    expect(new URL(page.url()).origin, "the sign-in left this instance").toBe(
      new URL(stack.baseUrl).origin,
    );

    // --- the consent screen, opened on its own ----------------------------
    /*
     * Reached with no session and no request: the sign-in that was meant to
     * come first has lapsed, or the address was opened by hand. It is a
     * guarded route like any other, so the answer is the sign-in screen rather
     * than a consent screen rendered to nobody.
     */
    await page.context().clearCookies();
    await page.goto(appPath("/oauth/consent"));
    await expect(page).toHaveURL(/\/app\/sign-in\?/);
    expect(returnToOn(page)).toBe("/oauth/consent");
  });

  test("a member connects an app at the browser, and a request altered on the way is refused", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    await ensureFixtureAccount(
      request,
      people,
      ORDINARY_MEMBER,
      clientAddressFor(clientAddress, "connecting"),
    );

    // --- an app the association has let in -------------------------------
    // Registered by the administrator the register fixture signed in.
    const registered = await request.post(
      `${stack.baseUrl}/api/oauth-clients`,
      {
        data: {
          clientName: "Karls kalenderapp",
          redirectUris: [APP_CALLBACK],
        },
        failOnStatusCode: false,
      },
    );
    expect(registered.status()).toBe(201);
    const { clientId } = (await registered.json()) as { clientId: string };

    try {
      /*
       * Nothing listens at the app's address, which is on this machine the way
       * a desktop app's is. Answering it here is what lets the browser arrive
       * there, and arriving there with a code is the assertion.
       */
      await page.route(`${APP_CALLBACK}**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
      );

      // --- asked through the sign-in screen ---------------------------------
      /*
       * The way an app sends somebody who is not signed in: to the
       * authorization endpoint, which sends them to sign in and then to the
       * consent screen, carrying the signed request in the query string the
       * whole way. Both hops are document loads, and on both the router
       * rewrites the address bar into its own spelling of the request as it
       * mounts - which is the defect this test is here for. Before the
       * screens read the request as the page was loaded with it, the consent
       * was refused as altered on every browser, every time.
       */
      await browseAs(page, clientAddress, "connecting");
      await page.context().clearCookies();
      await page.goto(authorizeAddress(clientId, "forsta-gangen"));
      await expect(page).toHaveURL(/\/app\/sign-in\?/);

      await submitSignIn(page, ORDINARY_MEMBER.email, ORDINARY_MEMBER.password);
      await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);

      await connect(page);
      const back = await landedOnTheApp(page);
      expect(back.searchParams.get("state")).toBe("forsta-gangen");
      expect(back.searchParams.get("code")).toMatch(/\S/);

      // And the connection is his, recorded where he can take it back.
      const mine = await page.request.get(
        `${stack.baseUrl}/api/connected-apps/mine`,
      );
      expect(mine.status()).toBe(200);
      const { connectedApps } = (await mine.json()) as {
        connectedApps: { clientId: string }[];
      };
      expect(connectedApps.map((app) => app.clientId)).toContain(clientId);

      /*
       * Taken back, so the app has to ask again: an app that already holds a
       * consent is handed a code without the screen, and what follows needs
       * the screen.
       */
      const disconnected = await page.request.delete(
        `${stack.baseUrl}/api/connected-apps/mine/${encodeURIComponent(clientId)}`,
      );
      expect(disconnected.status()).toBe(200);

      // --- asked again, and the request altered on the way -----------------
      /*
       * Signed in this time, so the authorization endpoint answers with the
       * consent screen directly. Its answer is read rather than followed, so
       * the request is in hand as the instance wrote it and can be altered by
       * one value before the browser is pointed at it. The state is one of
       * the parameters the signature covers.
       */
      const asked = await page.request.get(
        authorizeAddress(clientId, "andra-gangen"),
        { maxRedirects: 0 },
      );
      expect(asked.status()).toBe(302);
      const consent = new URL(asked.headers()["location"] ?? "", stack.baseUrl);
      expect(consent.pathname).toBe(appPath("/oauth/consent"));
      const signedState = /([?&])state=andra-gangen(?=&|$)/;
      expect(consent.search).toMatch(signedState);

      const altered = consent.href.replace(signedState, "$1state=nagon-annans");
      await page.goto(altered);
      await connect(page);
      await expect(
        page.getByText(
          "Appens begäran har ändrats på vägen hit och går inte att lita på.",
        ),
      ).toBeVisible();
      expect(page.url().startsWith(APP_CALLBACK)).toBe(false);

      // --- and the same request as it was written ---------------------------
      /*
       * Opened straight from the instance's answer, with no sign-in screen in
       * between: the one hop left that the request has to survive is the
       * consent screen's own load.
       */
      await page.goto(consent.href);
      await connect(page);
      const again = await landedOnTheApp(page);
      expect(again.searchParams.get("state")).toBe("andra-gangen");
      expect(again.searchParams.get("code")).toMatch(/\S/);
    } finally {
      /*
       * Turned away for the instance, which cuts every connection to it: the
       * screens earlier in this file read "nobody has connected anything", and
       * on a reused stack that has to stay true on the next run.
       */
      const removed = await request.delete(
        `${stack.baseUrl}/api/oauth-clients/${encodeURIComponent(clientId)}`,
        { failOnStatusCode: false },
      );
      expect(removed.status()).toBe(200);
    }
  });
});
