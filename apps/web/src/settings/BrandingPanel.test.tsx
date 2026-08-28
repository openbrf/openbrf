import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BrandingSettings } from "../api/instance";
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
      <BrandingPanel value={{ primaryColor, logo: null, logoDark: null }} />
    </ThemeModeProvider>,
  );
}

const colourField = () => screen.getByLabelText(/primärfärg/i);

/**
 * How many times the refusal sentence appears on screen when #FFE066 is refused.
 *
 * Once in the notice, and once in each preview swatch whose family the panel
 * cannot derive at all - the same sentence is the swatch's own "this mode cannot
 * be drawn" text. Asserted as a number so a change to either place has to be a
 * deliberate edit here rather than an assertion that quietly stops meaning
 * anything.
 */
const UNREADABLE_MENTIONS = 2;

beforeEach(() => {
  saveBranding.mockReset().mockResolvedValue({
    ok: true,
    value: { primaryColor: "#7d5f23", logo: null, logoDark: null },
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
      // The count, not merely "at least one": getAllByText throws when nothing
      // matches, so the previous assertion held whatever the screen rendered.
      expect(screen.getAllByText(/kan inte läsas/i)).toHaveLength(
        UNREADABLE_MENTIONS,
      );
    });
    // The number is the part a board can act on.
    expect(screen.getByText(/1\.11/)).toBeTruthy();
    expect(screen.getByText(/surface-page/)).toBeTruthy();
  });

  it("survives a refusal whose detail is not a contrast finding", async () => {
    /*
     * ApiFailure.detail is unknown and endpoint-specific: an invalid-body
     * refusal carries the Zod issue list in the same field. Read as contrast
     * findings, one of those issues reaches `required.toFixed(1)` and throws
     * during render, so a board loses the whole settings screen instead of
     * reading why their colour was refused.
     */
    saveBranding.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "primaryColor", message: "Too small: expected 1" }],
      },
    });

    const session = userEvent.setup();
    renderPanel();

    await session.type(colourField(), "#FFE066");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(screen.getByText(/kunde inte sparas/i)).toBeTruthy();
    });
    // The field is still there, which is the assertion: a thrown TypeError in
    // the notice would have taken the form down with it.
    expect(colourField()).toBeTruthy();
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
          value={{ primaryColor: "#7d5f23", logo: null, logoDark: null }}
          editable={false}
        />
      </ThemeModeProvider>,
    );

    expect(colourField()).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });
});

/**
 * The two logo slots.
 *
 * The panel has to say what happens when only one is filled in, because the
 * consequence lands on a screen the board is not looking at: the dark top band
 * that every other page of the application carries.
 */
describe("the logotype", () => {
  const STORED = {
    url: "/api/media/file-1",
    fileName: "logotyp.png",
    width: 240,
    height: 80,
  };

  function renderWith(value: Partial<BrandingSettings>) {
    return render(
      <ThemeModeProvider>
        <BrandingPanel
          value={{ primaryColor: null, logo: null, logoDark: null, ...value }}
        />
      </ThemeModeProvider>,
    );
  }

  it("offers a slot for the mark and one for dark backgrounds", () => {
    renderWith({});

    expect(screen.getAllByLabelText(/välj en fil för/i)).toHaveLength(2);
  });

  it("warns that the band will use a plate when no dark variant exists", () => {
    renderWith({ logo: STORED });

    expect(screen.getByText(/lägger märket på en ljus platta/i)).toBeTruthy();
  });

  it("stops warning once a dark variant is uploaded", () => {
    renderWith({ logo: STORED, logoDark: STORED });

    expect(screen.queryByText(/lägger märket på en ljus platta/i)).toBeNull();
  });

  it("says the mark is published to everyone", () => {
    // The logotype is fetched with no session, by mail clients and by the
    // public site, so an image of identifiable people cannot be one.
    renderWith({});

    expect(
      screen.getByText(/får inte visa identifierbara personer/i),
    ).toBeTruthy();
  });
});
