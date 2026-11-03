import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueTypeView } from "../api/issues";
import { OpenIssuePanel } from "./OpenIssuePanel";

/**
 * Opening an issue as a handler (decision 14).
 *
 * The case worth having is who may name a resident. A resident is chosen from
 * the address book, which the property manager never reads, so the field is
 * offered only to a handler who does; the property manager opens internal
 * issues, and is told so rather than shown a field that would be refused.
 */

const openIssue = vi.fn();
const fetchBoardRegister = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  openIssue: (input: unknown) => openIssue(input),
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
    reportCount: 3,
    statuses: [],
  },
];

beforeEach(() => {
  openIssue.mockReset().mockResolvedValue({ ok: true, value: {} });
  fetchBoardRegister.mockReset().mockResolvedValue({
    rows: [
      {
        personId: "p-rune",
        name: "Rune Boende",
        apartment: { id: "a-1401", addressId: "ad", number: "1401", floor: 4 },
        movedOutOn: null,
      },
    ],
    stats: { apartments: 1, persons: 1, members: 1 },
    page: 1,
    total: 1,
    addresses: [],
  });
});

describe("opening an issue as a handler", () => {
  it("opens an internal issue under a switched-on type, and reads the queue again", async () => {
    const onOpened = vi.fn();
    const session = userEvent.setup();
    render(
      <OpenIssuePanel
        types={TYPES}
        canNameResident={false}
        onOpened={onOpened}
      />,
    );

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
  });

  it("offers the property manager no resident to name, and says why", () => {
    render(
      <OpenIssuePanel
        types={TYPES}
        canNameResident={false}
        onOpened={() => undefined}
      />,
    );

    expect(screen.queryByLabelText("Åt en boende")).toBeNull();
    expect(
      screen.getByText(/Du lägger upp interna ärenden utan anmälare/),
    ).toBeTruthy();
    expect(fetchBoardRegister).not.toHaveBeenCalled();
  });

  it("lets a handler who reads the address book name a resident, with their apartment", async () => {
    const session = userEvent.setup();
    render(
      <OpenIssuePanel
        types={TYPES}
        canNameResident
        onOpened={() => undefined}
      />,
    );

    await session.type(screen.getByLabelText("Åt en boende"), "Rune");
    await session.click(
      await screen.findByRole("button", { name: "Rune Boende" }),
    );
    await session.selectOptions(
      screen.getByLabelText("Vad gäller det"),
      "type-water",
    );
    await session.type(
      screen.getByLabelText("Vad har hänt"),
      "Ringde om dörren",
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg upp ärendet" }),
    );

    await waitFor(() => {
      expect(openIssue).toHaveBeenCalledWith({
        typeId: "type-water",
        reporterPersonId: "p-rune",
        apartmentId: "a-1401",
        description: "Ringde om dörren",
      });
    });
  });
});
