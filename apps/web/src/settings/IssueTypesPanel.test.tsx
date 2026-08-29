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

  it("says so when the catalogue cannot be read", async () => {
    fetchIssueTypes.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<IssueTypesPanel />);

    await waitFor(() => {
      expect(screen.getByText(/kunde inte läsas/i)).toBeTruthy();
    });
  });
});
