import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BrandingSettings } from "../api/instance";
import { LogoField } from "./LogoField";

/**
 * The logo field.
 *
 * What matters here is that a refusal reaches the board in words they can act
 * on. The API identifies a file from its own bytes and refuses anything that is
 * not an image, so "that did not work" would leave someone renaming a PDF to
 * .png and trying again.
 */

const uploadLogo = vi.fn();
const removeLogo = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  uploadLogo: (slot: unknown, file: unknown) => uploadLogo(slot, file),
  removeLogo: (slot: unknown) => removeLogo(slot),
}));

const BRANDING: BrandingSettings = {
  primaryColor: null,
  logo: null,
  logoDark: null,
};

const STORED = {
  url: "/api/media/file-1",
  fileName: "logotyp.png",
  width: 240,
  height: 80,
};

function renderField(
  value: BrandingSettings["logo"] = null,
  onChanged = vi.fn(),
) {
  return render(
    <LogoField
      slot="light"
      label="Logotyp"
      hint="Används i rummet."
      value={value}
      onChanged={onChanged}
    />,
  );
}

function pngFile(name = "logotyp.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });
}

const picker = () => screen.getByLabelText(/välj en fil för/i);

beforeEach(() => {
  uploadLogo.mockReset().mockResolvedValue({
    ok: true,
    value: { ...BRANDING, logo: STORED },
  });
  removeLogo.mockReset().mockResolvedValue({ ok: true, value: BRANDING });
});

describe("with no logotype yet", () => {
  it("says so and offers only the picker", () => {
    renderField();

    expect(screen.getByText(/ingen logotyp uppladdad/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /ta bort logotypen/i }),
    ).toBeNull();
  });

  it("sends the chosen file and hands the answer back", async () => {
    const session = userEvent.setup();
    const onChanged = vi.fn();
    renderField(null, onChanged);

    await session.upload(picker(), pngFile());

    await waitFor(() => {
      expect(uploadLogo).toHaveBeenCalledWith("light", expect.any(File));
    });
    expect(onChanged).toHaveBeenCalledWith({ ...BRANDING, logo: STORED });
  });
});

describe("with a logotype stored", () => {
  it("shows its name, its size and the image itself", () => {
    renderField(STORED);

    expect(screen.getByText("logotyp.png")).toBeTruthy();
    expect(screen.getByText(/240 gånger 80 bildpunkter/i)).toBeTruthy();
    // The path is on this instance's own origin. A logo served from anywhere
    // else would disclose every visitor's IP address to that host.
    expect(screen.getByRole("presentation")).toHaveProperty(
      "src",
      expect.stringContaining("/api/media/file-1") as unknown as string,
    );
  });

  it("removes it on request", async () => {
    const session = userEvent.setup();
    const onChanged = vi.fn();
    renderField(STORED, onChanged);

    await session.click(
      screen.getByRole("button", { name: /ta bort logotypen/i }),
    );

    await waitFor(() => {
      expect(removeLogo).toHaveBeenCalledWith("light");
    });
    expect(onChanged).toHaveBeenCalledWith(BRANDING);
  });
});

describe("when the API refuses the file", () => {
  it("says the file is not an image, not that something went wrong", async () => {
    const session = userEvent.setup();
    uploadLogo.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "unsupported-type" },
    });
    renderField();

    await session.upload(picker(), pngFile("inte-en-bild.png"));

    expect(
      await screen.findByText(/inte en png-, jpeg-, webp- eller gif-bild/i),
    ).toBeTruthy();
  });

  it("says the file is too large when it is", async () => {
    const session = userEvent.setup();
    uploadLogo.mockResolvedValue({
      ok: false,
      failure: { status: 413, reason: "too-large" },
    });
    renderField();

    await session.upload(picker(), pngFile());

    expect(await screen.findByText(/större än vad/i)).toBeTruthy();
  });
});

describe("a board member who may only read", () => {
  it("gets no picker and no remove button", () => {
    render(
      <LogoField
        slot="light"
        label="Logotyp"
        hint="Används i rummet."
        value={STORED}
        editable={false}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText(/välj en fil för/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /ta bort logotypen/i }),
    ).toBeNull();
    // The mark itself still shows: reading the settings is what the board may
    // do, and hiding the value would make the screen useless to them.
    expect(screen.getByText("logotyp.png")).toBeTruthy();
  });
});

describe("the dark slot with no variant of its own", () => {
  it("previews the light mark, which is what the band falls back to", () => {
    render(
      <LogoField
        slot="dark"
        label="Logotyp för mörk bakgrund"
        hint="Valfri."
        value={null}
        fallback={STORED}
        onChanged={vi.fn()}
      />,
    );

    // Shown rather than described: a board with one dark-ink logo has to be
    // able to see that the band puts it on a plate.
    expect(screen.getByRole("presentation")).toHaveProperty(
      "src",
      expect.stringContaining("/api/media/file-1") as unknown as string,
    );
    expect(screen.getByText(/ingen logotyp uppladdad/i)).toBeTruthy();
  });
});
