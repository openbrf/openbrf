import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueResidentChoice, IssueTypeView } from "../api/issues";
import { OpenIssuePanel } from "./OpenIssuePanel";

/**
 * Opening an issue as a handler (decision 14).
 *
 * The case worth having is how a resident is named. Every handler, the
 * property manager included, picks the apartment and then who lives there
 * today, from a picker that is not the address book: no search, a protected
 * resident unnamed, and the residents read only once an apartment is chosen,
 * newest answer only.
 */

const openIssue = vi.fn();
const fetchIssueApartments = vi.fn();
const fetchIssueResidents = vi.fn();
const fetchBoardRegister = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  openIssue: (input: unknown) => openIssue(input),
  fetchIssueApartments: () => fetchIssueApartments(),
  fetchIssueResidents: (apartmentId: string) =>
    fetchIssueResidents(apartmentId),
}));

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: AbortSignal) =>
    fetchBoardRegister(query, signal),
}));

const TYPES: IssueTypeView[] = [
  {
    id: "type-water",
    name: "Vatten",
    reporters: ["RESIDENTS"],
    active: true,
    sortOrder: 0,
    handledBy: "EVERY_HANDLER",
    defaultPriority: "URGENT",
    ringFenced: false,
    reportCount: 0,
    statuses: [],
  },
  {
    id: "type-old",
    name: "Gammal typ",
    reporters: ["RESIDENTS"],
    active: false,
    sortOrder: 1,
    handledBy: "EVERY_HANDLER",
    defaultPriority: "NORMAL",
    ringFenced: false,
    reportCount: 3,
    statuses: [],
  },
];

const APARTMENTS = [
  { id: "a-1401", number: "1401", address: "Storgatan 12" },
  { id: "a-1402", number: "1402", address: "Storgatan 12" },
];

const RESIDENTS: Record<string, IssueResidentChoice[]> = {
  "a-1401": [
    { kind: "person", residencyId: "r-rune", name: "Rune Boende" },
    { kind: "protected", residencyId: "r-shield-1" },
    { kind: "protected", residencyId: "r-shield-2" },
  ],
  "a-1402": [{ kind: "person", residencyId: "r-tove", name: "Tove Boende" }],
};

beforeEach(() => {
  openIssue.mockReset().mockResolvedValue({ ok: true, value: {} });
  fetchIssueApartments
    .mockReset()
    .mockResolvedValue({ ok: true, value: APARTMENTS });
  fetchIssueResidents
    .mockReset()
    .mockImplementation((apartmentId: string) =>
      Promise.resolve({ ok: true, value: RESIDENTS[apartmentId] ?? [] }),
    );
  fetchBoardRegister.mockReset();
});

async function fillIn(session: ReturnType<typeof userEvent.setup>) {
  await session.selectOptions(
    screen.getByLabelText("Vad gäller det"),
    "type-water",
  );
  await session.type(screen.getByLabelText("Vad har hänt"), "Ringde om dörren");
}

async function chooseApartment(
  session: ReturnType<typeof userEvent.setup>,
  apartmentId: string,
) {
  const select = screen.getByLabelText<HTMLSelectElement>("Lägenhet");
  await waitFor(() => {
    expect(select.disabled).toBe(false);
  });
  await session.selectOptions(select, apartmentId);
}

describe("opening an issue as a handler", () => {
  it("opens an internal issue under a switched-on type, reads no residents, and reads the queue again", async () => {
    const onOpened = vi.fn();
    const session = userEvent.setup();
    render(<OpenIssuePanel types={TYPES} onOpened={onOpened} />);

    expect(screen.queryByRole("option", { name: "Gammal typ" })).toBeNull();
    await session.selectOptions(
      screen.getByLabelText("Vad gäller det"),
      "type-water",
    );
    await session.type(
      screen.getByLabelText("Vad har hänt"),
      "Trasig lampa i trapphuset",
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg upp ärendet" }),
    );

    await waitFor(() => {
      expect(openIssue).toHaveBeenCalledWith({
        typeId: "type-water",
        description: "Trasig lampa i trapphuset",
      });
    });
    expect(onOpened).toHaveBeenCalled();
    expect(
      await screen.findByText("Ärendet är upplagt och ligger i kön."),
    ).toBeTruthy();
    // Who lives where is read only for an apartment somebody chose.
    expect(fetchIssueResidents).not.toHaveBeenCalled();
  });

  it("names a resident from the apartment's residents today, by residency, and never searches the register", async () => {
    const session = userEvent.setup();
    render(<OpenIssuePanel types={TYPES} onOpened={() => undefined} />);

    // No free-text field to search anybody by.
    expect(screen.queryByRole("textbox", { name: "Åt en boende" })).toBeNull();
    await chooseApartment(session, "a-1401");
    expect(fetchIssueResidents).toHaveBeenCalledWith("a-1401");
    const resident = screen.getByLabelText<HTMLSelectElement>("Åt en boende");
    await waitFor(() => {
      expect(resident.disabled).toBe(false);
    });
    await session.selectOptions(resident, "r-rune");
    await fillIn(session);
    await session.click(
      screen.getByRole("button", { name: "Lägg upp ärendet" }),
    );

    await waitFor(() => {
      expect(openIssue).toHaveBeenCalledWith({
        typeId: "type-water",
        residencyId: "r-rune",
        description: "Ringde om dörren",
      });
    });
    expect(fetchBoardRegister).not.toHaveBeenCalled();
    // The form starts over, with no apartment and so no residents shown.
    await waitFor(() => {
      expect(screen.queryByLabelText("Åt en boende")).toBeNull();
    });
  });

  it("shows a protected resident as protected, numbered where there are several", async () => {
    const session = userEvent.setup();
    render(<OpenIssuePanel types={TYPES} onOpened={() => undefined} />);

    await chooseApartment(session, "a-1401");
    expect(
      await screen.findByRole("option", {
        name: "Namn som inte visas 1 (skyddade personuppgifter)",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: "Namn som inte visas 2 (skyddade personuppgifter)",
      }),
    ).toBeTruthy();
  });

  it("drops a choice of resident when the apartment changes, and an answer for an apartment left behind", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    fetchIssueResidents.mockImplementation((apartmentId: string) =>
      apartmentId === "a-1401"
        ? new Promise((resolve) => {
            answerFirst = resolve;
          })
        : Promise.resolve({ ok: true, value: RESIDENTS["a-1402"] }),
    );
    const session = userEvent.setup();
    render(<OpenIssuePanel types={TYPES} onOpened={() => undefined} />);

    await chooseApartment(session, "a-1401");
    await chooseApartment(session, "a-1402");
    expect(
      await screen.findByRole("option", { name: "Tove Boende" }),
    ).toBeTruthy();

    // The first apartment's answer lands late, and is not shown under 1402.
    answerFirst({ ok: true, value: RESIDENTS["a-1401"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("option", { name: "Rune Boende" })).toBeNull();

    await session.selectOptions(
      screen.getByLabelText("Åt en boende"),
      "r-tove",
    );
    await chooseApartment(session, "a-1401");
    await fillIn(session);
    await session.click(
      screen.getByRole("button", { name: "Lägg upp ärendet" }),
    );
    await waitFor(() => {
      expect(openIssue).toHaveBeenCalled();
    });
    expect(openIssue.mock.calls[0]?.[0]).not.toHaveProperty("residencyId");
  });

  it("says when the residents could not be read, and reads them again on request", async () => {
    fetchIssueResidents
      .mockResolvedValueOnce({ ok: false, failure: { kind: "network" } })
      .mockResolvedValueOnce({ ok: true, value: RESIDENTS["a-1402"] });
    const session = userEvent.setup();
    render(<OpenIssuePanel types={TYPES} onOpened={() => undefined} />);

    await chooseApartment(session, "a-1402");
    expect(
      await screen.findByText(
        /Det gick inte att läsa vilka som bor i lägenheten/,
      ),
    ).toBeTruthy();
    await session.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(
      await screen.findByRole("option", { name: "Tove Boende" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Det gick inte att läsa vilka som bor i lägenheten/),
    ).toBeNull();
  });
  it("does not send a type that was switched off after it was picked", async () => {
    const session = userEvent.setup();
    const ringFenced = {
      ...TYPES[0],
      id: "type-noise",
      name: "Störningar",
      ringFenced: true,
    };
    const { rerender } = render(
      <OpenIssuePanel
        types={[...TYPES, ringFenced]}
        onOpened={() => undefined}
      />,
    );

    await session.selectOptions(
      screen.getByLabelText("Vad gäller det"),
      "type-noise",
    );
    await session.type(screen.getByLabelText("Vad har hänt"), "Ljud i natt");
    const submit = screen.getByRole("button", { name: "Lägg upp ärendet" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    // The board switches the type off while the form is open.
    rerender(
      <OpenIssuePanel
        types={[...TYPES, { ...ringFenced, active: false }]}
        onOpened={() => undefined}
      />,
    );

    // The select shows none chosen, so none is sent.
    expect(
      screen.getByLabelText<HTMLSelectElement>("Vad gäller det").value,
    ).toBe("");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("ties the warning to the description field", async () => {
    render(<OpenIssuePanel types={TYPES} onOpened={() => undefined} />);

    expect(
      screen.getByLabelText("Vad har hänt").getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", {
        name: "Vad har hänt",
        description: /extern förvaltare/i,
      }),
    ).toBeTruthy();
  });
});
