import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ConfiguredIssueType, IssueStatusView } from "../api/issues";
import { IssueTypesPanel } from "./IssueTypesPanel";

/**
 * The board's catalogue of issue types.
 *
 * Who may report a type decides who is shown what: a type the website's form
 * may report appears on a form anyone can reach, and one for handlers only is
 * the association's own note to itself. So it is on the row, in words, where a
 * board member changing a name cannot move a category between those without
 * seeing it happen.
 *
 * Each type's statuses are the board's to name and add to (ADR 0054), each
 * under one of four fixed meanings; the default of a meaning stays switched on.
 *
 * And a read that could not be made says so without a loading line under it. The
 * notice belongs to the read that produced it: the next read says it is reading
 * rather than wearing the last one's failure, and a refresh that did not land
 * leaves the catalogue on screen.
 */

const fetchIssueTypes = vi.fn();
const createIssueType = vi.fn();
const updateIssueType = vi.fn();
const removeIssueType = vi.fn();
const addIssueStatus = vi.fn();
const changeIssueStatus = vi.fn();
const fetchIssueTypeHandlers = vi.fn();
const setIssueTypeRingFence = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueTypes: () => fetchIssueTypes(),
  createIssueType: (input: unknown) => createIssueType(input),
  updateIssueType: (input: unknown) => updateIssueType(input),
  removeIssueType: (id: string) => removeIssueType(id),
  addIssueStatus: (input: unknown) => addIssueStatus(input),
  changeIssueStatus: (input: unknown) => changeIssueStatus(input),
  fetchIssueTypeHandlers: () => fetchIssueTypeHandlers(),
  setIssueTypeRingFence: (input: unknown) => setIssueTypeRingFence(input),
}));

/** A board member, an administrator and the property manager. */
const HANDLERS = [
  {
    handler: { kind: "person", personId: "p-board", name: "Bea Styrelse" },
    board: true,
  },
  {
    handler: { kind: "protected", personId: "p-shielded" },
    board: true,
  },
  {
    handler: {
      kind: "person",
      personId: "p-manager",
      name: "Frida Förvaltare",
    },
    board: false,
  },
];

function status(
  overrides: Partial<IssueStatusView> & Pick<IssueStatusView, "id">,
): IssueStatusView {
  return {
    meaning: "NEW",
    label: "Ny",
    isDefault: true,
    active: true,
    sortOrder: 0,
    issueCount: 0,
    ...overrides,
  };
}

const DEFAULT_STATUSES: IssueStatusView[] = [
  status({ id: "s-new", meaning: "NEW", label: "Ny" }),
  status({ id: "s-doing", meaning: "IN_PROGRESS", label: "Pågår" }),
  status({ id: "s-waiting", meaning: "WAITING", label: "Väntar" }),
  status({ id: "s-done", meaning: "DONE", label: "Klar" }),
];

function type(
  overrides: Partial<ConfiguredIssueType> = {},
): ConfiguredIssueType {
  return {
    id: "type-water",
    name: "Vatten",
    reporters: ["RESIDENTS"],
    active: true,
    sortOrder: 0,
    handledBy: "EVERY_HANDLER",
    defaultPriority: "NORMAL",
    defaultAssignee: null,
    ringFenced: false,
    reportCount: 0,
    statuses: DEFAULT_STATUSES,
    ...overrides,
  };
}

beforeEach(() => {
  fetchIssueTypeHandlers
    .mockReset()
    .mockResolvedValue({ ok: true, value: HANDLERS });
  fetchIssueTypes.mockReset().mockResolvedValue({ ok: true, value: [type()] });
  createIssueType.mockReset().mockResolvedValue({ ok: true, value: type() });
  updateIssueType.mockReset().mockResolvedValue({ ok: true, value: type() });
  removeIssueType.mockReset().mockResolvedValue({ ok: true, value: undefined });
  addIssueStatus.mockReset().mockResolvedValue({ ok: true, value: type() });
  changeIssueStatus.mockReset().mockResolvedValue({ ok: true, value: type() });
  setIssueTypeRingFence
    .mockReset()
    .mockResolvedValue({ ok: true, value: type({ ringFenced: true }) });
});

async function shown(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText("Vatten")).toBeTruthy();
  });
}

describe("the ring-fence", () => {
  it("is set through its own request and nothing else, and the list is read again", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    const box = screen.getByLabelText(
      "Vatten: avskärmad, inget når en entreprenör",
    );
    expect(box).toHaveProperty("checked", false);
    await session.click(box);

    await waitFor(() => {
      expect(setIssueTypeRingFence).toHaveBeenCalledWith({
        id: "type-water",
        ringFenced: true,
      });
    });
    expect(updateIssueType).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchIssueTypes).toHaveBeenCalledTimes(2);
    });
  });

  it("is lifted by clearing the box of a ring-fenced type", async () => {
    fetchIssueTypes
      .mockResolvedValueOnce({
        ok: true,
        value: [type({ ringFenced: true })],
      })
      .mockResolvedValue({
        ok: true,
        value: [type({ ringFenced: false })],
      });
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    const box = screen.getByLabelText(
      "Vatten: avskärmad, inget når en entreprenör",
    );
    expect(box).toHaveProperty("checked", true);
    await session.click(box);

    await waitFor(() => {
      expect(setIssueTypeRingFence).toHaveBeenCalledWith({
        id: "type-water",
        ringFenced: false,
      });
    });
    // The list read again after the save shows the fence lifted.
    await waitFor(() => {
      expect(fetchIssueTypes).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Vatten: avskärmad, inget når en entreprenör"),
      ).toHaveProperty("checked", false);
    });
  });
});

describe("who may report a type", () => {
  it("is shown in words on every row", async () => {
    render(<IssueTypesPanel />);
    await shown();

    expect(screen.getByLabelText("Vatten: Boende")).toHaveProperty(
      "checked",
      true,
    );
    expect(
      screen.getByLabelText("Vatten: Webbplatsens formulär"),
    ).toHaveProperty("checked", false);
  });

  it("is saved as its own act, so moving one is deliberate", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    await session.click(screen.getByLabelText("Vatten: Webbplatsens formulär"));

    await waitFor(() => {
      expect(updateIssueType).toHaveBeenCalledWith({
        id: "type-water",
        values: {
          name: "Vatten",
          reporters: ["PUBLIC", "RESIDENTS"],
          active: true,
          sortOrder: 0,
        },
      });
    });
  });

  it("keeps the last group, since a type nobody may report is switched off", async () => {
    render(<IssueTypesPanel />);
    await shown();

    expect(screen.getByLabelText("Vatten: Boende")).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("the controls on a row", () => {
  it("say which type they act on, so two rows can be told apart", async () => {
    // A screen reader lists controls by name. With the same "Erbjuds", "Ta bort"
    // on every row, there was no telling which type a control would change.
    fetchIssueTypes.mockResolvedValue({
      ok: true,
      value: [type(), type({ id: "type-heat", name: "Värme", sortOrder: 1 })],
    });

    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Värme")).toBeTruthy();
    });
    for (const name of ["Vatten", "Värme"]) {
      expect(screen.getByLabelText(`${name}: Boende`)).toBeTruthy();
      expect(
        screen.getByLabelText(`${name}: erbjuds för nya anmälningar`),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: `Ta bort ${name}` }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: `Lägg till en status för ${name}`,
        }),
      ).toBeTruthy();
    }
  });
});

describe("the statuses of a type", () => {
  it("are listed with the meaning each one has", async () => {
    render(<IssueTypesPanel />);
    await shown();

    const statuses = screen.getByRole("region", {
      name: "Statusar för Vatten",
    });
    expect(
      within(statuses).getByLabelText("Väntar (Väntar): namn"),
    ).toHaveProperty("value", "Väntar");
  });

  it("can be renamed, and the board's own words are what is sent", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    const label = screen.getByLabelText("Väntar (Väntar): namn");
    const rename = screen.getByRole("button", { name: "Byt namn på Väntar" });
    expect(rename).toHaveProperty("disabled", true);

    await session.clear(label);
    await session.type(label, "  Väntar på styrelsebeslut ");
    await session.click(rename);

    await waitFor(() => {
      expect(changeIssueStatus).toHaveBeenCalledWith({
        typeId: "type-water",
        statusId: "s-waiting",
        values: { label: "Väntar på styrelsebeslut" },
      });
    });
  });

  it("refuses a name that is only whitespace before it is sent", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    const label = screen.getByLabelText("Väntar (Väntar): namn");
    await session.clear(label);
    await session.type(label, "   ");

    expect(
      screen.getByRole("button", { name: "Byt namn på Väntar" }),
    ).toHaveProperty("disabled", true);
  });

  it("can be added under a meaning", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    await session.selectOptions(
      screen.getByLabelText("Vatten: den nya statusen betyder"),
      "WAITING",
    );
    await session.type(
      screen.getByLabelText("Vatten: namn på den nya statusen"),
      "Väntar på reservdelar",
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg till en status för Vatten" }),
    );

    await waitFor(() => {
      expect(addIssueStatus).toHaveBeenCalledWith({
        typeId: "type-water",
        meaning: "WAITING",
        label: "Väntar på reservdelar",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Vatten: namn på den nya statusen"),
      ).toHaveProperty("value", "");
    });
  });

  it("keeps the default of a meaning switched on, and lets another take its place", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: true,
      value: [
        type({
          statuses: [
            ...DEFAULT_STATUSES,
            status({
              id: "s-contractor",
              meaning: "IN_PROGRESS",
              label: "Hos rörmokaren",
              isDefault: false,
              sortOrder: 1,
            }),
          ],
        }),
      ],
    });
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    expect(screen.getByLabelText("Pågår (Pågår): erbjuds")).toHaveProperty(
      "disabled",
      true,
    );
    await session.click(
      screen.getByRole("button", {
        name: "Gör Hos rörmokaren till standard för Pågår",
      }),
    );

    await waitFor(() => {
      expect(changeIssueStatus).toHaveBeenCalledWith({
        typeId: "type-water",
        statusId: "s-contractor",
        values: { label: "Hos rörmokaren", isDefault: true },
      });
    });
  });

  it("explains the refusal to switch off a default", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: true,
      value: [
        type({
          statuses: [
            ...DEFAULT_STATUSES,
            status({
              id: "s-contractor",
              meaning: "IN_PROGRESS",
              label: "Hos rörmokaren",
              isDefault: false,
              sortOrder: 1,
            }),
          ],
        }),
      ],
    });
    changeIssueStatus.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "default-status-required" },
    });
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    await session.click(
      screen.getByLabelText("Hos rörmokaren (Pågår): erbjuds"),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/gör en annan status till standard först/i),
      ).toBeTruthy();
    });
  });
});

describe("removing a type", () => {
  it("is offered only while nothing has been filed under it", async () => {
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Ta bort Vatten" })).toBeTruthy();
  });

  it("is withheld once reports exist, because they say what they were about through it", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: true,
      value: [type({ reportCount: 3 })],
    });

    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Ta bort Vatten" })).toBeNull();
    expect(screen.getByText(/anmälningar: 3/i)).toBeTruthy();
  });

  it("explains the refusal when the server catches it first", async () => {
    // A report filed between the read and the click: the board is told to
    // deactivate rather than left with a button that failed.
    removeIssueType.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "type-in-use" },
    });

    const session = userEvent.setup();
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: "Ta bort Vatten" }));

    await waitFor(() => {
      expect(screen.getByText(/stäng av den i stället/i)).toBeTruthy();
    });
  });
});

describe("adding a type", () => {
  it("sends the name and the groups the board chose", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });

    await session.type(screen.getByLabelText(/^namn$/i), "Tvättstugan");
    // Residents are chosen to begin with.
    await session.click(
      screen.getByRole("checkbox", { name: "Bara den som hanterar ärenden" }),
    );
    await session.click(screen.getByRole("button", { name: /lägg till typ/i }));

    await waitFor(() => {
      expect(createIssueType).toHaveBeenCalledWith({
        name: "Tvättstugan",
        reporters: ["RESIDENTS", "HANDLERS"],
        sortOrder: 1,
      });
    });
  });

  it("asks for at least one group who may report it", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await shown();

    await session.type(screen.getByLabelText(/^namn$/i), "Tvättstugan");
    await session.click(screen.getByRole("checkbox", { name: "Boende" }));

    expect(screen.getByText(/välj minst en grupp/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /lägg till typ/i }),
    ).toHaveProperty("disabled", true);
  });
});

describe("a catalogue that could not be read", () => {
  const LOAD_FAILED = "Ärendetyperna kunde inte läsas just nu. Ladda om sidan.";
  const LOADING = "Hämtar typerna...";

  it("says so, and stops saying it is reading", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText(LOAD_FAILED)).toBeTruthy();
    });
    // The read is over, so a loading line under the notice would go on saying
    // something is still happening when nothing is.
    expect(screen.queryByText(LOADING)).toBeNull();
    // The form to enter an issue type is still there: nothing about a
    // catalogue that could not be read stops a board entering the next one.
    expect(screen.getByRole("button", { name: /lägg till typ/i })).toBeTruthy();
  });

  it("does not carry the notice into the read an act asks for", async () => {
    /*
     * The failure belongs to the read that produced it, and the assertion is
     * about the moment the next read is in flight - which is the only moment the
     * two behaviours differ, because a read that lands clears the notice either
     * way.
     *
     * Carried over, the sentence about a catalogue that could not be read would
     * sit above the read that is happening, and with no list yet the panel would
     * draw it with no loading line under it and no read left in flight to end
     * it: a panel that reads as broken rather than as loading.
     *
     * So the second read is held open here rather than resolved, and both halves
     * are asserted while it is: the notice gone, and the panel saying it is
     * reading.
     */
    fetchIssueTypes.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    let answer: (result: unknown) => void = () => undefined;
    fetchIssueTypes.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const session = userEvent.setup();
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText(LOAD_FAILED)).toBeTruthy();
    });

    await session.type(screen.getByLabelText(/^namn$/i), "Tvättstugan");
    await session.click(screen.getByRole("button", { name: /lägg till typ/i }));

    // The read the add asked for is still open at this point.
    await waitFor(() => {
      expect(screen.getByText(LOADING)).toBeTruthy();
    });
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();

    // Answered, so the test leaves no read in flight and the catalogue it was
    // waiting for is what lands.
    answer({ ok: true, value: [type()] });
    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
  });

  it("keeps the catalogue it already has when a re-read of it fails", async () => {
    // The other half of the same rule, and the reason the outcome is held on the
    // read rather than as one flag: the rows are still the last thing the server
    // said, and a refresh that did not land is no reason to take the board's own
    // catalogue off the screen.
    const session = userEvent.setup();
    render(<IssueTypesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    fetchIssueTypes.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    // The change succeeds; the read it asks for afterwards is what fails.
    await session.click(screen.getByLabelText("Vatten: Webbplatsens formulär"));

    await waitFor(() => {
      expect(screen.getByText(LOAD_FAILED)).toBeTruthy();
    });
    expect(screen.getByText("Vatten")).toBeTruthy();
    // And no loading line: the read is over, and one under the notice would go
    // on saying something is still happening.
    expect(screen.queryByText(LOADING)).toBeNull();
  });
});

describe("while a type is being added", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    createIssueType.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once the type is stored", { ok: true, value: type() }],
    [
      "when the type is refused",
      { ok: false, failure: { status: 422, reason: "invalid-body" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the name is cleared", async () => {
    const session = userEvent.setup();
    const settle = holdRequest();
    render(<IssueTypesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });

    const name = screen.getByLabelText<HTMLInputElement>("Namn");
    const residents = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Boende",
    });
    await session.type(name, "Värme");
    expect(name.matches(":disabled")).toBe(false);

    await session.click(screen.getByRole("button", { name: "Lägg till typ" }));

    await waitFor(() => {
      expect(name.matches(":disabled")).toBe(true);
    });
    expect(residents.matches(":disabled")).toBe(true);
    await session.type(name, "x");
    expect(name.value).toBe("Värme");

    settle({ ok: true, value: type() });

    await waitFor(() => {
      expect(name.matches(":disabled")).toBe(false);
    });
    expect(name.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the name field after Enter, %s",
    async (_case, outcome) => {
      const session = userEvent.setup();
      const settle = holdRequest();
      render(<IssueTypesPanel />);
      await waitFor(() => {
        expect(screen.getByText("Vatten")).toBeTruthy();
      });

      const name = screen.getByLabelText<HTMLInputElement>("Namn");
      await session.type(name, "Värme{Enter}");

      await waitFor(() => {
        expect(name.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(name, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(name.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(name);
      });
    },
  );
});

describe("who handles a type, and what it is filed with", () => {
  it("hands a type to the board, saving the rest of its settings as they are", async () => {
    updateIssueType.mockResolvedValue({ ok: true, value: type() });
    const user = userEvent.setup();
    render(<IssueTypesPanel />);

    await user.selectOptions(
      await screen.findByLabelText("Vatten: vem hanterar"),
      "BOARD",
    );

    expect(updateIssueType).toHaveBeenCalledWith({
      id: "type-water",
      values: {
        name: "Vatten",
        reporters: ["RESIDENTS"],
        active: true,
        sortOrder: 0,
        handledBy: "BOARD",
      },
    });
  });

  it("files a type at the priority the board chooses", async () => {
    updateIssueType.mockResolvedValue({ ok: true, value: type() });
    const user = userEvent.setup();
    render(<IssueTypesPanel />);

    await user.selectOptions(
      await screen.findByLabelText("Vatten: prioritet när det anmäls"),
      "URGENT",
    );

    expect(updateIssueType).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ defaultPriority: "URGENT" }),
      }),
    );
  });

  it("offers every handler as the default assignee, a protected one without a name", async () => {
    const user = userEvent.setup();
    updateIssueType.mockResolvedValue({ ok: true, value: type() });
    render(<IssueTypesPanel />);

    const select = await screen.findByLabelText(
      "Vatten: ansvarig när det anmäls",
    );
    await waitFor(() => {
      expect((select as HTMLSelectElement).disabled).toBe(false);
    });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Ingen: meddela alla som hanterar",
      "Bea Styrelse",
      "Namnet visas inte (skyddade personuppgifter)",
      "Frida Förvaltare",
    ]);

    await user.selectOptions(select, "p-manager");
    expect(updateIssueType).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          defaultAssigneePersonId: "p-manager",
        }),
      }),
    );
  });

  it("reads who may be the default again after a save, when the first read failed", async () => {
    fetchIssueTypeHandlers.mockReset().mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    fetchIssueTypeHandlers.mockResolvedValue({ ok: true, value: HANDLERS });
    updateIssueType.mockResolvedValue({ ok: true, value: type() });
    const user = userEvent.setup();
    render(<IssueTypesPanel />);

    const select = (await screen.findByLabelText(
      "Vatten: ansvarig när det anmäls",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(fetchIssueTypeHandlers).toHaveBeenCalledTimes(1);
    });
    expect(select.disabled).toBe(true);

    await user.selectOptions(
      await screen.findByLabelText("Vatten: prioritet när det anmäls"),
      "URGENT",
    );

    await waitFor(() => {
      expect(fetchIssueTypeHandlers).toHaveBeenCalledTimes(2);
      expect(
        (
          screen.getByLabelText(
            "Vatten: ansvarig när det anmäls",
          ) as HTMLSelectElement
        ).disabled,
      ).toBe(false);
    });
  });

  it("offers only the board on a type the board handles alone", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: true,
      value: [type({ handledBy: "BOARD" })],
    });
    render(<IssueTypesPanel />);

    const select = await screen.findByLabelText(
      "Vatten: ansvarig när det anmäls",
    );
    await waitFor(() => {
      expect((select as HTMLSelectElement).disabled).toBe(false);
    });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "p-board", "p-shielded"]);
  });
});
