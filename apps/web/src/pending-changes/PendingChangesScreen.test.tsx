import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { PendingChange } from "./pending-changes-api";
import { PendingChangesScreen } from "./PendingChangesScreen";

/**
 * What the person sees of a change proposed in their name, and what each
 * answer sends.
 *
 * The preview is the point of the screen: whatever it leaves out is something
 * the person confirms without having seen, so the cases below assert on the
 * values themselves. The answers are asserted on what reaches the API, and a
 * refusal on the sentence the person is left with.
 */

const fetchMyPendingChanges = vi.fn();
const confirmPendingChange = vi.fn();
const rejectPendingChange = vi.fn();

vi.mock("./pending-changes-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending-changes-api")>()),
  fetchMyPendingChanges: () => fetchMyPendingChanges(),
  confirmPendingChange: (id: string) => confirmPendingChange(id),
  rejectPendingChange: (id: string) => rejectPendingChange(id),
}));

const NEWS: PendingChange = {
  id: "pending-1",
  action: {
    title: "Skapa en nyhet",
    description: "Skapar ett utkast till en nyhet. Den publiceras inte.",
    effect: "write",
    needsConfirmation: false,
    errors: [
      {
        reason: "slug-taken",
        retry: "after-edit",
        messageKey: "news.errors.slugTaken",
      },
    ],
  },
  actionName: "news_create",
  input: {
    slug: "staddag",
    title: "Städdag i maj",
    blocks: [{ type: "paragraph", runs: [{ text: "Vi ses på gården." }] }],
  },
  channel: "PLUGIN",
  clientHost: null,
  proposedAt: "2026-10-20T08:00:00.000Z",
  expiresAt: "2026-10-27T08:00:00.000Z",
};

const OTHER: PendingChange = {
  ...NEWS,
  id: "pending-2",
  input: { slug: "arsstamma", title: "Årsstämma", blocks: [] },
};

function listing(pendingChanges: PendingChange[]) {
  return { ok: true, value: { pendingChanges } };
}

beforeEach(() => {
  fetchMyPendingChanges.mockReset();
  confirmPendingChange.mockReset();
  rejectPendingChange.mockReset();
  fetchMyPendingChanges.mockResolvedValue(listing([NEWS]));
});

describe("the preview", () => {
  it("shows the action and every value it would send", async () => {
    render(<PendingChangesScreen />);

    expect(
      await screen.findByRole("heading", { name: "Skapa en nyhet" }),
    ).toBeTruthy();
    expect(screen.getByText("Städdag i maj")).toBeTruthy();
    expect(screen.getByText("Vi ses på gården.")).toBeTruthy();
    expect(screen.getByText("slug")).toBeTruthy();
    expect(screen.getByText("Föreslogs via: Ett tillägg")).toBeTruthy();
  });

  it("shows markup a model wrote as text, and never as markup", async () => {
    fetchMyPendingChanges.mockResolvedValue(
      listing([
        {
          ...NEWS,
          input: {
            ...(NEWS.input as object),
            title: '<img src="x" alt="leak">',
          },
        },
      ]),
    );

    const { container } = render(<PendingChangesScreen />);

    expect(await screen.findByText('<img src="x" alt="leak">')).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps every space and tab in a value, so two values never look alike", async () => {
    // "a  b" and "a b" are different inputs. Folded together on the screen,
    // the person would confirm one having been shown the other.
    fetchMyPendingChanges.mockResolvedValue(
      listing([
        {
          ...NEWS,
          input: { title: "Städdag  i\tmaj", slug: "Städdag i maj" },
        },
      ]),
    );

    render(<PendingChangesScreen />);

    const exactly = (text: string) =>
      screen.getByText((_, element) => element?.textContent === text, {
        selector: "dd > span",
      });
    await screen.findByRole("heading", { name: "Skapa en nyhet" });
    const spaced = exactly("Städdag  i\tmaj");
    expect(spaced).not.toBe(exactly("Städdag i maj"));
    // jsdom lays nothing out, so the rule that keeps the spaces on the screen
    // is asserted as the class that carries it.
    expect(spaced.className).toContain("whitespace-pre-wrap");
  });

  it("sets the moments in the data face, and the words around them in the UI's", async () => {
    render(<PendingChangesScreen />);
    await screen.findByRole("heading", { name: "Skapa en nyhet" });

    const moments = screen.getAllByText(/2026/, { selector: "span.font-data" });
    expect(
      moments.map((moment) => moment.parentElement?.firstChild?.textContent),
    ).toEqual(["Föreslogs", "Väntar till"]);
  });

  it("says when nothing is waiting", async () => {
    fetchMyPendingChanges.mockResolvedValue(listing([]));

    render(<PendingChangesScreen />);

    expect(await screen.findByText("Inget väntar på dig.")).toBeTruthy();
  });
});

describe("a link to one change", () => {
  it("puts the change it points at first", async () => {
    fetchMyPendingChanges.mockResolvedValue(listing([OTHER, NEWS]));

    render(<PendingChangesScreen focusId="pending-1" />);

    await screen.findByText("Städdag i maj");
    const articles = screen.getAllByRole("article");
    expect(articles[0]?.getAttribute("aria-current")).toBe("true");
    expect(articles[0]?.textContent).toContain("Städdag i maj");
  });

  it("says so when the change is no longer waiting", async () => {
    render(<PendingChangesScreen focusId="pending-gone" />);

    expect(
      await screen.findByText(
        "Ändringen du följde en länk till väntar inte längre. Den har bekräftats, avvisats eller förfallit.",
      ),
    ).toBeTruthy();
  });
});

describe("confirming", () => {
  it("sends the change once and says it was done as the person", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: true,
      value: { confirmed: true },
    });
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    );

    expect(confirmPendingChange).toHaveBeenCalledTimes(1);
    expect(confirmPendingChange).toHaveBeenCalledWith("pending-1");
    expect(
      await screen.findByText("Ändringen genomfördes av dig."),
    ).toBeTruthy();
    // Read again rather than struck from the list here.
    await waitFor(() => {
      expect(fetchMyPendingChanges).toHaveBeenCalledTimes(2);
    });
  });

  it("gives the action's own sentence for a refusal it published", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "slug-taken" },
    });
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    );

    expect(
      await screen.findByText("En annan nyhet har redan den adressen."),
    ).toBeTruthy();
    // Still there, to reject, or to confirm again once the address is free.
    expect(screen.getByText("Städdag i maj")).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: "Bekräfta och genomför: Skapa en nyhet",
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    confirmPendingChange.mockResolvedValue({
      ok: true,
      value: { confirmed: true },
    });
    await userEvent.click(confirm);
    expect(confirmPendingChange).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText("Ändringen genomfördes av dig."),
    ).toBeTruthy();
  });

  it("says a change that failed after it was handed on may have been carried out, and no longer offers it", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "pending-change-failed-after-dispatch" },
    });
    // The queue read again no longer holds it.
    fetchMyPendingChanges
      .mockResolvedValueOnce(listing([NEWS]))
      .mockResolvedValue(listing([]));
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    );

    expect(
      await screen.findByText(
        "Något gick fel medan ändringen genomfördes, och den kan ha fått verkan. Den väntar inte längre. Kontrollera resultatet innan du ber om den igen.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Inget väntar på dig.")).toBeTruthy();
    expect(fetchMyPendingChanges).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Städdag i maj")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Bekräfta och genomför/ }),
    ).toBeNull();
    expect(screen.queryByText(/väntar kvar|försök igen/)).toBeNull();
  });

  it("says a change that is no longer waiting has ended, and reads the queue again", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "pending-change-not-found" },
    });
    fetchMyPendingChanges
      .mockResolvedValueOnce(listing([NEWS, OTHER]))
      .mockResolvedValue(listing([OTHER]));
    render(<PendingChangesScreen focusId="pending-1" />);

    await userEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Bekräfta och genomför: Skapa en nyhet",
        })
      )[0] as HTMLElement,
    );

    expect(
      await screen.findByText(
        "Ändringen väntar inte längre: den har bekräftats, avvisats eller förfallit.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Städdag i maj")).toBeNull();
    });
    expect(screen.getByText("Årsstämma")).toBeTruthy();
  });

  it("promises nothing after a failure it cannot place, and shows what still waits", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    );

    expect(
      await screen.findByText(
        "Något gick fel. Står ändringen kvar här väntar den fortfarande och inget har genomförts; försök igen.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(fetchMyPendingChanges).toHaveBeenCalledTimes(2);
    });
    // Still waiting by the queue's own account, so still offered.
    expect(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    ).toBeTruthy();
  });

  it("says the person may no longer do it, and that it still waits", async () => {
    confirmPendingChange.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden-capability" },
    });
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Bekräfta och genomför: Skapa en nyhet",
      }),
    );

    expect(
      await screen.findByText(
        "Du kan inte längre genomföra den här ändringen. Den väntar kvar, och du kan avvisa den.",
      ),
    ).toBeTruthy();
  });

  it("offers only rejecting when the action is gone", async () => {
    fetchMyPendingChanges.mockResolvedValue(
      listing([{ ...NEWS, action: null }]),
    );
    render(<PendingChangesScreen />);

    expect(
      await screen.findByText(
        "Åtgärden som ändringen skulle genomföra finns inte längre här, så den kan bara avvisas.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Bekräfta och genomför/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Avvisa: news_create" }),
    ).toBeTruthy();
  });
});

describe("rejecting", () => {
  it("takes two presses, and sends nothing on the first", async () => {
    rejectPendingChange.mockResolvedValue({
      ok: true,
      value: { rejected: true },
    });
    render(<PendingChangesScreen />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Avvisa: Skapa en nyhet" }),
    );
    expect(rejectPendingChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Ja, avvisa" }));

    expect(rejectPendingChange).toHaveBeenCalledWith("pending-1");
    expect(
      await screen.findByText("Ändringen avvisades. Inget gjordes."),
    ).toBeTruthy();
  });
});
