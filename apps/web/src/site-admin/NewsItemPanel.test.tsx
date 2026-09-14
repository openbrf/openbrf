import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import "../i18n";
import type { NewsItem } from "./news-api";
import { NewsItemPanel } from "./NewsItemPanel";

/**
 * The item, and the mailing something else asked for.
 *
 * Two things are being held in place here. The notice says that a request
 * exists and never which person placed it: who asked is in the audit log, and
 * a name on this screen would turn the board's question - should this go out -
 * into a question about the requester. And answering the request is the
 * publish the board already does, with the email checkbox where it already
 * stands: a second way to send would be a second path to the one act that
 * cannot be taken back, and it would not be the path the server claims the
 * mailing on.
 *
 * The API answers a refused request with a code. What a board member reads is
 * a sentence, because the API is English throughout and this screen is Swedish
 * by default - a code reaching the screen is the failure being tested for.
 */

const dismissNewsMailingRequest = vi.fn();
const publishNews = vi.fn();
const removeNews = vi.fn();

vi.mock("./news-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./news-api")>()),
  dismissNewsMailingRequest: (id: string) => dismissNewsMailingRequest(id),
  publishNews: (id: string, fields: unknown) => publishNews(id, fields),
  removeNews: (id: string) => removeNews(id),
}));

// Typed, so a field added or retyped in the API client breaks this fixture
// rather than leaving the tests passing against a shape the API no longer
// returns.
const ITEM: NewsItem = {
  id: "news-1",
  slug: "tvattstugan",
  title: "Nya tider i tvättstugan",
  content: {
    blocks: [
      { type: "paragraph", runs: [{ text: "Från måndag gäller nya tider." }] },
    ],
  },
  visibility: "MEMBER",
  published: false,
  publishedAt: null,
  emailQueuedAt: null,
  smsQueuedAt: null,
  delivery: {
    email: { pending: 0, sent: 0, failed: 0, notConfigured: false },
    sms: { pending: 0, sent: 0, failed: 0, notConfigured: false },
  },
  mailingRequested: false,
  updatedAt: "2026-09-01T10:00:00.000Z",
};

const onChanged = vi.fn();

function panelFor(overrides: Partial<NewsItem> = {}) {
  return (
    <NewsItemPanel
      item={{ ...ITEM, ...overrides }}
      recipients={{ count: 12, sms: { count: 7, configured: true } }}
      onEdit={vi.fn()}
      onChanged={onChanged}
    />
  );
}

function renderPanel(overrides: Partial<NewsItem> = {}) {
  return render(panelFor(overrides));
}

const NOTICE =
  "En ansluten app har begärt att nyheten skickas till medlemmarna";

const dismissButton = () =>
  screen.getByRole("button", { name: "Avfärda begäran" });

beforeEach(() => {
  vi.clearAllMocks();
  dismissNewsMailingRequest.mockResolvedValue({ ok: true, value: undefined });
  publishNews.mockResolvedValue({
    ok: true,
    value: { ...ITEM, published: true, mailedTo: 12, textedTo: null },
  });
});

describe("a standing mailing request", () => {
  it("is absent from an item nothing has asked for", () => {
    renderPanel();

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Avfärda begäran" }),
    ).toBeNull();
  });

  it("says that something asked, and never who", () => {
    renderPanel({ mailingRequested: true });

    // The sentence is the whole of the notice: nothing is appended naming the
    // app or the person behind it.
    expect(screen.getByText(NOTICE)).toBeTruthy();

    /*
     * A property of the wire shape as well as of the rendering. The item
     * carries a boolean, so there is no requester on this screen for a later
     * edit to start printing - who asked is in the audit log, and the board is
     * answering whether the news item goes out.
     *
     * Asserted against the TYPE rather than against the fixture below. An
     * optional `requestedByPersonId` added to NewsItem would leave the
     * fixture's own key list untouched, and a check over those keys would go on
     * passing while the guard it describes had gone.
     */
    type Requester = Extract<
      keyof NewsItem,
      | `${string}erson${string}`
      | `${string}equestedBy${string}`
      | `${string}uthor${string}`
      | `${string}ctor${string}`
    >;
    expectTypeOf<Requester>().toEqualTypeOf<never>();
  });

  it("is answered by the publish the board already does", async () => {
    /*
     * No second confirmation and no endpoint of its own. The request is a
     * notice above the controls; what sends is the ordinary publish with the
     * mailing ticked, which is the only act the server claims a mailing on.
     */
    const session = userEvent.setup();
    renderPanel({ mailingRequested: true });

    expect(
      screen.getByRole("checkbox", { name: /Mejla medlemmarna/ }),
    ).toHaveProperty("checked", true);

    await session.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-1", {
        published: true,
        visibility: "MEMBER",
        sendEmail: true,
        sendSms: false,
      });
    });
    expect(dismissNewsMailingRequest).not.toHaveBeenCalled();
  });
});

describe("dismissing the request", () => {
  it("clears it on the server and takes the notice away", async () => {
    const session = userEvent.setup();
    renderPanel({ mailingRequested: true });

    await session.click(dismissButton());

    await waitFor(() => {
      expect(dismissNewsMailingRequest).toHaveBeenCalledWith("news-1");
    });
    /*
     * Gone from the screen the moment the board answers it, and re-read so the
     * answer survives a reload. A notice that stayed up until the read landed
     * would read as a request nobody had dealt with.
     */
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByText("Begäran är avfärdad")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a request placed after the last one was answered", async () => {
    /*
     * The item carries a boolean rather than the instant, so the board's
     * answer is dropped as soon as the item says something other than what it
     * said when the answer was given. Holding it would hide a request nobody
     * had seen behind an answer to an older one.
     */
    const session = userEvent.setup();
    const { rerender } = renderPanel({ mailingRequested: true });

    await session.click(dismissButton());
    await waitFor(() => {
      expect(screen.queryByText(NOTICE)).toBeNull();
    });

    // The re-read lands and the request is gone. Then something asks again.
    rerender(panelFor({ mailingRequested: false }));
    rerender(panelFor({ mailingRequested: true }));

    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it("sends nothing to the members", async () => {
    // Dismissing is a board member deciding not to send. It must not be a way
    // of publishing, and the publish is the only call that mails anybody.
    const session = userEvent.setup();
    renderPanel({ mailingRequested: true });

    await session.click(dismissButton());

    await waitFor(() => {
      expect(dismissNewsMailingRequest).toHaveBeenCalledTimes(1);
    });
    expect(publishNews).not.toHaveBeenCalled();
  });
});

describe("a refused mailing request", () => {
  it("reads as a sentence when the members have already been mailed", async () => {
    dismissNewsMailingRequest.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "already-mailed" },
    });
    const session = userEvent.setup();
    const { container } = renderPanel({ mailingRequested: true });

    await session.click(dismissButton());

    // Its own sentence, not the label beside a mailed item: that one names the
    // day the mailing went out, and a refusal carries no day to name.
    expect(
      await screen.findByText(/har redan mejlats till medlemmarna/),
    ).toBeTruthy();
    // Never the API's own code, and never a placeholder the sentence was
    // supposed to have a value for.
    expect(container.textContent).not.toContain("already-mailed");
    expect(container.textContent).not.toContain("{{");
  });

  it("falls back to the panel's own sentence for a code it has no words for", async () => {
    /*
     * The table cannot be total: the server may answer with a reason this
     * build has never heard of. What must not happen is the code itself
     * reaching a board member, who has nothing to do with it.
     */
    dismissNewsMailingRequest.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "mailing-window-closed" },
    });
    const session = userEvent.setup();
    const { container } = renderPanel({ mailingRequested: true });

    await session.click(dismissButton());

    expect(await screen.findByText("Begäran kunde inte ändras")).toBeTruthy();
    expect(container.textContent).not.toContain("mailing-window-closed");
  });

  it("leaves the request standing", async () => {
    // The board pressed a button and the server refused it. Taking the notice
    // away anyway would tell them the request was dealt with when it was not.
    dismissNewsMailingRequest.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "mailing-window-closed" },
    });
    const session = userEvent.setup();
    renderPanel({ mailingRequested: true });

    await session.click(dismissButton());

    expect(await screen.findByText("Begäran kunde inte ändras")).toBeTruthy();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});
