import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ResponsibilityGuide } from "../api/issues";
import { ResponsibilityGuidePanel } from "./ResponsibilityGuidePanel";

/**
 * The board's responsibility guide (decision 27 of the issue module plan).
 *
 * What matters is that the example the product ships is never an answer about
 * the association: it is loaded into the form by the board, labelled as an
 * example until the board ticks that the table follows its bylaws, and saved
 * not adopted unless the board ticks it.
 */

const fetchResponsibilityGuide = vi.fn();
const saveResponsibilityGuide = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchResponsibilityGuide: () => fetchResponsibilityGuide(),
  saveResponsibilityGuide: (input: unknown) => saveResponsibilityGuide(input),
}));

const EMPTY: ResponsibilityGuide = { adoptedAt: null, items: [] };

beforeEach(() => {
  fetchResponsibilityGuide.mockReset().mockResolvedValue({
    ok: true,
    value: EMPTY,
  });
  saveResponsibilityGuide
    .mockReset()
    .mockImplementation(
      (input: { items: ResponsibilityGuide["items"]; adopted: boolean }) =>
        Promise.resolve({
          ok: true,
          value: {
            adoptedAt: input.adopted ? "2026-11-03T09:00:00.000Z" : null,
            items: input.items,
          },
        }),
    );
});

describe("the responsibility guide", () => {
  it("offers the example to start from, labelled as one", async () => {
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.click(
      await screen.findByRole("button", { name: "Fyll i exemplet" }),
    );

    expect(
      (screen.getByLabelText("Rad 3: vad") as HTMLInputElement).value,
    ).toBe("Golvbrunn, rensning");
    expect(
      screen.getByText("Exempel, inte avstämt mot föreningens stadgar."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Tabellen följer föreningens stadgar",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("saves the example as not adopted unless the board says it follows the bylaws", async () => {
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.click(
      await screen.findByRole("button", { name: "Fyll i exemplet" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Spara ansvarsfördelningen" }),
    );

    await waitFor(() => {
      expect(saveResponsibilityGuide).toHaveBeenCalledTimes(1);
    });
    const sent = saveResponsibilityGuide.mock.calls[0]?.[0] as {
      items: { part: string; responsibility: string; note: string | null }[];
      adopted: boolean;
    };
    expect(sent.adopted).toBe(false);
    expect(sent.items).toHaveLength(12);
    expect(sent.items[2]).toEqual({
      part: "Golvbrunn, rensning",
      responsibility: "TENANT_OWNER",
      note: null,
    });
    expect(
      await screen.findByText("Ansvarsfördelningen är sparad."),
    ).toBeTruthy();
  });

  it("adopts the guide when the board ticks that it follows the bylaws", async () => {
    fetchResponsibilityGuide.mockResolvedValue({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
      },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.click(
      await screen.findByRole("checkbox", {
        name: "Tabellen följer föreningens stadgar",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Spara ansvarsfördelningen" }),
    );

    await waitFor(() => {
      expect(saveResponsibilityGuide).toHaveBeenCalledWith({
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
        adopted: true,
      });
    });
    expect(await screen.findByText("2026-11-03")).toBeTruthy();
    expect(
      screen.queryByText("Exempel, inte avstämt mot föreningens stadgar."),
    ).toBeNull();
  });

  it("says where a refusal is, and clears it when the draft changes", async () => {
    fetchResponsibilityGuide.mockResolvedValue({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
      },
    });
    saveResponsibilityGuide.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.click(
      await screen.findByRole("button", { name: "Spara ansvarsfördelningen" }),
    );
    expect(await screen.findByText(/innehåller ett personnummer/)).toBeTruthy();

    await session.type(screen.getByLabelText("Rad 1: anmärkning"), "x");
    expect(screen.queryByText(/innehåller ett personnummer/)).toBeNull();
  });
});
