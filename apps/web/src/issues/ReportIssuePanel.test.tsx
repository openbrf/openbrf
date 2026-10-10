import { ISSUE_REPORT_LIMITS } from "@openbrf/shared";
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
  it("stops the place and the description at the lengths the server takes", () => {
    renderPanel();

    // An overlong report would otherwise be refused only after it was written,
    // with a sentence that cannot say why.
    expect(
      screen.getByLabelText(/var i huset/i).getAttribute("maxlength"),
    ).toBe(String(ISSUE_REPORT_LIMITS.location));
    expect(
      screen.getByLabelText(/vad har hänt/i).getAttribute("maxlength"),
    ).toBe(String(ISSUE_REPORT_LIMITS.description));
  });

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
    // write it again - so the confirmation stands beside the warning rather
    // than being displaced by it.
    expect(screen.getByText(/ligger nu i kön/i)).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
  });

  it("attempts every staged photograph and names the ones that failed", async () => {
    // One refusal is not a verdict on the next file, and the reporter has to be
    // told which photographs are missing: the report is already filed, so
    // sending the form again would file a second one.
    attachIssuePhoto.mockImplementation(async (_issueId: string, file: File) =>
      file.name === "trasig.png"
        ? { ok: false, failure: { status: 413, reason: "too-large" } }
        : {
            ok: true,
            value: {
              id: "p-1",
              url: "/api/media/f-1",
              fileName: file.name,
              width: null,
              height: null,
            },
          },
    );

    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Trasig dörr.");
    await session.upload(screen.getByLabelText(/lägg till foto/i), [
      new File(["bytes"], "trasig.png", { type: "image/png" }),
      new File(["bytes"], "hel.png", { type: "image/png" }),
    ]);
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(attachIssuePhoto).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/trasig\.png/)).toBeTruthy();
    expect(screen.queryByText(/hel\.png/)).toBeNull();
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

describe("while a report is being filed", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    reportIssue.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once the report is filed", { ok: true, value: { id: "i-1" } }],
    [
      "when the report is refused",
      { ok: false, failure: { status: 404, reason: "type-not-found" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the fields are cleared", async () => {
    const session = userEvent.setup();
    const settle = holdRequest();
    renderPanel();

    const place = screen.getByLabelText<HTMLInputElement>(/var i huset/i);
    const description =
      screen.getByLabelText<HTMLTextAreaElement>(/vad har hänt/i);
    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(place, "Badrummet");
    await session.type(description, "Det droppar.");
    expect(description.matches(":disabled")).toBe(false);

    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(description.matches(":disabled")).toBe(true);
    });
    expect(place.matches(":disabled")).toBe(true);
    expect(screen.getByLabelText(/vad gäller det/i).matches(":disabled")).toBe(
      true,
    );
    await session.type(description, "9");
    await session.type(place, "x");
    expect(description.value).toBe("Det droppar.");
    expect(place.value).toBe("Badrummet");

    settle({ ok: true, value: { id: "i-1" } });

    await waitFor(() => {
      expect(description.matches(":disabled")).toBe(false);
    });
    expect(description.value).toBe("");
    expect(place.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the place field after Enter, %s",
    async (_case, outcome) => {
      const session = userEvent.setup();
      const settle = holdRequest();
      renderPanel();

      const place = screen.getByLabelText<HTMLInputElement>(/var i huset/i);
      await session.selectOptions(
        screen.getByLabelText(/vad gäller det/i),
        "type-water",
      );
      await session.type(
        screen.getByLabelText(/vad har hänt/i),
        "Det droppar.",
      );
      await session.type(place, "Badrummet{Enter}");

      await waitFor(() => {
        expect(place.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(place, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(place.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(place);
      });
    },
  );
});
