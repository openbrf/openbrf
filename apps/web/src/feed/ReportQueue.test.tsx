import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import type { PostReportView } from "@openbrf/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { ok, refused } from "./feed-fixtures";
import { ReportQueue } from "./ReportQueue";

/**
 * The board's queue of reported posts and comments: what Alla asked it to look
 * at, and its only way into a group.
 *
 * **The board decides about a post, not about one report of it.** Answering one
 * report takes every report about the same post or comment off the queue,
 * because the server closed them together.
 *
 * **The reports past the first page are a press away**, read from the cursor
 * the server answered with and added under the ones held.
 *
 * **The board sees the pictures with the text.** A picture is part of what was
 * said, and the report is the only way the board can fetch one from a group it
 * is not in.
 *
 * **An account with no seat is told the queue is not theirs**, rather than shown
 * an empty queue - which would be a claim about groups it may not be told
 * exist.
 */

const fetchReports = vi.fn();
const strikeReport = vi.fn();
const dismissReport = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: { postId: string };
    children: ReactNode;
  }): ReactElement => (
    <a href={to.replace("$postId", params.postId)}>{children}</a>
  ),
}));

vi.mock("../api/feed", () => ({
  fetchReports: (input: unknown) => fetchReports(input),
  strikeReport: (input: unknown) => strikeReport(input),
  dismissReport: (input: unknown) => dismissReport(input),
}));

const REPORTED: Omit<PostReportView, "reportId"> = {
  reportedAt: "2026-09-18T08:00:00.000Z",
  reporter: { kind: "person", personId: "person-nils", name: "Nils Nord" },
  note: "Det här handlar om mig.",
  audienceKind: "GROUP",
  groupName: "Trädgårdsgruppen",
  groupCreatedBy: {
    kind: "person",
    personId: "person-nils",
    name: "Nils Nord",
  },
  postId: "post-1",
  commentId: null,
  author: { kind: "person", personId: "person-bo", name: "Bo Ek" },
  body: "Något ingen borde skriva.",
  images: [],
  writtenAt: "2026-09-17T09:00:00.000Z",
  struckAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the queue", () => {
  it("shows each reported post with its group, its reporter and the note", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        next: null,
        mayModerate: true,
      }),
    );
    render(<ReportQueue />);

    expect(await screen.findByText("Något ingen borde skriva.")).toBeTruthy();
    expect(screen.getByText("Trädgårdsgruppen")).toBeTruthy();
    expect(
      screen.getByText("Anmält av Nils Nord. Skrivet av Bo Ek."),
    ).toBeTruthy();
    expect(screen.getByText("Det här handlar om mig.")).toBeTruthy();
  });

  it("shows the reported post's images with its text, from the addresses the report gave", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [
          {
            ...REPORTED,
            reportId: "report-1",
            images: [
              {
                id: "file-a",
                url: "/api/media/file-a",
                width: 800,
                height: 600,
              },
              {
                id: "file-b",
                url: "/api/media/file-b",
                width: null,
                height: null,
              },
            ],
          },
        ],
        next: null,
        mayModerate: true,
      }),
    );
    render(<ReportQueue />);

    const first = await screen.findByRole("img", {
      name: "Bild 1 av 2 i inlägget",
    });
    expect(first.getAttribute("src")).toBe("/api/media/file-a");
    expect(
      screen
        .getByRole("img", { name: "Bild 2 av 2 i inlägget" })
        .getAttribute("src"),
    ).toBe("/api/media/file-b");
  });

  it("says nothing is reported when nothing is", async () => {
    fetchReports.mockResolvedValue(
      ok({ reports: [], next: null, mayModerate: true }),
    );
    render(<ReportQueue />);

    expect(await screen.findByText("Ingenting är anmält.")).toBeTruthy();
  });

  it("takes every report about a post off the queue when one is answered", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [
          { ...REPORTED, reportId: "report-1" },
          { ...REPORTED, reportId: "report-2" },
        ],
        next: null,
        mayModerate: true,
      }),
    );
    strikeReport.mockResolvedValue(
      ok({
        ...REPORTED,
        reportId: "report-1",
        struckAt: "2026-09-18T09:00:00.000Z",
      }),
    );
    render(<ReportQueue />);

    const striking = await screen.findAllByRole("button", {
      name: "Stryk över inlägget",
    });
    expect(striking).toHaveLength(2);
    await userEvent.click(striking[0] as HTMLElement);

    expect(strikeReport).toHaveBeenCalledWith({ reportId: "report-1" });
    // Not "nothing is reported": something was, and the board answered it.
    expect(
      await screen.findByText("Alla anmälningar är besvarade. Inget väntar."),
    ).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
  });

  it("lets a post stand, which closes its reports too", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        next: null,
        mayModerate: true,
      }),
    );
    dismissReport.mockResolvedValue(ok({ ...REPORTED, reportId: "report-1" }));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Låt inlägget stå kvar" }),
    );

    expect(dismissReport).toHaveBeenCalledWith({ reportId: "report-1" });
    expect(
      await screen.findByText("Alla anmälningar är besvarade. Inget väntar."),
    ).toBeTruthy();
  });

  it("says a refused answer, and keeps the report", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        next: null,
        mayModerate: true,
      }),
    );
    strikeReport.mockResolvedValue(refused(0, "offline"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Stryk över inlägget" }),
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
  });

  it("takes a report somebody settled first off the queue, and says so", async () => {
    // Another board member, or this one striking the post from its card.
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        next: null,
        mayModerate: true,
      }),
    );
    strikeReport.mockResolvedValue(refused(422, "report-resolved"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Stryk över inlägget" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Styrelsen har redan svarat",
    );
    expect(screen.queryByText("Något ingen borde skriva.")).toBeNull();
  });

  it("keeps a report the server answered as not there, and says so", async () => {
    /*
     * Also the answer to an account whose seat ended after the queue was
     * read: nothing was decided, and the report is still open for the board.
     */
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        next: null,
        mayModerate: true,
      }),
    );
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Stryk över inlägget" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Den anmälan finns inte.",
    );
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
  });

  it("reads the first page again when a report is answered as not there, and drops what the purge took", async () => {
    // The purge erased report-1's post; report-2 is still open.
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [
            { ...REPORTED, reportId: "report-1" },
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: "Stryk över inlägget" })
      )[0] as HTMLElement,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Något ingen borde skriva.")).toBeNull();
    });
    expect(screen.getByText("Det andra inlägget.")).toBeTruthy();
    expect(fetchReports).toHaveBeenCalledTimes(2);
    expect(fetchReports).toHaveBeenLastCalledWith({ after: null });
  });

  it("keeps the rows and the refusal when the first page cannot be read again", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: null,
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(refused(0, "offline"));
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Stryk över inlägget" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Den anmälan finns inte.",
    );
    await waitFor(() => {
      expect(fetchReports).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
  });

  it("drops a page that was on its way when the first page was read again", async () => {
    let landLate: (page: unknown) => void = () => undefined;
    const late = new Promise((resolve) => {
      landLate = resolve;
    });
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [
            { ...REPORTED, reportId: "report-1" },
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: "2026-09-18T08:00:00.000Z|report-2",
          mayModerate: true,
        }),
      )
      // "Visa fler", which the re-read overtakes.
      .mockReturnValueOnce(late)
      .mockResolvedValueOnce(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          // Not the cursor of the first read, so the press below shows which one was kept.
          next: "2026-09-18T09:00:00.000Z|report-2",
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({ reports: [], next: null, mayModerate: true }),
      );
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa fler anmälningar" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", {
        name: "Stryk över inlägget",
      })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(screen.queryByText("Något ingen borde skriva.")).toBeNull();
    });

    await act(async () => {
      landLate(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-3",
              postId: "post-3",
              body: "Sidan från den gamla markören.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
      await late;
    });

    expect(screen.queryByText("Sidan från den gamla markören.")).toBeNull();
    // The cursor of the page read again is the one left, so the rest is still a press away.
    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler anmälningar" }),
    );
    expect(fetchReports).toHaveBeenLastCalledWith({
      after: "2026-09-18T09:00:00.000Z|report-2",
    });
  });

  it("lets a page that was on its way land when the first page cannot be read again", async () => {
    let landLate: (page: unknown) => void = () => undefined;
    const late = new Promise((resolve) => {
      landLate = resolve;
    });
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: "2026-09-18T08:00:00.000Z|report-1",
          mayModerate: true,
        }),
      )
      .mockReturnValueOnce(late)
      .mockResolvedValueOnce(refused(0, "offline"));
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa fler anmälningar" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stryk över inlägget" }),
    );
    await waitFor(() => {
      expect(fetchReports).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      landLate(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
      await late;
    });

    expect(await screen.findByText("Det andra inlägget.")).toBeTruthy();
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
  });

  it("leaves out of a first page read again what the board answered meanwhile", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [
            { ...REPORTED, reportId: "report-1" },
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          reports: [
            // A sibling of the post the board has just let stand.
            { ...REPORTED, reportId: "report-1b" },
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget, uppdaterat.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
    dismissReport.mockResolvedValue(ok({ ...REPORTED, reportId: "report-1" }));
    strikeReport.mockResolvedValue(refused(404, "report-not-found"));
    render(<ReportQueue />);

    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: "Låt inlägget stå kvar" })
      )[0] as HTMLElement,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stryk över inlägget" }),
    );
    await waitFor(() => {
      expect(fetchReports).toHaveBeenCalledTimes(2);
    });

    expect(
      await screen.findByText("Det andra inlägget, uppdaterat."),
    ).toBeTruthy();
    expect(screen.queryByText("Något ingen borde skriva.")).toBeNull();
  });

  it("says when every report shown is answered and more are waiting, and reads them", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: "2026-09-18T08:00:00.000Z|report-1",
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
    dismissReport.mockResolvedValue(ok({ ...REPORTED, reportId: "report-1" }));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Låt inlägget stå kvar" }),
    );

    // Not "nothing is reported", which is not so, and not an empty list.
    expect(
      await screen.findByText(
        "Inga av de lästa anmälningarna står öppna längre. Det finns fler att läsa.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler anmälningar" }),
    );
    expect(await screen.findByText("Det andra inlägget.")).toBeTruthy();
  });

  it("says the queue is the board's to an account with no seat", async () => {
    fetchReports.mockResolvedValue(
      ok({ reports: [], next: null, mayModerate: false }),
    );
    render(<ReportQueue />);

    expect(await screen.findByText(/Den här kön är styrelsens/)).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
  });

  it("names Alla by its kind and links to the post, which the board reads there", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [
          {
            ...REPORTED,
            reportId: "report-1",
            audienceKind: "ALL",
            groupName: null,
            groupCreatedBy: null,
          },
        ],
        next: null,
        mayModerate: true,
      }),
    );
    render(<ReportQueue />);

    expect(await screen.findByText("Alla")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Öppna inlägget i flödet" })
        .getAttribute("href"),
    ).toBe("/feed/post-1");
  });

  it("shows a comment reported out of a group with no way to its post", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [
          {
            ...REPORTED,
            reportId: "report-1",
            postId: null,
            commentId: "comment-1",
            body: "En elak kommentar.",
          },
        ],
        next: null,
        mayModerate: true,
      }),
    );
    strikeReport.mockResolvedValue(
      ok({ ...REPORTED, reportId: "report-1", commentId: "comment-1" }),
    );
    render(<ReportQueue />);

    expect(await screen.findByText("En elak kommentar.")).toBeTruthy();
    expect(screen.getByText("Kommentar")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Stryk över kommentaren" }),
    );
    expect(strikeReport).toHaveBeenCalledWith({ reportId: "report-1" });
    // Not "nothing is reported": something was, and the board answered it.
    expect(
      await screen.findByText("Alla anmälningar är besvarade. Inget väntar."),
    ).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
  });

  it("reads the page after the first from the cursor it was given", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: "2026-09-18T08:00:00.000Z|report-1",
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          reports: [
            {
              ...REPORTED,
              reportId: "report-2",
              postId: "post-2",
              body: "Det andra inlägget.",
            },
          ],
          next: null,
          mayModerate: true,
        }),
      );
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa fler anmälningar" }),
    );

    expect(fetchReports).toHaveBeenLastCalledWith({
      after: "2026-09-18T08:00:00.000Z|report-1",
    });
    expect(await screen.findByText("Det andra inlägget.")).toBeTruthy();
    // Added under the first page, which stays.
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
    // And at the end, there is nothing more to ask for.
    expect(
      screen.queryByRole("button", { name: "Visa fler anmälningar" }),
    ).toBeNull();
  });

  it("leaves out of a later page what the board answered meanwhile", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: "2026-09-18T08:00:00.000Z|report-1",
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          // A sibling report of the post the board has just let stand.
          reports: [{ ...REPORTED, reportId: "report-2" }],
          next: null,
          mayModerate: true,
        }),
      );
    dismissReport.mockResolvedValue(ok({ ...REPORTED, reportId: "report-1" }));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Låt inlägget stå kvar" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Visa fler anmälningar" }),
    );

    expect(
      await screen.findByText("Alla anmälningar är besvarade. Inget väntar."),
    ).toBeTruthy();
  });

  it("says so when a later page cannot be read, and keeps the ones held", async () => {
    fetchReports
      .mockResolvedValueOnce(
        ok({
          reports: [{ ...REPORTED, reportId: "report-1" }],
          next: "2026-09-18T08:00:00.000Z|report-1",
          mayModerate: true,
        }),
      )
      .mockResolvedValueOnce(refused(0, "offline"));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa fler anmälningar" }),
    );

    expect(
      await screen.findByText(
        "Fler anmälningar kunde inte läsas just nu. Försök igen.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
    // Still there to try again.
    expect(
      screen.getByRole("button", { name: "Visa fler anmälningar" }),
    ).toBeTruthy();
  });

  it("says so when the queue cannot be read", async () => {
    fetchReports.mockResolvedValue(refused(0, "offline"));
    render(<ReportQueue />);

    expect(
      await screen.findByText(
        "Anmälningarna kunde inte läsas just nu. Ladda om sidan.",
      ),
    ).toBeTruthy();
  });
});
