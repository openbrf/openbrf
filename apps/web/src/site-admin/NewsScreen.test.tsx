import { render, screen, waitFor } from "@testing-library/react";
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
const publishNews = vi.fn();

vi.mock("./news-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./news-api")>()),
  fetchNews: () => fetchNews(),
  fetchRecipientCount: () => fetchRecipientCount(),
  createNews: (fields: unknown) => createNews(fields),
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
  delivery: { pending: 0, sent: 0, failed: 0, mailNotConfigured: false },
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
  delivery: { pending: 1, sent: 2, failed: 1, mailNotConfigured: true },
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

function renderScreen(capabilities: string[] = ["site:manage"]) {
  return render(<NewsScreen viewer={viewerWith(capabilities)} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchNews.mockResolvedValue({ ok: true, value: [DRAFT] });
  fetchRecipientCount.mockResolvedValue({ ok: true, value: { count: 12 } });
  createNews.mockResolvedValue({ ok: true, value: DRAFT });
  publishNews.mockResolvedValue({
    ok: true,
    value: { ...DRAFT, published: true, mailedTo: 12 },
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
      });
    });
  });

  it("offers no second mailing for an item that has already been mailed", async () => {
    const user = userEvent.setup();
    fetchNews.mockResolvedValue({ ok: true, value: [MAILED] });
    publishNews.mockResolvedValue({
      ok: true,
      value: { ...MAILED, mailedTo: null },
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
