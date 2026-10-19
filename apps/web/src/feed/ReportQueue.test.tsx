import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PostReportView } from "@openbrf/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { ok, refused } from "./feed-fixtures";
import { ReportQueue } from "./ReportQueue";

/**
 * The board's queue of reported posts: its only way into a group.
 *
 * **The board decides about a post, not about one report of it.** Answering one
 * report takes every report about the same post off the queue, because the
 * server closed them together.
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

vi.mock("../api/feed", () => ({
  fetchReports: () => fetchReports(),
  strikeReport: (input: unknown) => strikeReport(input),
  dismissReport: (input: unknown) => dismissReport(input),
}));

const REPORTED: Omit<PostReportView, "reportId"> = {
  reportedAt: "2026-09-18T08:00:00.000Z",
  reporter: { kind: "person", personId: "person-nils", name: "Nils Nord" },
  note: "Det här handlar om mig.",
  groupName: "Trädgårdsgruppen",
  groupCreatedBy: {
    kind: "person",
    personId: "person-nils",
    name: "Nils Nord",
  },
  postId: "post-1",
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
    fetchReports.mockResolvedValue(ok({ reports: [], mayModerate: true }));
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
    expect(await screen.findByText("Ingenting är anmält.")).toBeTruthy();
  });

  it("lets a post stand, which closes its reports too", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
        mayModerate: true,
      }),
    );
    dismissReport.mockResolvedValue(ok({ ...REPORTED, reportId: "report-1" }));
    render(<ReportQueue />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Låt inlägget stå kvar" }),
    );

    expect(dismissReport).toHaveBeenCalledWith({ reportId: "report-1" });
    expect(await screen.findByText("Ingenting är anmält.")).toBeTruthy();
  });

  it("says a refused answer, and keeps the report", async () => {
    fetchReports.mockResolvedValue(
      ok({
        reports: [{ ...REPORTED, reportId: "report-1" }],
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
    expect(screen.getByText("Något ingen borde skriva.")).toBeTruthy();
  });

  it("says the queue is the board's to an account with no seat", async () => {
    fetchReports.mockResolvedValue(ok({ reports: [], mayModerate: false }));
    render(<ReportQueue />);

    expect(await screen.findByText(/Den här kön är styrelsens/)).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
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
