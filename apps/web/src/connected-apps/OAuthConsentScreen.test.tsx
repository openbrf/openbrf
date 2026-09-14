import type { ActionSummary } from "@openbrf/plugin-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { OAuthConsentScreen } from "./OAuthConsentScreen";

/**
 * What a member is given before an external program is allowed to act as them.
 *
 * The screen is the whole of the decision, so four things are held to here.
 *
 * It says who is asking and where the answer goes, as hosts: that is what a
 * member has to recognise, and a full address is longer, less recognisable and
 * easier to hide something in.
 *
 * It states what the app could do as this person right now, and says in as
 * many words that the list is this instant's answer rather than a promise -
 * nothing is snapshotted, so a screen implying otherwise would be describing a
 * mechanism the platform does not have.
 *
 * Nothing is granted until the acknowledgement is actually ticked. A screen
 * that grants on the first press has recorded a consent nobody gave.
 *
 * A request that will not verify ends the flow rather than offering a retry,
 * and never prints the protocol's own word for what was wrong.
 */

const fetchOAuthClient = vi.fn();
const fetchConnectedAppActions = vi.fn();
const grantConsent = vi.fn();

vi.mock("./consent-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./consent-api")>()),
  fetchOAuthClient: (clientId: string) => fetchOAuthClient(clientId) as unknown,
  fetchConnectedAppActions: () => fetchConnectedAppActions() as unknown,
  grantConsent: (query: string) => grantConsent(query) as unknown,
}));

/** Far enough ahead that the request is live whenever this suite runs. */
const LIVE = 4102444800;
const LONG_PAST = 1000000000;

function request(overrides: Record<string, string> = {}): string {
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: "https://app.example/metadata.json",
    redirect_uri: "https://app.example/callback",
    scope: "mcp:read mcp:write",
    exp: String(LIVE),
    sig: "c2lnbmF0dXJl",
    ...overrides,
  });
  return `?${parameters.toString()}`;
}

function action(
  name: string,
  group: string,
  groupTitle: string,
  title: string,
): ActionSummary {
  return {
    name,
    title,
    description: `Vad ${name} gör.`,
    titleKey: `actions.${name}.title`,
    descriptionKey: `actions.${name}.description`,
    group,
    groupTitle,
    groupTitleKey: `actions.group.${group}.title`,
    capability: "news:read",
    effect: "read",
    idempotent: true,
    additive: true,
    needsConfirmation: false,
    openWorld: false,
    personalData: [],
    surfaces: ["mcp"],
    errors: [],
  };
}

const CATALOGUE = [
  action("news_list", "news", "Nyheter", "Lista nyheter"),
  action("news_get", "news", "Nyheter", "Hämta en nyhet"),
  action("page_list", "pages", "Sidor", "Lista sidor"),
];

const CLIENT = {
  client_id: "https://app.example/metadata.json",
  client_name: "Assistenten",
  client_uri: "https://app.example/",
};

function show(
  authorizationRequest = request(),
  handlers: {
    onGranted?: (url: string) => void;
    onLeave?: () => void;
  } = {},
): void {
  render(
    <OAuthConsentScreen
      authorizationRequest={authorizationRequest}
      onGranted={handlers.onGranted ?? vi.fn()}
      onLeave={handlers.onLeave ?? vi.fn()}
    />,
  );
}

/** Ticks the acknowledgement and presses the one primary control. */
async function agree(): Promise<void> {
  const person = userEvent.setup();
  await person.click(screen.getByRole("checkbox"));
  await person.click(screen.getByRole("button", { name: "Koppla appen" }));
}

const form = () => screen.queryByRole("button", { name: "Koppla appen" });

beforeEach(() => {
  fetchOAuthClient.mockReset().mockResolvedValue({ ok: true, value: CLIENT });
  fetchConnectedAppActions.mockReset().mockResolvedValue({
    ok: true,
    value: { ttlMs: 0, cacheScope: "private", actions: CATALOGUE },
  });
  grantConsent.mockReset().mockResolvedValue({
    ok: true,
    value: { redirect: true, url: "https://app.example/callback?code=abc" },
  });
});

describe("while nothing has answered", () => {
  it("says it is reading, in words", async () => {
    fetchConnectedAppActions.mockReturnValue(new Promise(() => undefined));

    show();

    expect(screen.getByRole("status").textContent).toBe(
      "Läser in vad appen skulle kunna göra",
    );
    // Nothing to decide on yet, so there is nothing to press.
    await waitFor(() => {
      expect(form()).toBeNull();
    });
  });
});

describe("a first read that did not answer", () => {
  it("offers the read again rather than ending the flow", async () => {
    fetchConnectedAppActions.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    show();

    expect(
      await screen.findByText(
        "Det gick inte att läsa vad appen skulle kunna göra.",
      ),
    ).toBeTruthy();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Försök igen" }));

    expect(await screen.findByRole("heading", { level: 2 })).toBeTruthy();
    expect(form()).toBeTruthy();
  });
});

describe("the decision itself", () => {
  it("names the app and shows both hosts, never a whole address", async () => {
    show();

    expect(
      await screen.findByText(
        "Assistenten vill kunna göra saker i föreningens system som du.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("app.example")).toHaveLength(2);
    expect(screen.queryByText("https://app.example/callback")).toBeNull();
    expect(screen.queryByText("https://app.example/metadata.json")).toBeNull();
  });

  it("reads a heading in the interface's language, not the one the instance resolved", async () => {
    /*
     * The instance resolves the catalogue against the language the request
     * declared, which is the browser's; this interface renders in the
     * association's. A board member reading Swedish on a machine set to
     * English must not be shown English headings above a Swedish page.
     *
     * The fixture therefore hands back wording the instance "resolved" that
     * the interface would never print, and the assertion is that the key won.
     */
    fetchConnectedAppActions.mockResolvedValue({
      ok: true,
      value: {
        actions: [
          action("news_list", "news", "Resolved elsewhere", "Lista nyheter"),
        ],
      },
    });
    show();

    await screen.findByRole("heading", { name: "Nyheter" });
    expect(screen.queryByText("Resolved elsewhere")).toBeNull();
  });

  it("keeps the instance's wording for a key the interface does not carry", async () => {
    // A plugin's keys live in a namespace the browser loads only when it needs
    // that plugin's view. Its heading still has to read as words.
    fetchConnectedAppActions.mockResolvedValue({
      ok: true,
      value: {
        actions: [
          {
            ...action("brf_thing", "brf", "Tillägget", "Gör saken"),
            groupTitleKey: "plugin-brf:actions.group.brf.title",
            titleKey: "plugin-brf:actions.brf_thing.title",
          },
        ],
      },
    });
    show();

    await screen.findByRole("heading", { name: "Tillägget" });
    // Never the raw key, which is what translating an absent one would print.
    expect(screen.queryByText(/^plugin-brf:/)).toBeNull();
  });

  it("lists what the app could do, one list per group, under a heading", async () => {
    show();

    await screen.findByRole("heading", { name: "Nyheter" });
    expect(screen.getByRole("heading", { name: "Sidor" })).toBeTruthy();
    // The group's own word, never the bare group id the catalogue is keyed on.
    expect(screen.queryByText("news")).toBeNull();
    expect(screen.queryByText("pages")).toBeNull();

    const entries = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(entries).toEqual(["Lista nyheter", "Hämta en nyhet", "Lista sidor"]);
  });

  it("says in as many words that the list is this instant's answer", async () => {
    show();

    expect(
      await screen.findByText(
        "Listan visar vad appen kan göra just nu. Appen agerar som du och kan " +
          "aldrig göra mer än du själv får göra. Slår föreningen på fler " +
          "åtgärder senare når appen även dem. Du kan koppla bort appen när " +
          "som helst under Inställningar, Inloggning och säkerhet.",
      ),
    ).toBeTruthy();
  });

  it("answers 'nothing' rather than going quiet when the person can do nothing", async () => {
    fetchConnectedAppActions.mockResolvedValue({
      ok: true,
      value: { ttlMs: 0, cacheScope: "private", actions: [] },
    });

    show();

    expect(
      await screen.findByText(
        "Ingenting. Med de behörigheter du har i dag finns det inget en app kan göra åt dig.",
      ),
    ).toBeTruthy();
  });

  it("grants nothing until the acknowledgement is ticked", async () => {
    show();

    const button = await screen.findByRole("button", { name: "Koppla appen" });
    expect(button).toHaveProperty("disabled", true);

    await userEvent.setup().click(screen.getByRole("checkbox"));
    expect(button).toHaveProperty("disabled", false);
  });

  it("offers a way out and no way to deny", async () => {
    show();

    expect(await screen.findByRole("button", { name: "Avbryt" })).toBeTruthy();
    // Denying cancels this one request; it is not the same act as cutting a
    // connection already granted, and a button here would look like it was.
    expect(screen.queryByRole("button", { name: /neka|avsl/i })).toBeNull();
  });

  it("leaves without granting when the way out is pressed", async () => {
    const onLeave = vi.fn();
    show(request(), { onLeave });

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Avbryt" }));

    expect(onLeave).toHaveBeenCalled();
    expect(grantConsent).not.toHaveBeenCalled();
  });
});

describe("a redirect back to this computer", () => {
  it("is said out loud", async () => {
    show(request({ redirect_uri: "http://127.0.0.1:7421/callback" }));

    expect(
      await screen.findByText(
        "Svaret skickas till den här datorn. Så ska det vara för en app som " +
          "körs på din egen dator. Känner du inte igen appen ska du avbryta.",
      ),
    ).toBeTruthy();
  });

  it("is not said about an address somewhere else", async () => {
    show();

    await screen.findByRole("button", { name: "Koppla appen" });
    expect(screen.queryByText(/den här datorn/)).toBeNull();
  });
});

describe("recording the consent", () => {
  it("posts the request exactly as it arrived", async () => {
    const raw = request();
    show(raw);

    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    await waitFor(() => {
      expect(grantConsent).toHaveBeenCalledWith(raw);
    });
  });

  it("hands the browser back to the app at the address the instance answered with", async () => {
    const onGranted = vi.fn();
    show(request(), { onGranted });

    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    await waitFor(() => {
      expect(onGranted).toHaveBeenCalledWith(
        "https://app.example/callback?code=abc",
      );
    });
  });

  it.each([
    ["the instance could not be reached", 0, "offline"],
    ["the instance failed", 500, "unexpected"],
    ["the session had lapsed", 401, "unauthenticated"],
  ])("keeps the decision on screen when %s", async (_name, status, reason) => {
    grantConsent.mockResolvedValue({ ok: false, failure: { status, reason } });

    show();
    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    expect(
      await screen.findByText("Kopplingen blev inte av just nu. Försök igen."),
    ).toBeTruthy();
    // Nothing about the request is wrong, so the decision is still there to
    // make. Saying the app's request cannot be used would send a member off
    // to start something over that was never the problem.
    expect(form()).toBeTruthy();
  });
});

describe("a request that will not verify", () => {
  /** The sentence each ending gets, and what is never on screen with it. */
  const endsWith = async (sentence: string): Promise<void> => {
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(form()).toBeNull();
    // Never a retry: posting the same signature again cannot make it verify.
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Tillbaka till startsidan" }),
    ).toBeTruthy();
  };

  it("says the request is incomplete when it is not one at all", async () => {
    show("?returnTo=%2Fdocuments");

    await endsWith(
      "Appens begäran saknar uppgifter som behövs. Börja om kopplingen i appen.",
    );
    // Nothing was asked of the instance: there is nobody to ask about.
    expect(fetchOAuthClient).not.toHaveBeenCalled();
  });

  it("says the request is too old when its own expiry has passed", async () => {
    show(request({ exp: String(LONG_PAST) }));

    await endsWith(
      "Appens begäran är för gammal. Börja om kopplingen i appen.",
    );
  });

  it("says the app is unknown when the instance has never heard of it", async () => {
    fetchOAuthClient.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not_found" },
    });

    show();

    await endsWith(
      "Appen är inte känd för den här instansen. En administratör behöver registrera den först.",
    );
  });

  it("says the request was altered when the instance refuses the signature", async () => {
    grantConsent.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "unexpected" },
    });

    show();
    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    await endsWith(
      "Appens begäran har ändrats på vägen hit och går inte att lita på. Börja om kopplingen i appen.",
    );
  });

  it("falls back to the general sentence for a refusal this build has not heard of", async () => {
    grantConsent.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "some-new-reason" },
    });

    show();
    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    await endsWith(
      "Appens begäran går inte att använda. Börja om kopplingen i appen.",
    );
  });

  it("never prints the reason code it was given", async () => {
    grantConsent.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "some-new-reason" },
    });

    show();
    await screen.findByRole("button", { name: "Koppla appen" });
    await agree();

    await screen.findByText(
      "Appens begäran går inte att använda. Börja om kopplingen i appen.",
    );
    expect(document.body.textContent).not.toContain("some-new-reason");
    expect(document.body.textContent).not.toContain("invalid_signature");
  });
});
