import { ISSUE_REPORT_LIMITS } from "@openbrf/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import i18n from "../i18n";
import type {
  IssueApartment,
  IssuePlaceChoice,
  ReportableIssueType,
} from "../api/issues";
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
const fetchReportableTypes = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchReportableTypes: () => fetchReportableTypes(),
  reportIssue: (input: unknown) => reportIssue(input),
  attachIssuePhoto: (issueId: string, file: File) =>
    attachIssuePhoto(issueId, file),
}));

const TYPES: readonly ReportableIssueType[] = [
  {
    id: "type-water",
    name: "Vatten",
    reporters: ["RESIDENTS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
  {
    id: "type-heat",
    name: "Värme",
    reporters: ["RESIDENTS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
];

const APARTMENTS: readonly IssueApartment[] = [
  { id: "apartment-1", number: "1401", address: "Storgatan 12" },
];

const PLACES: readonly IssuePlaceChoice[] = [
  { id: "place-laundry", name: "Tvättstuga" },
  { id: "place-lift", name: "Hiss" },
];

function renderPanel(
  overrides: {
    types?: readonly ReportableIssueType[];
    /** What the types read again at filing hold; the form's own by default. */
    rereadTypes?: readonly ReportableIssueType[];
    places?: readonly IssuePlaceChoice[];
    onReported?: () => void;
  } = {},
) {
  fetchReportableTypes.mockResolvedValue({
    ok: true,
    value: [...(overrides.rereadTypes ?? overrides.types ?? TYPES)],
  });
  return render(
    <ReportIssuePanel
      types={overrides.types ?? TYPES}
      apartments={APARTMENTS}
      places={overrides.places ?? []}
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

  it("is the description field's own description, so direct navigation reads it", () => {
    renderPanel();

    expect(
      screen.getByRole("textbox", {
        name: /vad har hänt/i,
        description: /extern förvaltare/i,
      }),
    ).toBeTruthy();
  });

  it("says who reads a ring-fenced type, what to write and what not to, once it is chosen", async () => {
    const session = userEvent.setup();
    renderPanel({
      types: [
        ...TYPES,
        {
          id: "type-noise",
          name: "Störningar",
          reporters: ["RESIDENTS"],
          ringFenced: true,
          textRetentionYears: 1,
        },
      ],
    });

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-noise",
    );
    // Not the property manager, as the ordinary warning says: only the board.
    expect(screen.getByText(/läses bara av styrelsen/i)).toBeTruthy();
    // What happened, as it was seen and heard, and not an accusation of a
    // crime (GDPR art. 10).
    expect(
      screen.getByText(/beskriv vad som hände, vad du såg och hörde, och när/i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /anklaga inte någon för brott och lämna inte uppgifter ur en polisanmälan/i,
      ),
    ).toBeTruthy();
    // The two things the warning has always kept from the reporter: a guess
    // about who did it, and anybody's health.
    expect(screen.getByText(/vem du tror har gjort det/i)).toBeTruthy();
    expect(screen.getByText(/någons hälsa/i)).toBeTruthy();
    expect(screen.queryByText(/extern förvaltare/i)).toBeNull();
    // Read before the description is written, not after it.
    const warning = screen.getByText(/anklaga inte någon för brott/i);
    const description = screen.getByRole("textbox", {
      name: /vad har hänt/i,
    });
    expect(
      warning.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for what happened, and keeps every prohibition, in both languages", () => {
    const sv = i18n.getFixedT("sv")("issues.ringFence.formWarning");
    const en = i18n.getFixedT("en")("issues.ringFence.formWarning");

    for (const pattern of [
      /beskriv vad som hände, vad du såg och hörde, och när/i,
      /anklaga inte någon för brott/i,
      /polisanmälan/i,
      /vem du tror har gjort det/i,
      /någons hälsa/i,
    ]) {
      expect(sv).toMatch(pattern);
    }
    for (const pattern of [
      /describe what happened, what you saw and heard, and when/i,
      /do not accuse anyone of a crime/i,
      /police report/i,
      /who you think did it/i,
      /anybody's health/i,
    ]) {
      expect(en).toMatch(pattern);
    }
  });

  it("says how long the text is kept, on the clock of the type chosen", async () => {
    // GDPR art. 13(2)(a), where the reporter writes, for an ordinary type and
    // for a ring-fenced one on the board's ring-fenced clock.
    const session = userEvent.setup();
    renderPanel({
      types: [
        ...TYPES,
        {
          id: "type-noise",
          name: "Störningar",
          reporters: ["RESIDENTS"],
          ringFenced: true,
          textRetentionYears: 3,
        },
      ],
    });
    const [ordinary] = TYPES;
    if (ordinary === undefined) throw new Error("the fixture holds a type");

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      ordinary.id,
    );
    expect(
      screen.getByText(/tas bort 2 år efter att ärendet har stängts/i),
    ).toBeTruthy();
    expect(screen.getByText(/aldrig resten av anmälan/i)).toBeTruthy();
    // The photographs a handler chooses to show a contractor are named.
    expect(
      screen.getByText(
        /de bilder som den som hanterar ärendet väljer att visa/i,
      ),
    ).toBeTruthy();
    // What outlasts the board's clock is named: the apartment or common area,
    // the board's power to change the clock, and the work order's ten years.
    expect(
      screen.getByText(/vilken lägenhet eller vilket gemensamt utrymme/i),
    ).toBeTruthy();
    expect(screen.getByText(/styrelsen kan ändra antalet år/i)).toBeTruthy();
    expect(
      screen.getByText(
        /den texten sparas i tio år efter att ärendet har stängts, eller längre så länge ett rättsligt bevarandekrav på ärendet, eller ett rättsligt bevarandekrav eller en begränsning som gäller för den som anmälde ärendet, består/i,
      ),
    ).toBeTruthy();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-noise",
    );
    expect(screen.queryByText(/aldrig resten av anmälan/i)).toBeNull();
    // The ring-fence's own line names the conversation and the photographs
    // beside the text, on the type's clock rather than the other types'.
    expect(
      screen.getByText(
        /det du skriver, konversationen och fotografierna tas bort 3 år efter/i,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/tas bort 2 år efter att ärendet har stängts/i),
    ).toBeNull();
  });

  describe("the retention notice at filing", () => {
    const noise = (years: number): ReportableIssueType => ({
      id: "type-noise",
      name: "Störningar",
      reporters: ["RESIDENTS"],
      ringFenced: true,
      textRetentionYears: years,
    });

    async function fillIn(
      session: ReturnType<typeof userEvent.setup>,
    ): Promise<void> {
      await session.selectOptions(
        screen.getByLabelText(/vad gäller det/i),
        "type-noise",
      );
      await session.type(
        screen.getByRole("textbox", { name: /vad har hänt/i }),
        "Det lät högt i trapphuset.",
      );
    }

    it("files nothing when the board changed the clock since the form opened, and shows the new one", async () => {
      const session = userEvent.setup();
      renderPanel({ types: [...TYPES, noise(1)], rereadTypes: [noise(4)] });
      await fillIn(session);
      expect(screen.getByText(/tas bort 1 år efter/i)).toBeTruthy();

      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );

      expect(
        await screen.findByText(/har ändrats sedan du öppnade/i),
      ).toBeTruthy();
      expect(reportIssue).not.toHaveBeenCalled();
      expect(screen.getByText(/tas bort 4 år efter/i)).toBeTruthy();
      // What was typed stays.
      expect(
        (
          screen.getByRole("textbox", {
            name: /vad har hänt/i,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Det lät högt i trapphuset.");

      // Sent again, now that the notice read is the one that applies.
      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );
      await waitFor(() => {
        expect(reportIssue).toHaveBeenCalledTimes(1);
      });
    });

    it("files nothing when the board only ring-fenced the type, and shows its warning with the draft kept", async () => {
      const session = userEvent.setup();
      const ordinary: ReportableIssueType = { ...noise(1), ringFenced: false };
      renderPanel({ types: [...TYPES, ordinary], rereadTypes: [noise(1)] });
      await fillIn(session);
      expect(screen.getByText(/aldrig resten av anmälan/i)).toBeTruthy();

      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );

      expect(
        await screen.findByText(/har ändrats sedan du öppnade/i),
      ).toBeTruthy();
      expect(reportIssue).not.toHaveBeenCalled();
      // The ring-fenced type's own warning, in place of the ordinary one.
      expect(screen.queryByText(/aldrig resten av anmälan/i)).toBeNull();
      expect(
        screen.getByText(/konversationen och fotografierna/i),
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("textbox", {
            name: /vad har hänt/i,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Det lät högt i trapphuset.");
    });

    it("keeps the draft on the form when the type was ring-fenced under a report from a post", async () => {
      const session = userEvent.setup();
      const ordinary: ReportableIssueType = { ...noise(1), ringFenced: false };
      fetchReportableTypes.mockResolvedValue({
        ok: true,
        value: [noise(1)],
      });
      render(
        <ReportIssuePanel
          types={[ordinary]}
          apartments={APARTMENTS}
          prefill={{
            postId: "post-1",
            description: "Det lät högt i trapphuset.",
            photos: [],
            photosMissing: 0,
          }}
          onReported={() => undefined}
        />,
      );
      await session.selectOptions(
        screen.getByLabelText(/vad gäller det/i),
        "type-noise",
      );

      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );

      expect(
        await screen.findByText(/har ändrats sedan du öppnade/i),
      ).toBeTruthy();
      expect(reportIssue).not.toHaveBeenCalled();
      // Not the empty state: the text and the type are still there to read.
      expect(
        (screen.getByLabelText(/vad har hänt/i) as HTMLTextAreaElement).value,
      ).toBe("Det lät högt i trapphuset.");
      expect(
        screen.getByText(/konversationen och fotografierna/i),
      ).toBeTruthy();
    });

    it("files when the notice is as it was read", async () => {
      const session = userEvent.setup();
      renderPanel({ types: [...TYPES, noise(1)] });
      await fillIn(session);

      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );

      await waitFor(() => {
        expect(reportIssue).toHaveBeenCalledTimes(1);
      });
    });

    it("files nothing when the types cannot be read again", async () => {
      const session = userEvent.setup();
      renderPanel({ types: [...TYPES, noise(1)] });
      fetchReportableTypes.mockResolvedValue({
        ok: false,
        failure: { status: 0, reason: "offline" },
      });
      await fillIn(session);

      await session.click(
        screen.getByRole("button", { name: /skicka anmälan/i }),
      );

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeTruthy();
      });
      expect(reportIssue).not.toHaveBeenCalled();
    });
  });

  it("keeps the intro line for an ordinary type, and drops it for a ring-fenced one", async () => {
    const session = userEvent.setup();
    renderPanel({
      types: [
        ...TYPES,
        {
          id: "type-noise",
          name: "Störningar",
          reporters: ["RESIDENTS"],
          ringFenced: true,
          textRetentionYears: 1,
        },
      ],
    });
    const intro = /styrelsen och förvaltaren läser det här/i;
    const select = screen.getByLabelText(/vad gäller det/i);

    await session.selectOptions(select, "type-water");
    expect(screen.getByText(intro)).toBeTruthy();

    // The intro says the property manager reads the report; the ring-fence
    // warning on the same card says never.
    await session.selectOptions(select, "type-noise");
    expect(screen.queryByText(intro)).toBeNull();

    await session.selectOptions(select, "type-water");
    expect(screen.getByText(intro)).toBeTruthy();
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
        placeId: null,
        location: "Badrummet",
        description: "Det droppar.",
      });
    });
  });

  it("sends a common area chosen beside the free-text place", async () => {
    const session = userEvent.setup();
    renderPanel({ places: PLACES });

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.selectOptions(
      screen.getByLabelText(/gemensamt utrymme/i),
      "place-lift",
    );
    await session.type(screen.getByLabelText(/var i huset/i), "Port 14");
    await session.type(screen.getByLabelText(/vad har hänt/i), "Hissen står.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith({
        typeId: "type-water",
        apartmentId: null,
        placeId: "place-lift",
        location: "Port 14",
        description: "Hissen står.",
      });
    });
  });

  it("sends no common area the board switched off after it was chosen", async () => {
    const session = userEvent.setup();
    const { rerender } = renderPanel({ places: PLACES });

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.selectOptions(
      screen.getByLabelText(/gemensamt utrymme/i),
      "place-lift",
    );
    // A re-read of the lists no longer offers the lift.
    rerender(
      <ReportIssuePanel
        types={TYPES}
        apartments={APARTMENTS}
        places={PLACES.filter((place) => place.id !== "place-lift")}
        onReported={() => undefined}
      />,
    );
    expect(
      screen.getByLabelText<HTMLSelectElement>(/gemensamt utrymme/i).value,
    ).toBe("");

    await session.type(screen.getByLabelText(/vad har hänt/i), "Hissen står.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({ typeId: "type-water", placeId: null }),
      );
    });
  });

  it("offers no common area once an apartment is chosen, and sends none", async () => {
    const session = userEvent.setup();
    renderPanel({ places: PLACES });

    await session.selectOptions(
      screen.getByLabelText(/gemensamt utrymme/i),
      "place-lift",
    );
    await session.selectOptions(
      screen.getByLabelText(/^lägenhet$/i),
      "apartment-1",
    );
    expect(screen.queryByLabelText(/gemensamt utrymme/i)).toBeNull();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Läckan.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledWith(
        expect.objectContaining({ apartmentId: "apartment-1", placeId: null }),
      );
    });
  });

  it("offers no common area while the association keeps none", () => {
    renderPanel();

    expect(screen.queryByLabelText(/gemensamt utrymme/i)).toBeNull();
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

describe("a report made from a post", () => {
  const PREFILL = {
    postId: "post-1",
    description: "Hissen i port 14 står still igen.",
    photos: [
      new File(["bytes"], "Bild 1 från inlägget.jpg", { type: "image/jpeg" }),
    ],
    photosMissing: 0,
  };

  it("opens with the post's text and images, and is linked to the post once", async () => {
    const session = userEvent.setup();
    const onReported = vi.fn();
    render(
      <ReportIssuePanel
        types={TYPES}
        apartments={APARTMENTS}
        prefill={PREFILL}
        onReported={onReported}
      />,
    );

    expect(
      (screen.getByLabelText(/vad har hänt/i) as HTMLTextAreaElement).value,
    ).toBe("Hissen i port 14 står still igen.");
    expect(screen.getByText("Bild 1 från inlägget.jpg")).toBeTruthy();

    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(onReported).toHaveBeenCalledWith("post-1");
    });
    expect(reportIssue).toHaveBeenCalledWith({
      typeId: "type-water",
      apartmentId: null,
      placeId: null,
      location: null,
      description: "Hissen i port 14 står still igen.",
      postId: "post-1",
    });
    expect(attachIssuePhoto).toHaveBeenCalledWith("i-1", PREFILL.photos[0]);

    // A second report from the same form is one of its own.
    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-heat",
    );
    await session.type(screen.getByLabelText(/vad har hänt/i), "Kallt.");
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );
    await waitFor(() => {
      expect(reportIssue).toHaveBeenCalledTimes(2);
    });
    expect(reportIssue).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ postId: expect.anything() as unknown }),
    );
  });

  it("offers no ring-fenced type for a report made from a post", () => {
    render(
      <ReportIssuePanel
        types={[
          ...TYPES,
          {
            id: "type-noise",
            name: "Störningar",
            reporters: ["RESIDENTS"],
            ringFenced: true,
            textRetentionYears: 1,
          },
        ]}
        apartments={APARTMENTS}
        prefill={PREFILL}
        onReported={() => undefined}
      />,
    );

    expect(screen.queryByRole("option", { name: "Störningar" })).toBeNull();
    expect(screen.getByRole("option", { name: "Vatten" })).toBeTruthy();
  });

  it("keeps a ring-fenced type for a follow-up started from a post, which is not linked to it", async () => {
    const session = userEvent.setup();
    const onReported = vi.fn();
    render(
      <ReportIssuePanel
        types={[
          ...TYPES,
          {
            id: "type-noise",
            name: "Störningar",
            reporters: ["RESIDENTS"],
            ringFenced: true,
            textRetentionYears: 1,
          },
        ]}
        apartments={APARTMENTS}
        prefill={PREFILL}
        followUp={{
          id: "issue-earlier",
          typeId: "type-noise",
          typeName: "Störningar",
        }}
        onReported={onReported}
      />,
    );

    expect(
      (screen.getByLabelText(/vad gäller det/i) as HTMLSelectElement).value,
    ).toBe("type-noise");

    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );

    await waitFor(() => {
      expect(onReported).toHaveBeenCalledWith(null);
    });
    expect(reportIssue).toHaveBeenCalledWith({
      typeId: "type-noise",
      apartmentId: null,
      placeId: null,
      location: null,
      description: "Hissen i port 14 står still igen.",
      followsIssueId: "issue-earlier",
    });
  });

  it("says so, and offers no form, when only ring-fenced types are left for a post", () => {
    render(
      <ReportIssuePanel
        types={[
          {
            id: "type-noise",
            name: "Störningar",
            reporters: ["RESIDENTS"],
            ringFenced: true,
            textRetentionYears: 1,
          },
        ]}
        apartments={APARTMENTS}
        prefill={PREFILL}
        onReported={() => undefined}
      />,
    );

    expect(
      screen.getByText(
        /kan inte läggas under någon av de typer du får anmäla/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/inte lagt in några ärendetyper/i)).toBeNull();
    expect(screen.queryByLabelText(/vad gäller det/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /skicka anmälan/i }),
    ).toBeNull();
  });

  it("says when the post was already reported from", async () => {
    reportIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "post-already-reported" },
    });
    const session = userEvent.setup();
    render(
      <ReportIssuePanel
        types={TYPES}
        apartments={APARTMENTS}
        prefill={PREFILL}
        onReported={() => undefined}
      />,
    );
    await session.selectOptions(
      screen.getByLabelText(/vad gäller det/i),
      "type-water",
    );
    await session.click(
      screen.getByRole("button", { name: /skicka anmälan/i }),
    );
    expect(
      await screen.findByText(
        /redan gjort en felanmälan från det här inlägget/i,
      ),
    ).toBeTruthy();
  });
});

describe("the responsibility guide", () => {
  it("shows the guide the board adopted before the fields, folded", async () => {
    const session = userEvent.setup();
    render(
      <ReportIssuePanel
        types={TYPES}
        apartments={APARTMENTS}
        guide={{
          adoptedAt: "2026-10-01T08:00:00.000Z",
          items: [
            {
              part: "Golvbrunn, rensning",
              responsibility: "TENANT_OWNER",
              note: "Rensas minst en gång om året.",
            },
          ],
          version: "2026-10-01T08:00:00.000Z",
        }}
        onReported={() => undefined}
      />,
    );

    const summary = screen.getByText("Vem ansvarar för vad?", {
      selector: "summary",
    });
    expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
    await session.click(summary);
    expect(screen.getByText("Golvbrunn, rensning")).toBeTruthy();
    expect(screen.getByText("Bostadsrättshavaren")).toBeTruthy();
    expect(screen.getByText(/Stadgarna gäller före tabellen/)).toBeTruthy();
    expect(screen.queryByText(/^Exempel/)).toBeNull();
  });

  it("shows nothing where the board has adopted no guide", () => {
    renderPanel();

    expect(screen.queryByText("Vem ansvarar för vad?")).toBeNull();
  });
});
