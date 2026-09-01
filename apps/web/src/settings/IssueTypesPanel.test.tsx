import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { IssueTypeView } from "../api/issues";
import { IssueTypesPanel } from "./IssueTypesPanel";

/**
 * The board's catalogue of issue types.
 *
 * The audience is the only thing on this screen that decides who is shown what:
 * a type set to non-member appears on a form anyone can reach, and one set to
 * board is the association's own note to itself. So it is on the row, in words,
 * where a board member changing a name cannot move a category between those two
 * without seeing it happen.
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

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueTypes: () => fetchIssueTypes(),
  createIssueType: (input: unknown) => createIssueType(input),
  updateIssueType: (input: unknown) => updateIssueType(input),
  removeIssueType: (id: string) => removeIssueType(id),
}));

function type(overrides: Partial<IssueTypeView> = {}): IssueTypeView {
  return {
    id: "type-water",
    name: "Vatten",
    audience: "MEMBER",
    active: true,
    sortOrder: 0,
    reportCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fetchIssueTypes.mockReset().mockResolvedValue({ ok: true, value: [type()] });
  createIssueType.mockReset().mockResolvedValue({ ok: true, value: type() });
  updateIssueType.mockReset().mockResolvedValue({ ok: true, value: type() });
  removeIssueType.mockReset().mockResolvedValue({ ok: true, value: undefined });
});

describe("the audience on a type", () => {
  it("is shown in words on every row", async () => {
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    const audience = screen.getAllByLabelText(/^erbjuds$/i)[0];
    expect(audience).toHaveProperty("value", "MEMBER");
  });

  it("is saved as its own act, so moving one is deliberate", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    const rows = screen.getAllByLabelText(/^erbjuds$/i);
    await session.selectOptions(rows[0]!, "NON_MEMBER");

    await waitFor(() => {
      expect(updateIssueType).toHaveBeenCalledWith({
        id: "type-water",
        values: {
          name: "Vatten",
          audience: "NON_MEMBER",
          active: true,
          sortOrder: 0,
        },
      });
    });
  });
});

describe("removing a type", () => {
  it("is offered only while nothing has been filed under it", async () => {
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /^ta bort$/i })).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: /^ta bort$/i })).toBeNull();
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
    await session.click(screen.getByRole("button", { name: /^ta bort$/i }));

    await waitFor(() => {
      expect(screen.getByText(/stäng av den i stället/i)).toBeTruthy();
    });
  });
});

describe("adding a type", () => {
  it("sends the name and the audience the board chose", async () => {
    const session = userEvent.setup();
    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Vatten")).toBeTruthy();
    });

    await session.type(screen.getByLabelText(/^namn$/i), "Tvättstugan");
    const audiences = screen.getAllByLabelText(/^erbjuds$/i);
    await session.selectOptions(audiences[audiences.length - 1]!, "BOARD");
    await session.click(screen.getByRole("button", { name: /lägg till typ/i }));

    await waitFor(() => {
      expect(createIssueType).toHaveBeenCalledWith({
        name: "Tvättstugan",
        audience: "BOARD",
        sortOrder: 1,
      });
    });
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
    await session.selectOptions(
      screen.getAllByLabelText(/^erbjuds$/i)[0]!,
      "NON_MEMBER",
    );

    await waitFor(() => {
      expect(screen.getByText(LOAD_FAILED)).toBeTruthy();
    });
    expect(screen.getByText("Vatten")).toBeTruthy();
    // And no loading line: the read is over, and one under the notice would go
    // on saying something is still happening.
    expect(screen.queryByText(LOADING)).toBeNull();
  });
});
