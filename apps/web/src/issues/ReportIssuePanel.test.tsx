import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { IssueApartment, ReportableIssueType } from "../api/issues";
import { ReportIssuePanel } from "./ReportIssuePanel";

/**
 * The report form.
 *
 * Two of these cases are about promises rather than convenience. The warning
 * above the description is what the law research asks for - issue free text is
 * where health data and a neighbour's details arrive without anybody meaning to
 * put them there - and it has to be standing on the form rather than appearing
 * after a refusal, because it is advice about what to write. And the type
 * picker offers exactly what the server offered it: the filter is the server's,
 * and a form that added a type of its own would be asking for a refusal.
 */

const reportIssue = vi.fn();
const attachIssuePhoto = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  reportIssue: (input: unknown) => reportIssue(input),
  attachIssuePhoto: (issueId: string, file: File) =>
    attachIssuePhoto(issueId, file),
}));

const TYPES: readonly ReportableIssueType[] = [
  { id: "type-water", name: "Vatten", audience: "MEMBER" },
  { id: "type-heat", name: "Värme", audience: "MEMBER" },
];

const APARTMENTS: readonly IssueApartment[] = [
  { id: "apartment-1", number: "1401", address: "Storgatan 12" },
];

function renderPanel(
  overrides: {
    types?: readonly ReportableIssueType[];
    onReported?: () => void;
  } = {},
) {
  return render(
    <ReportIssuePanel
      types={overrides.types ?? TYPES}
      apartments={APARTMENTS}
      onReported={overrides.onReported ?? (() => undefined)}
    />,
  );
}

beforeEach(() => {
  reportIssue.mockReset().mockResolvedValue({ ok: true, value: { id: "i-1" } });
  attachIssuePhoto.mockReset().mockResolvedValue({
    ok: true,
    value: {
      id: "p-1",
      url: "/api/media/f-1",
      fileName: "a.png",
      width: null,
      height: null,
    },
  });
});

describe("the sensitive-data warning", () => {
  it("stands on the form before anything is typed", () => {
    renderPanel();

    // Standing, not a response to a refusal: it is advice about what to write,
    // and it names who reads it - an external property manager included.
    expect(screen.getByText(/extern förvaltare/i)).toBeTruthy();
  });

  it("does not stop a report that reads like personal data", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(
      screen.getByLabelText(/vad har hänt/i),
      "Hantverkaren uppgav referens 19800101-0000.",
    );
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    // Warned about, never refused: a description that looks like a personal
    // identity number may be exactly what the board needs to read.
    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Hantverkaren uppgav referens 19800101-0000.",
        }),
      );
    });
  });
});

describe("the type picker", () => {
  it("offers exactly what the server offered", () => {
    renderPanel();

    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(options).toContain("Vatten");
    expect(options).toContain("Värme");
    // The board's internal categories were never in the response, so there is
    // nothing here to choose them with.
    expect(options).not.toContain("Internt");
  });

  it("says so plainly when the board has configured no types", () => {
    renderPanel({ types: [] });

    expect(screen.getByText(/inte lagt in några ärendetyper/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /skicka anmälan/i }),
    ).toBeNull();
  });
});

describe("filing a report", () => {
  it("sends the apartment and the free-text place with it", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.selectOptions(
      screen.getByLabelText(/^lägenhet$/i),
      "apartment-1",
    );
    await session.type(screen.getByLabelText(/var i huset/i), "Badrummet");
    await session.type(screen.getByLabelText(/vad har hänt/i), "Det droppar.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith({
        typeId: "type-water",
        apartmentId: "apartment-1",
        location: "Badrummet",
        description: "Det droppar.",
      });
    });
  });

  it("hangs the staged photographs on the report once it exists", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Trasig dörr.");

    const photo = new File(["bytes"], "dorr.png", { type: "image/png" });
    await session.upload(screen.getByLabelText(/lägg till foto/i), photo);
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    // A photograph has to hang on something, so the report is filed first and
    // the identifier it answers with is what the upload is addressed to.
    await waitFor(() => {
      expect(attachIssuePhoto).toHaveBeenCalledWith("i-1", photo);
    });
  });

  it("reports a failed photograph without claiming the report failed", async () => {
    attachIssuePhoto.mockResolvedValue({
      ok: false,
      failure: { status: 413, reason: "too-large" },
    });

    const session = userEvent.setup();
    const onReported = vi.fn();
    renderPanel({ onReported });

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Trasig dörr.");
    await session.upload(
      screen.getByLabelText(/lägg till foto/i),
      new File(["bytes"], "dorr.png", { type: "image/png" }),
    );
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/kunde inte läggas till/i)).toBeTruthy();
    });
    // The report itself landed, and the screen must not send somebody away to
    // write it again.
    expect(onReported).toHaveBeenCalled();
  });

  it("says which type is not one this account may report under", async () => {
    reportIssue.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "type-not-found" },
    });

    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Hej.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/kan du inte anmäla under/i)).toBeTruthy();
    });
  });
});
