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

const EMPTY: ResponsibilityGuide = {
  adoptedAt: null,
  items: [],
  version: null,
};

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
            version: "2026-11-03T09:00:00.000Z",
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
      version: string | null;
    };
    expect(sent.adopted).toBe(false);
    expect(sent.version).toBeNull();
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
        version: "2026-11-01T09:00:00.000Z",
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
        version: "2026-11-01T09:00:00.000Z",
      });
    });
    expect(await screen.findByText("2026-11-03")).toBeTruthy();
    expect(
      screen.queryByText("Exempel, inte avstämt mot föreningens stadgar."),
    ).toBeNull();
  });

  it("names the line and the field of a refused personal identity number, and clears it when the draft changes", async () => {
    fetchResponsibilityGuide.mockResolvedValue({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
          { part: "Stammar", responsibility: "ASSOCIATION", note: "x" },
        ],
        version: null,
      },
    });
    saveResponsibilityGuide.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [{ item: 1, field: "note", offset: 6 }],
      },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.click(
      await screen.findByRole("button", { name: "Spara ansvarsfördelningen" }),
    );
    expect(await screen.findByText(/innehåller ett personnummer/)).toBeTruthy();
    expect(
      screen.getByText("Rad 2: anmärkning", { selector: "li" }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Rad 2: anmärkning").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.getByLabelText("Rad 1: anmärkning").getAttribute("aria-invalid"),
    ).toBeNull();

    await session.type(screen.getByLabelText("Rad 1: anmärkning"), "x");
    expect(screen.queryByText(/innehåller ett personnummer/)).toBeNull();
  });

  it("keeps the draft when the guide was saved by somebody else, and reads the current one on request", async () => {
    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
        version: "2026-11-01T09:00:00.000Z",
      },
    });
    saveResponsibilityGuide.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "changed-since-read" },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.type(await screen.findByLabelText("Rad 1: anmärkning"), "ny");
    await session.click(
      screen.getByRole("button", { name: "Spara ansvarsfördelningen" }),
    );
    expect(await screen.findByText(/sparades av någon annan/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Rad 1: anmärkning") as HTMLInputElement).value,
    ).toBe("ny");

    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [{ part: "Stammar", responsibility: "ASSOCIATION", note: null }],
        version: "2026-11-02T09:00:00.000Z",
      },
    });
    await session.click(
      screen.getByRole("button", { name: "Läs den aktuella tabellen" }),
    );
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Rad 1: vad") as HTMLInputElement).value,
      ).toBe("Stammar");
    });
    expect(screen.queryByText(/sparades av någon annan/)).toBeNull();
  });

  it("refuses input while the current table is being read, so nothing typed is deleted", async () => {
    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
        version: "2026-11-01T09:00:00.000Z",
      },
    });
    saveResponsibilityGuide.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "changed-since-read" },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.type(await screen.findByLabelText("Rad 1: anmärkning"), "ny");
    await session.click(
      screen.getByRole("button", { name: "Spara ansvarsfördelningen" }),
    );
    expect(await screen.findByText(/sparades av någon annan/)).toBeTruthy();

    let answer: (read: unknown) => void = () => undefined;
    fetchResponsibilityGuide.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Läs den aktuella tabellen" }),
    );

    const note = screen.getByLabelText("Rad 1: anmärkning") as HTMLInputElement;
    // The form is one disabled fieldset, so the property stays false.
    expect(note.matches(":disabled")).toBe(true);
    await session.type(note, "mer");
    expect(note.value).toBe("ny");

    answer({
      ok: true,
      value: {
        adoptedAt: null,
        items: [{ part: "Stammar", responsibility: "ASSOCIATION", note: null }],
        version: "2026-11-02T09:00:00.000Z",
      },
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Rad 1: vad") as HTMLInputElement).value,
      ).toBe("Stammar");
    });
    expect(screen.getByLabelText("Rad 1: vad").matches(":disabled")).toBe(
      false,
    );
  });

  it("keeps the draft when the read of the current table fails, and reads again on request", async () => {
    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [
          { part: "Golvbrunn", responsibility: "TENANT_OWNER", note: null },
        ],
        version: "2026-11-01T09:00:00.000Z",
      },
    });
    saveResponsibilityGuide.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "changed-since-read" },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    await session.type(await screen.findByLabelText("Rad 1: anmärkning"), "ny");
    await session.click(
      screen.getByRole("button", { name: "Spara ansvarsfördelningen" }),
    );
    await screen.findByText(/sparades av någon annan/);

    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500 },
    });
    await session.click(
      screen.getByRole("button", { name: "Läs den aktuella tabellen" }),
    );
    expect(
      await screen.findByText(/Den aktuella tabellen gick inte att läsa/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Rad 1: anmärkning") as HTMLInputElement).value,
    ).toBe("ny");

    // Editing clears the refused save, but the failed read stays unanswered
    // until the table is read again, so the control to do so stays too.
    await session.type(screen.getByLabelText("Rad 1: anmärkning"), "t");
    expect(
      screen.getByText(/Den aktuella tabellen gick inte att läsa/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Läs den aktuella tabellen" }),
    ).toBeTruthy();

    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [{ part: "Stammar", responsibility: "ASSOCIATION", note: null }],
        version: "2026-11-02T09:00:00.000Z",
      },
    });
    await session.click(
      screen.getByRole("button", { name: "Läs den aktuella tabellen" }),
    );
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Rad 1: vad") as HTMLInputElement).value,
      ).toBe("Stammar");
    });
    expect(
      screen.queryByText(/Den aktuella tabellen gick inte att läsa/),
    ).toBeNull();
  });

  it("offers to read the guide again when the first read fails", async () => {
    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500 },
    });
    fetchResponsibilityGuide.mockResolvedValueOnce({
      ok: true,
      value: {
        adoptedAt: null,
        items: [{ part: "Stammar", responsibility: "ASSOCIATION", note: null }],
        version: "2026-11-02T09:00:00.000Z",
      },
    });
    const session = userEvent.setup();
    render(<ResponsibilityGuidePanel />);

    expect(await screen.findByText(/gick inte att läsa just nu/)).toBeTruthy();
    await session.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(
      await screen.findByRole("button", { name: "Spara ansvarsfördelningen" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Rad 1: vad") as HTMLInputElement).value,
    ).toBe("Stammar");
  });
});
