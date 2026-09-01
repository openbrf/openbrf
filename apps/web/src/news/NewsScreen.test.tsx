import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { NewsArticle, NewsComment } from "../api/news-reader";
import { NewsScreen } from "./NewsScreen";

/**
 * What the reading screen may decide, and what it may only render.
 *
 * The whole of moderation on this screen is a rule the server applies per reader:
 * a comment struck through arrives with its text for the board and for whoever
 * wrote it, and with `body: null` for everybody else. So the one thing this
 * screen must never do is work that out for itself. A client-side "hide the text
 * unless this account moderates" would look right in every case a developer
 * thinks of and be wrong in the one that matters - the author reading their own
 * struck comment - and it would be a second answer to a question the API has
 * already answered. Two tests below are that property from both sides.
 *
 * The second rule is that nothing here is optimistic. A posted comment and a
 * struck one are both answered by re-reading the thread, so the test that
 * matters is not "does the comment appear" but "does what appears come from the
 * read": the write returns one comment, the thread is the whole of it, and a list
 * assembled from both is a list nothing on the server ever said.
 *
 * Everything else on the screen is courtesy, and asserted as such: which
 * capability is offered the strike-through control, and what an account the
 * notices are not addressed to is told instead of a failed read.
 */

const fetchReadableNews = vi.fn();
const fetchNewsComments = vi.fn();
const writeNewsComment = vi.fn();
const hideNewsComment = vi.fn();

vi.mock("../api/news-reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/news-reader")>()),
  fetchReadableNews: () => fetchReadableNews(),
  fetchNewsComments: (input: unknown) => fetchNewsComments(input),
  writeNewsComment: (input: unknown) => writeNewsComment(input),
  hideNewsComment: (input: unknown) => hideNewsComment(input),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-astrid",
    firstName: "Astrid",
    lastName: "Holm",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

function body(text: string): NewsArticle["content"] {
  return {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text }] }],
  };
}

const NEWEST: NewsArticle = {
  id: "news-1",
  slug: "portkoden-byts",
  title: "Portkoden byts",
  content: body("Vi byter portkod på lördag klockan tio."),
  publishedAt: "2026-08-20T08:00:00.000Z",
};

const OLDER: NewsArticle = {
  id: "news-2",
  slug: "staddag-i-trapphuset",
  title: "Städdag i trapphuset",
  content: body("Vi städar trapphuset den tolfte oktober."),
  publishedAt: "2026-08-01T08:00:00.000Z",
};

const STANDING: NewsComment = {
  id: "comment-1",
  author: { kind: "resident", personId: "person-astrid", name: "Astrid Holm" },
  body: "Tack för beskedet.",
  hiddenAt: null,
  createdAt: "2026-08-20T09:00:00.000Z",
};

/** Struck through, and this reader is neither the board nor its author. */
const WITHHELD: NewsComment = {
  id: "comment-2",
  author: { kind: "resident", personId: "person-nils", name: "Nils Holm" },
  body: null,
  hiddenAt: "2026-08-21T11:00:00.000Z",
  createdAt: "2026-08-20T10:00:00.000Z",
};

/** The same comment as the server sends it to the board, or to its author. */
const READABLE_STRUCK: NewsComment = {
  ...WITHHELD,
  body: "Det jag skrev om grannens bil.",
};

beforeEach(() => {
  fetchReadableNews.mockReset().mockResolvedValue({
    ok: true,
    value: [NEWEST, OLDER],
  });
  fetchNewsComments.mockReset().mockResolvedValue({
    ok: true,
    value: [STANDING],
  });
  writeNewsComment.mockReset().mockResolvedValue({ ok: true, value: STANDING });
  hideNewsComment
    .mockReset()
    .mockResolvedValue({ ok: true, value: READABLE_STRUCK });
});

describe("the notices", () => {
  it("opens the newest and lets the reader open an older one", async () => {
    render(<NewsScreen viewer={viewer(["news:comment"])} />);

    // The newest is open without anything being pressed, and its thread is the
    // one that was read.
    await screen.findByText("Vi byter portkod på lördag klockan tio.");
    expect(fetchNewsComments).toHaveBeenCalledWith({ newsId: "news-1" });

    await userEvent.click(
      screen.getByRole("button", {
        name: "Öppna Städdag i trapphuset, publicerad 2026-08-01",
      }),
    );

    expect(
      screen.getByText("Vi städar trapphuset den tolfte oktober."),
    ).not.toBeNull();
    await waitFor(() => {
      expect(fetchNewsComments).toHaveBeenCalledWith({ newsId: "news-2" });
    });
  });
});

describe("a comment the board has struck through", () => {
  it("says so where the text was, and keeps its author named", async () => {
    fetchNewsComments.mockResolvedValue({
      ok: true,
      value: [STANDING, WITHHELD],
    });

    render(<NewsScreen viewer={viewer(["news:comment"])} />);

    await screen.findByText("Tack för beskedet.");

    /*
     * A hide is a strike-through and never a disappearance. The row is still
     * there, the person who wrote it is still named, and what stands where the
     * text was says what happened rather than leaving a gap: a thread that had
     * simply lost a row would leave nobody able to tell whether anything had
     * been said.
     */
    expect(screen.getByText("Tack för beskedet.")).not.toBeNull();

    // On the struck comment's own row rather than anywhere on the screen: the
    // author, the word and the sentence have to belong to the same comment, and
    // a page-wide assertion would pass on a thread that had lost the row and
    // grown a notice somewhere else.
    const struckRow = screen.getByText("Nils Holm").closest("li");
    expect(struckRow?.textContent).toContain("Struken");
    expect(struckRow?.textContent).toContain(
      "Styrelsen har tagit bort texten från tråden.",
    );
  });

  it("shows the text to a reader the server sent it to, whatever this account holds", async () => {
    /*
     * The property this screen exists to get right. The viewer holds no
     * site:manage - they are the author reading their own struck comment - and
     * the server has sent the text, so the screen shows it. A client that
     * withheld a struck comment's text unless the account moderated would fail
     * here, and would be a second rule about who may read what: the one the
     * reader saw would be the one nothing enforces.
     */
    fetchNewsComments.mockResolvedValue({
      ok: true,
      value: [READABLE_STRUCK],
    });

    render(<NewsScreen viewer={viewer(["news:comment"])} />);

    await screen.findByText("Det jag skrev om grannens bil.");
    expect(
      screen.getByText(
        "Struken. Texten visas för styrelsen och för den som skrev den.",
      ),
    ).not.toBeNull();
    // And the strike-through control is not offered, because this account
    // cannot strike anything through. Reading the text and deciding it are two
    // different capabilities.
    expect(
      screen.queryByRole("button", {
        name: "Stryk kommentaren från Nils Holm",
      }),
    ).toBeNull();
  });
});

describe("striking a comment through", () => {
  it("is offered to the board and to nobody else", async () => {
    fetchNewsComments.mockResolvedValue({ ok: true, value: [STANDING] });

    const { unmount } = render(
      <NewsScreen viewer={viewer(["news:comment"])} />,
    );
    await screen.findByText("Tack för beskedet.");
    expect(
      screen.queryByRole("button", {
        name: "Stryk kommentaren från Astrid Holm",
      }),
    ).toBeNull();
    unmount();

    render(<NewsScreen viewer={viewer(["news:comment", "site:manage"])} />);
    await screen.findByText("Tack för beskedet.");
    expect(
      screen.getByRole("button", {
        name: "Stryk kommentaren från Astrid Holm",
      }),
    ).not.toBeNull();
  });

  it("asks the server and then reads the thread again", async () => {
    const struck: NewsComment = {
      ...STANDING,
      hiddenAt: "2026-08-21T11:00:00.000Z",
    };
    fetchNewsComments
      .mockResolvedValueOnce({ ok: true, value: [STANDING] })
      .mockResolvedValue({ ok: true, value: [struck] });
    hideNewsComment.mockResolvedValue({ ok: true, value: struck });

    render(<NewsScreen viewer={viewer(["news:comment", "site:manage"])} />);
    await screen.findByText("Tack för beskedet.");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Stryk kommentaren från Astrid Holm",
      }),
    );

    expect(hideNewsComment).toHaveBeenCalledWith({ commentId: "comment-1" });
    // The struck state arrives with the re-read rather than with the click, so
    // what is on the thread afterwards is what the server says is on it.
    await screen.findByText("Struken");
    expect(fetchNewsComments).toHaveBeenCalledTimes(2);
  });
});

describe("posting a comment", () => {
  it("shows the thread the server read back, and not the answer to the write", async () => {
    /*
     * The write's own answer is deliberately a comment the re-read does not
     * carry. A panel that appended what the write returned would show it; one
     * that re-reads shows what the thread actually holds. Only the second is
     * right after two people post at once, and only this fixture can tell them
     * apart.
     */
    const fromTheRead: NewsComment = {
      ...STANDING,
      id: "comment-3",
      body: "Den här kom med omläsningen.",
    };
    const fromTheWrite: NewsComment = {
      ...STANDING,
      id: "comment-4",
      body: "Den här kom med skrivsvaret.",
    };
    fetchNewsComments
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValue({ ok: true, value: [fromTheRead] });
    writeNewsComment.mockResolvedValue({ ok: true, value: fromTheWrite });

    render(<NewsScreen viewer={viewer(["news:comment"])} />);
    await screen.findByText("Ingen har svarat på den här än.");

    await userEvent.type(
      screen.getByLabelText("Din kommentar"),
      "Tack för beskedet.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka kommentaren" }),
    );

    expect(writeNewsComment).toHaveBeenCalledWith({
      newsId: "news-1",
      body: "Tack för beskedet.",
    });
    await screen.findByText("Den här kom med omläsningen.");
    expect(screen.queryByText("Den här kom med skrivsvaret.")).toBeNull();
    expect(fetchNewsComments).toHaveBeenCalledTimes(2);
  });

  it("puts the refusal in words, and leaves the comment in the box", async () => {
    writeNewsComment.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });

    render(<NewsScreen viewer={viewer(["news:comment"])} />);
    await screen.findByText("Tack för beskedet.");

    const box = screen.getByLabelText("Din kommentar");
    await userEvent.type(box, "Det är 19811218-9876 som står där.");
    await userEvent.click(
      screen.getByRole("button", { name: "Skicka kommentaren" }),
    );

    await screen.findByText(/innehåller ett personnummer/);
    /*
     * And the text is still in the box. A refused comment is one the author has
     * to change, so clearing the box would make them write the whole thing
     * again - and the refusal names no position a person can act on, only which
     * rule was broken.
     */
    expect((box as HTMLTextAreaElement).value).toBe(
      "Det är 19811218-9876 som står där.",
    );
  });
});

describe("an account the notices are not addressed to", () => {
  it("is told where the news is rather than shown a read that failed", async () => {
    // The external property manager: issues:handle and their own account, and no
    // news:comment. The endpoint would refuse them, and "the news could not be
    // read just now, reload the page" would be advice for a request that will
    // fail again every time.
    render(<NewsScreen viewer={viewer(["issues:handle", "self:manage"])} />);

    await screen.findByText(/Nyheterna här är för dem som bor i huset/);
    expect(fetchReadableNews).not.toHaveBeenCalled();
    expect(fetchNewsComments).not.toHaveBeenCalled();
  });
});
