import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import { NewsScreen } from "./NewsScreen";
import type { NewsItem } from "./news-api";

/**
 * What the board is offered, and what pressing publish actually sends.
 *
 * The screen decides nothing about who may read a news item or whether the
 * mailing goes out - the server does both. What is tested here is the one thing
 * the interface owns: that the mailing is offered exactly once, and that an
 * item the instance has already claimed a mailing for shows the board a
 * sentence instead of a second chance to send it.
 */

const fetchNews = vi.fn();
const fetchRecipientCount = vi.fn();
const createNews = vi.fn();
const editNews = vi.fn();
const publishNews = vi.fn();

vi.mock("./news-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./news-api")>()),
  fetchNews: () => fetchNews(),
  fetchRecipientCount: () => fetchRecipientCount(),
  createNews: (fields: unknown) => createNews(fields),
  editNews: (id: string, fields: unknown) => editNews(id, fields),
  publishNews: (id: string, fields: unknown) => publishNews(id, fields),
}));

const DRAFT: NewsItem = {
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
  revision: 4,
  updatedAt: "2026-09-01T10:00:00.000Z",
};

const MAILED: NewsItem = {
  ...DRAFT,
  id: "news-2",
  slug: "staddag",
  title: "Städdag",
  published: true,
  publishedAt: "2026-09-01T10:00:00.000Z",
  emailQueuedAt: "2026-09-01T10:00:00.000Z",
  delivery: {
    email: { pending: 1, sent: 2, failed: 1, notConfigured: true },
    sms: { pending: 0, sent: 0, failed: 0, notConfigured: false },
  },
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Bo",
    lastName: "Ek",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderScreen(capabilities: string[] = ["site:manage"]) {
  return render(<NewsScreen viewer={viewerWith(capabilities)} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchNews.mockResolvedValue({ ok: true, value: [DRAFT] });
  fetchRecipientCount.mockResolvedValue({
    ok: true,
    // Fewer members can be texted than mailed: a number is optional in
    // the register and an address is how the board reaches everyone.
    value: { count: 12, sms: { count: 7, configured: true } },
  });
  createNews.mockResolvedValue({ ok: true, value: DRAFT });
  publishNews.mockResolvedValue({
    ok: true,
    value: { ...DRAFT, published: true, mailedTo: 12, textedTo: null },
  });
});

describe("the news screen", () => {
  it("offers nothing to an account that may not write the website", async () => {
    renderScreen([]);

    expect(
      await screen.findByText("Ditt konto får inte ändra detta."),
    ).toBeTruthy();
    expect(fetchNews).not.toHaveBeenCalled();
  });

  it("warns about special-category data before anything is written", async () => {
    renderScreen();

    expect(await screen.findByText(/Skriv inget om någons hälsa/)).toBeTruthy();
  });

  it("saves what the board typed as blocks, never as markup", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Nya tider i tvättstugan" });

    await user.type(screen.getByLabelText(/^Rubrik/), "Städdag");
    await user.type(screen.getByLabelText(/^Adress/), "staddag");
    await user.type(
      screen.getByLabelText(/^Text/),
      "Vi träffas på gården.\n\n## Ta med\n\nHandskar.",
    );
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    await waitFor(() => {
      expect(createNews).toHaveBeenCalledWith({
        slug: "staddag",
        title: "Städdag",
        content: {
          blocks: [
            { type: "paragraph", runs: [{ text: "Vi träffas på gården." }] },
            { type: "heading", level: 2, runs: [{ text: "Ta med" }] },
            { type: "paragraph", runs: [{ text: "Handskar." }] },
          ],
        },
      });
    });
  });
});

describe("two board members editing the same item", () => {
  it("claims the save on the copy that was opened", async () => {
    editNews.mockResolvedValue({ ok: true, value: DRAFT });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    await waitFor(() => {
      expect(editNews).toHaveBeenCalledWith(
        "news-1",
        expect.objectContaining({ expectedRevision: 4 }),
      );
    });
  });

  it("says somebody else saved first, keeps the text, and claims the next save on their copy", async () => {
    // Refusing every save until a reload would lose what the board wrote to
    // protect a version they have not seen. The message says the next save
    // writes over it.
    editNews
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 409, reason: "news-changed" },
      })
      .mockResolvedValue({ ok: true, value: DRAFT });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    fetchNews.mockResolvedValue({
      ok: true,
      value: [{ ...DRAFT, title: "Deras rubrik", revision: 5 }],
    });
    await user.type(screen.getByLabelText(/^Text/), " Med min rättelse.");
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    expect(await screen.findByText(/Någon annan sparade nyheten/)).toBeTruthy();
    await screen.findByRole("heading", { name: "Deras rubrik" });
    expect(screen.getByLabelText(/^Text/)).toHaveProperty(
      "value",
      "Från måndag gäller nya tider. Med min rättelse.",
    );

    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));
    await waitFor(() => {
      expect(editNews).toHaveBeenLastCalledWith(
        "news-1",
        expect.objectContaining({ expectedRevision: 5 }),
      );
    });
  });

  it("does not claim their version is shown when it could not be read", async () => {
    // The draft still holds the refused revision, so a save now would only be
    // refused again. The button waits for a read that succeeds.
    editNews.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "news-changed" },
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    fetchNews.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    await user.type(screen.getByLabelText(/^Text/), " Med min rättelse.");
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    const unread = await screen.findByText(/kunde inte hämtas på nytt just nu/);
    expect(
      screen.queryByText(/Listan nedan visar nu deras version/),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Spara nyheten" }),
    ).toHaveProperty("disabled", true);

    fetchNews.mockResolvedValue({
      ok: true,
      value: [{ ...DRAFT, title: "Deras rubrik", revision: 5 }],
    });
    await user.click(
      within(unread.parentElement as HTMLElement).getByRole("button", {
        name: "Försök igen",
      }),
    );

    expect(
      await screen.findByText(/Listan nedan visar nu deras version/),
    ).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Spara nyheten" });
    expect(saveButton).toHaveProperty("disabled", false);
    expect(screen.getByLabelText(/^Text/)).toHaveProperty(
      "value",
      "Från måndag gäller nya tider. Med min rättelse.",
    );

    editNews.mockResolvedValue({ ok: true, value: DRAFT });
    await user.click(saveButton);
    await waitFor(() => {
      expect(editNews).toHaveBeenLastCalledWith(
        "news-1",
        expect.objectContaining({ expectedRevision: 5 }),
      );
    });
  });

  it("keeps the text as a new draft when somebody else removed the item", async () => {
    // Saving again against an item that is gone could never succeed. The text
    // is what the board stands to lose, so it stays, and is no longer tied to
    // the removed item.
    editNews.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "news-changed" },
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    fetchNews.mockResolvedValue({ ok: true, value: [] });
    await user.type(screen.getByLabelText(/^Text/), " Med min rättelse.");
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    expect(
      await screen.findByText(/Någon annan tog bort nyheten/),
    ).toBeTruthy();
    expect(screen.getByLabelText(/^Text/)).toHaveProperty(
      "value",
      "Från måndag gäller nya tider. Med min rättelse.",
    );

    editNews.mockClear();
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));
    await waitFor(() => {
      expect(createNews).toHaveBeenCalledWith(
        expect.objectContaining({ slug: DRAFT.slug }),
      );
    });
    expect(editNews).not.toHaveBeenCalled();
  });

  it("holds the save off while the read after a refusal is still running", async () => {
    // The draft still carries the refused revision until the read answers, so a
    // press now would be refused for the same reason.
    editNews.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "news-changed" },
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    const read = deferred();
    fetchNews.mockReturnValue(read.promise);
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    expect(await screen.findByText(/Hämtar deras version/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Spara nyheten" }),
    ).toHaveProperty("disabled", true);

    read.resolve({
      ok: true,
      value: [{ ...DRAFT, title: "Deras rubrik", revision: 5 }],
    });
    await screen.findByRole("heading", { name: "Deras rubrik" });
    expect(
      screen.getByRole("button", { name: "Spara nyheten" }),
    ).toHaveProperty("disabled", false);
  });

  it("treats an item that is gone like one that was changed: save off while reading, then a new draft", async () => {
    editNews.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    const read = deferred();
    fetchNews.mockReturnValue(read.promise);
    await user.type(screen.getByLabelText(/^Text/), " Med min rättelse.");
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    // Not "the list has been read again" before it has been.
    expect(
      await screen.findByText(/Nyheten finns inte längre\. Hämtar/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Spara nyheten" }),
    ).toHaveProperty("disabled", true);

    read.resolve({ ok: true, value: [] });
    expect(
      await screen.findByText(/Någon annan tog bort nyheten/),
    ).toBeTruthy();
    expect(screen.getByLabelText(/^Text/)).toHaveProperty(
      "value",
      "Från måndag gäller nya tider. Med min rättelse.",
    );

    editNews.mockClear();
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));
    await waitFor(() => {
      expect(createNews).toHaveBeenCalledWith(
        expect.objectContaining({ slug: DRAFT.slug }),
      );
    });
    expect(editNews).not.toHaveBeenCalled();
  });

  it("does not say the item was changed when a read after not-found fails", async () => {
    editNews.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Ändra" }));
    fetchNews.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    expect(
      await screen.findByText(/ändrade eller tog bort nyheten/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Spara nyheten" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps Edit and Cancel off while a save runs, so its refusal lands on the item it was for", async () => {
    // A refusal that came back after the board had opened another item would
    // hold that item's save off and, for a removed item, tell the board the
    // wrong item was removed.
    fetchNews.mockResolvedValue({ ok: true, value: [DRAFT, MAILED] });
    const answer = deferred();
    editNews.mockReturnValue(answer.promise);
    const user = userEvent.setup();
    renderScreen();

    const [first] = await screen.findAllByRole("button", { name: "Ändra" });
    await user.click(first as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Spara nyheten" }));

    for (const edit of screen.getAllByRole("button", { name: "Ändra" })) {
      expect(edit).toHaveProperty("disabled", true);
    }
    expect(screen.getByRole("button", { name: "Avbryt" })).toHaveProperty(
      "disabled",
      true,
    );

    answer.resolve({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    fetchNews.mockResolvedValue({ ok: true, value: [MAILED] });
    expect(
      await screen.findByText(/Någon annan tog bort nyheten/),
    ).toBeTruthy();
    for (const edit of screen.getAllByRole("button", { name: "Ändra" })) {
      expect(edit).toHaveProperty("disabled", false);
    }
  });
});

describe("publishing", () => {
  it("offers the mailing with the number of members it would reach", async () => {
    renderScreen();

    expect(await screen.findByLabelText("Mejla medlemmarna (12)")).toBeTruthy();
  });

  it("sends the audience and the mailing decision together", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Nya tider i tvättstugan" });

    await user.click(screen.getByRole("radio", { name: "Alla" }));
    await user.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-1", {
        published: true,
        visibility: "PUBLIC",
        sendEmail: true,
        // Off unless the board asks. A text message is billed per member and
        // reaches only those who gave the association a number.
        sendSms: false,
      });
    });
    expect(await screen.findByText(/på väg till 12 medlemmar/)).toBeTruthy();
  });

  it("lets the board publish without mailing anybody", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Nya tider i tvättstugan" });

    await user.click(screen.getByLabelText("Mejla medlemmarna (12)"));
    await user.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-1", {
        published: true,
        visibility: "MEMBER",
        sendEmail: false,
        sendSms: false,
      });
    });
  });

  it("offers no second mailing for an item that has already been mailed", async () => {
    const user = userEvent.setup();
    fetchNews.mockResolvedValue({ ok: true, value: [MAILED] });
    publishNews.mockResolvedValue({
      ok: true,
      value: { ...MAILED, mailedTo: null, textedTo: null },
    });
    renderScreen();
    await screen.findByRole("heading", { name: "Städdag" });

    expect(screen.queryByLabelText(/^Mejla medlemmarna/)).toBeNull();
    expect(screen.getByText(/En nyhet mejlas en gång/)).toBeTruthy();

    // Republishing it carries no mailing decision at all: there is none left to
    // make, and the server would refuse to claim a second one anyway.
    await user.click(screen.getByRole("button", { name: "Publicera" }));
    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-2", {
        published: true,
        visibility: "MEMBER",
        sendSms: false,
      });
    });
  });

  it("reports a mailing the instance could not send, and says the item stands", async () => {
    fetchNews.mockResolvedValue({ ok: true, value: [MAILED] });
    renderScreen();

    expect(await screen.findByText(/Skickade: 2/)).toBeTruthy();
    expect(
      screen.getByText(/publicerad, men utskicket kunde inte göras/),
    ).toBeTruthy();
  });
});

describe("texting the members", () => {
  it("offers the text message off by default, with its own smaller count", async () => {
    renderScreen();

    const toggle = (await screen.findByLabelText(
      "Sms:a medlemmarna (7)",
    )) as HTMLInputElement;
    // The email is on and the text message is off. One costs nothing and
    // reaches everyone with an address; the other is billed per member.
    expect(toggle.checked).toBe(false);
    expect(
      (screen.getByLabelText("Mejla medlemmarna (12)") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("sends the SMS decision with the publish when the board asks for it", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Nya tider i tvättstugan" });

    await user.click(screen.getByLabelText("Sms:a medlemmarna (7)"));
    await user.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-1", {
        published: true,
        visibility: "MEMBER",
        sendEmail: true,
        sendSms: true,
      });
    });
  });

  it("says so plainly on an instance with no SMS provider", async () => {
    // Said rather than hidden. A board that expected to be able to text its
    // members has to learn that this instance cannot, and where to go about it.
    fetchRecipientCount.mockResolvedValue({
      ok: true,
      value: { count: 12, sms: { count: 0, configured: false } },
    });
    renderScreen();

    expect(await screen.findByText(/har ingen sms-leverantör/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Sms:a medlemmarna/)).toBeNull();
  });

  it("carries no SMS decision when the instance could not act on one", async () => {
    const user = userEvent.setup();
    fetchRecipientCount.mockResolvedValue({
      ok: true,
      value: { count: 12, sms: { count: 0, configured: false } },
    });
    renderScreen();
    await screen.findByRole("heading", { name: "Nya tider i tvättstugan" });

    await user.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(publishNews).toHaveBeenCalledWith("news-1", {
        published: true,
        visibility: "MEMBER",
        sendEmail: true,
      });
    });
  });

  it("offers no second text message once one has been claimed", async () => {
    const texted = {
      ...MAILED,
      smsQueuedAt: "2026-09-01T10:00:00.000Z",
      delivery: {
        ...MAILED.delivery,
        sms: { pending: 0, sent: 5, failed: 2, notConfigured: true },
      },
    };
    fetchNews.mockResolvedValue({ ok: true, value: [texted] });
    renderScreen();

    expect(await screen.findByText(/En nyhet sms:as en gång/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Sms:a medlemmarna/)).toBeNull();
  });

  it("reports the two channels apart, so one failing does not read as both", async () => {
    const texted = {
      ...MAILED,
      smsQueuedAt: "2026-09-01T10:00:00.000Z",
      delivery: {
        email: { pending: 0, sent: 12, failed: 0, notConfigured: false },
        sms: { pending: 0, sent: 0, failed: 7, notConfigured: true },
      },
    };
    fetchNews.mockResolvedValue({ ok: true, value: [texted] });
    renderScreen();

    expect(await screen.findByText("Sms-utskicket")).toBeTruthy();
    expect(screen.getByText("Utskicket")).toBeTruthy();
    // The SMS half failed for want of a provider; the mailing went out. A board
    // reading a column of failures has to be able to see which of the two it was.
    expect(screen.getByText(/men sms:en kunde inte skickas/)).toBeTruthy();
    expect(
      screen.queryByText(/publicerad, men utskicket kunde inte göras/),
    ).toBeNull();
  });
});
