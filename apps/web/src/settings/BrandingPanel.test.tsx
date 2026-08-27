import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { BrandingPanel } from "./BrandingPanel";

/**
 * The branding panel.
 *
 * The board picks one colour and the platform derives five, differently per
 * mode, so a swatch of what they typed would show something the interface never
 * renders. The preview therefore uses the same derivation the API measures
 * against, and a refusal has to arrive with the measured ratio: "invalid colour"
 * tells a board nothing about a colour that looked fine on their letterhead.
 */

const saveBranding = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveBranding: (input: unknown) => saveBranding(input),
}));

function renderPanel(primaryColor: string | null = null) {
  return render(
    <ThemeModeProvider>
      <BrandingPanel value={{ primaryColor, logoPath: null }} />
    </ThemeModeProvider>,
  );
}

const colourField = () => screen.getByLabelText(/primärfärg/i);

beforeEach(() => {
  saveBranding.mockReset().mockResolvedValue({
    ok: true,
    value: { primaryColor: "#7d5f23", logoPath: null },
  });
});

describe("the preview", () => {
  it("appears only once the value is a colour", async () => {
    const session = userEvent.setup();
    renderPanel();

    expect(screen.queryByText("Ljust läge")).toBeNull();

    await session.type(colourField(), "#7D5F23");

    // Exact matches: the panel's own hint mentions both modes in a sentence.
    expect(screen.getByText("Ljust läge")).toBeTruthy();
    // Both modes, because one chosen colour becomes two derived families.
    expect(screen.getByText("Mörkt läge")).toBeTruthy();
  });

  it("says that the colour is adjusted per mode rather than used as typed", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "#7D5F23");

    expect(screen.getByText(/kontrasten/i)).toBeTruthy();
  });

  it("shows nothing for a value that is not a colour", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "mässing");

    expect(screen.queryByText("Ljust läge")).toBeNull();
  });
});

describe("saving", () => {
  it("sends the colour as typed and lets the server decide", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "#7D5F23");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(saveBranding).toHaveBeenCalledWith({ primaryColor: "#7D5F23" });
    });
  });

  it("clears the override by sending null", async () => {
    const session = userEvent.setup();
    renderPanel("#7d5f23");

    await session.click(
      screen.getByRole("button", { name: /temats egen färg/i }),
    );

    await waitFor(() => {
      expect(saveBranding).toHaveBeenCalledWith({ primaryColor: null });
    });
  });

  it("renders the measured pair when the server refuses", async () => {
    saveBranding.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "colour-fails-contrast",
        detail: [
          {
            foreground: "accent-trust",
            background: "surface-page",
            ratio: 1.11,
            required: 4.5,
            statutory: false,
          },
        ],
      },
    });

    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "#FFE066");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      // Twice over: once in the notice, once in the swatch that cannot be
      // drawn. Both are correct, so the count is asserted rather than one.
      expect(screen.getAllByText(/kan inte läsas/i).length).toBeGreaterThan(0);
    });
    // The number is the part a board can act on.
    expect(screen.getByText(/1\.11/)).toBeTruthy();
    expect(screen.getByText(/surface-page/)).toBeTruthy();
  });

  it("marks a failing register pair as the statutory one", async () => {
    saveBranding.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "colour-fails-contrast",
        detail: [
          {
            foreground: "accent-trust-register",
            background: "surface-register",
            ratio: 2.4,
            required: 4.5,
            statutory: true,
          },
        ],
      },
    });

    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "#101112");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(screen.getByText(/lagstadgade registret/i)).toBeTruthy();
    });
  });
});

describe("a board member who may only read", () => {
  it("gets the field disabled and no save button", () => {
    render(
      <ThemeModeProvider>
        <BrandingPanel
          value={{ primaryColor: "#7d5f23", logoPath: null }}
          editable={false}
        />
      </ThemeModeProvider>,
    );

    expect(colourField()).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });
});
