import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { asSupportSession } from "../support/support-fixtures";
import type { LicencesOverview, LicenceView } from "./licence-api";
import { LicencesScreen } from "./LicencesScreen";

/**
 * The licence screen (ADR 0042): the board enters, sees and removes licences
 * without the command-line tool.
 *
 * What a licence says is shown only while a key verifies it, so a file nobody
 * has checked cannot put words on the board's screen; and from thirty days
 * before a licence's last day the screen says when it ends.
 */

const fetchLicences = vi.fn();
const enterLicence = vi.fn();
const removeLicence = vi.fn();

vi.mock("./licence-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./licence-api")>()),
  fetchLicences: () => fetchLicences(),
  enterLicence: (licence: string) => enterLicence(licence),
  removeLicence: (id: string) => removeLicence(id),
}));

const INSTANCE_ID = "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f";
const INSTANCE_KEY = "k".repeat(43);

const VERIFIED: LicenceView = {
  id: "row-1",
  sha256: "a".repeat(64),
  keyId: "example-2026-1",
  enteredAt: "2026-11-02T09:00:00.000Z",
  check: "verified",
  licenceId: "9b0c7c5e-2f4e-4d8a-9a51-3a3f0a5f1c2d",
  verified: {
    issuedOn: "2026-11-02",
    instanceId: INSTANCE_ID,
    instanceKey: INSTANCE_KEY,
    association: { name: "Brf Talgoxen 4", organizationNumber: "769600-0000" },
    entitlements: [
      { name: "ai-package", validUntil: "2027-11-30", updatesUntil: null },
      { name: "mcp-connector", validUntil: null, updatesUntil: "2027-11-30" },
    ],
    issuer: { name: "Exempel AB", url: "https://licence.example.org" },
    pluginId: "mcp-connector",
  },
};

const UNCHECKED: LicenceView = {
  id: "row-2",
  sha256: "b".repeat(64),
  keyId: "other-2026-1",
  enteredAt: "2026-11-03T09:00:00.000Z",
  check: "not-yet-checked",
  licenceId: null,
  verified: null,
};

const OVERVIEW: LicencesOverview = {
  instance: {
    instanceId: INSTANCE_ID,
    instanceKey: INSTANCE_KEY,
    keyReadable: true,
  },
  licences: [VERIFIED, UNCHECKED],
  plugins: [
    {
      pluginId: "mcp-connector",
      entitlement: "mcp-connector",
      issuer: { name: "Exempel AB", url: "https://licence.example.org" },
      state: {
        status: "active",
        licenceId: VERIFIED.licenceId ?? "",
        validUntil: null,
        updatesUntil: "2027-11-30",
      },
    },
  ],
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Talgoxen 4",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

const ADMIN = viewerWith(["association:read", "association:manage"]);

/** The text of the entitlement line that names `name`. */
function lineOf(name: string): string | null {
  const line = screen
    .getAllByText(name)
    .map((label) => label.parentElement?.textContent ?? "")
    .find((text) => text.startsWith(`${name}: `));
  return line ?? null;
}

beforeEach(() => {
  fetchLicences.mockReset().mockResolvedValue({ ok: true, value: OVERVIEW });
  enterLicence.mockReset();
  removeLicence.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the licences", () => {
  it("shows the line the board copies into an order", async () => {
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText(`${INSTANCE_ID} ${INSTANCE_KEY}`),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kopiera" })).toBeTruthy();
  });

  it("shows what a verified licence says, with the issuer its plugin names", async () => {
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText("Utfärdad till Brf Talgoxen 4, 769600-0000"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "Utfärdad av Exempel AB - Utfärdad 2026-11-02",
      ),
    ).toBeTruthy();
    // The entitlements and their dates, each date in the data face.
    expect(lineOf("ai-package")).toBe(
      "ai-package: får användas till och med 2027-11-30, täcker varje version",
    );
    expect(lineOf("mcp-connector")).toBe(
      "mcp-connector: inget slutdatum, täcker versioner som släppts till och med 2027-11-30",
    );
    expect(
      screen
        .getAllByText("2027-11-30")
        .every((date) => date.classList.contains("font-data")),
    ).toBe(true);
  });

  it("says a licence is not yet checked, and nothing it says", async () => {
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText(/^Inte kontrollerad än: inget installerat/),
    ).toBeTruthy();
    expect(screen.getByText(`Fil ${"b".repeat(64)}`)).toBeTruthy();
  });

  it.each([
    ["tampered", /^Ändrad sedan den lades in/],
    ["issuer-not-installed", /^Tillägget vars nyckel kontrollerade den/],
  ] as const)(
    "says what a %s licence is, and nothing it says",
    async (check, sentence) => {
      fetchLicences.mockResolvedValue({
        ok: true,
        value: {
          ...OVERVIEW,
          licences: [{ ...VERIFIED, check, verified: null }],
        },
      });
      render(<LicencesScreen viewer={ADMIN} />);

      expect(await screen.findByText(sentence)).toBeTruthy();
      expect(screen.queryByText(/Brf Talgoxen 4/)).toBeNull();
    },
  );

  it("says a verified licence was issued to another instance", async () => {
    fetchLicences.mockResolvedValue({
      ok: true,
      value: {
        ...OVERVIEW,
        licences: [
          {
            ...VERIFIED,
            verified: {
              ...(VERIFIED.verified as NonNullable<LicenceView["verified"]>),
              instanceKey: "z".repeat(43),
            },
          },
        ],
      },
    });
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText(/^Utfärdad till en annan instans/),
    ).toBeTruthy();
  });

  it("says what each licensed plugin finds", async () => {
    fetchLicences.mockResolvedValue({
      ok: true,
      value: {
        ...OVERVIEW,
        plugins: [{ ...OVERVIEW.plugins[0], state: { status: "absent" } }],
      },
    });
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText("Läser mcp-connector från Exempel AB"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ingen licens för det är inlagd, så tillägget är vilande.",
      ),
    ).toBeTruthy();
  });

  it("says when the instance key cannot be read", async () => {
    fetchLicences.mockResolvedValue({
      ok: true,
      value: {
        ...OVERVIEW,
        instance: { ...OVERVIEW.instance, keyReadable: false },
      },
    });
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText(/^Instansnyckeln kan inte läsas/),
    ).toBeTruthy();
  });

  it("tells an account without the capability, and reads nothing", () => {
    render(<LicencesScreen viewer={viewerWith(["association:read"])} />);

    expect(
      screen.getByText("Bara en administratör kan se och ändra licenserna."),
    ).toBeTruthy();
    expect(fetchLicences).not.toHaveBeenCalled();
  });
});

describe("when a licence ends", () => {
  /**
   * The association's calendar day decides, and 22:30 UTC on 31 October is
   * already 1 November in Stockholm: thirty days before 2026-12-01.
   */
  function at(instant: string, validUntil: string): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    fetchLicences.mockResolvedValue({
      ok: true,
      value: {
        ...OVERVIEW,
        licences: [
          {
            ...VERIFIED,
            verified: {
              ...(VERIFIED.verified as NonNullable<LicenceView["verified"]>),
              entitlements: [
                { name: "ai-package", validUntil, updatesUntil: null },
              ],
            },
          },
        ],
      },
    });
  }

  it("says when it ends from thirty days before its last day", async () => {
    at("2026-10-31T23:30:00.000Z", "2026-12-01");
    render(<LicencesScreen viewer={ADMIN} />);

    expect(
      await screen.findByText("Upphör 2026-12-01, om 30 dagar."),
    ).toBeTruthy();
  });

  it("says nothing more than its date before that", async () => {
    at("2026-10-31T22:30:00.000Z", "2026-12-01");
    render(<LicencesScreen viewer={ADMIN} />);

    expect(await screen.findByText("2026-12-01")).toBeTruthy();
    expect(screen.queryByText(/^Upphör/)).toBeNull();
  });

  it("says it ends today on its last day, and that it has ended after", async () => {
    at("2026-12-01T12:00:00.000Z", "2026-12-01");
    const { unmount } = render(<LicencesScreen viewer={ADMIN} />);
    expect(await screen.findByText("Upphör i dag, 2026-12-01.")).toBeTruthy();
    unmount();

    at("2026-12-02T12:00:00.000Z", "2026-12-01");
    render(<LicencesScreen viewer={ADMIN} />);
    expect(await screen.findByText("Upphörde 2026-12-01.")).toBeTruthy();
  });
});

describe("entering a licence", () => {
  it("sends the pasted text, says it was verified, and reads the list again", async () => {
    const session = userEvent.setup();
    enterLicence.mockResolvedValue({ ok: true, value: VERIFIED });
    render(<LicencesScreen viewer={ADMIN} />);

    await session.type(
      await screen.findByRole("textbox", { name: "Eller klistra in licensen" }),
      "licence-text",
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in licensen" }),
    );

    expect(enterLicence).toHaveBeenCalledWith("licence-text");
    expect(
      await screen.findByText("Licensen lades in och kontrollerades."),
    ).toBeTruthy();
    expect(fetchLicences).toHaveBeenCalledTimes(2);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Eller klistra in licensen",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("sends a chosen file's text, and says when no key could check it yet", async () => {
    const session = userEvent.setup();
    enterLicence.mockResolvedValue({ ok: true, value: UNCHECKED });
    render(<LicencesScreen viewer={ADMIN} />);

    await session.upload(
      await screen.findByLabelText("Välj en fil"),
      new File(['{"format":"openbrf-licence/1"}'], "licens.json", {
        type: "application/json",
      }),
    );
    expect(screen.getByText("Vald: licens.json")).toBeTruthy();
    await session.click(
      screen.getByRole("button", { name: "Lägg in licensen" }),
    );

    expect(enterLicence).toHaveBeenCalledWith('{"format":"openbrf-licence/1"}');
    expect(
      await screen.findByText(/^Licensen lades in. Inget installerat tillägg/),
    ).toBeTruthy();
  });

  it("says why a licence was refused, until the draft changes", async () => {
    const session = userEvent.setup();
    enterLicence.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "licence-signature-invalid" },
    });
    render(<LicencesScreen viewer={ADMIN} />);

    const field = await screen.findByRole("textbox", {
      name: "Eller klistra in licensen",
    });
    await session.type(field, "forged");
    await session.click(
      screen.getByRole("button", { name: "Lägg in licensen" }),
    );

    expect(
      await screen.findByText(
        /^Inget installerat tilläggs nyckel kan kontrollera/,
      ),
    ).toBeTruthy();
    await session.type(field, "!");
    expect(
      screen.queryByText(/^Inget installerat tilläggs nyckel kan kontrollera/),
    ).toBeNull();
  });

  it("holds the button shut with nothing to enter", async () => {
    render(<LicencesScreen viewer={ADMIN} />);

    const button = await screen.findByRole("button", {
      name: "Lägg in licensen",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("removing a licence", () => {
  it("asks once more, removes it and reads the list again", async () => {
    const session = userEvent.setup();
    removeLicence.mockResolvedValue({ ok: true, value: undefined });
    render(<LicencesScreen viewer={ADMIN} />);

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort licensen Brf Talgoxen 4",
      }),
    );
    expect(
      screen.getByText(/^Ett tillägg som läser licensen blir vilande/),
    ).toBeTruthy();
    expect(removeLicence).not.toHaveBeenCalled();
    await session.click(
      screen.getByRole("button", { name: "Ja, ta bort den" }),
    );

    expect(removeLicence).toHaveBeenCalledWith("row-1");
    await waitFor(() => {
      expect(fetchLicences).toHaveBeenCalledTimes(2);
    });
  });

  it("says a licence another removal took first is gone, and reads again", async () => {
    const session = userEvent.setup();
    removeLicence.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "licence-not-found" },
    });
    render(<LicencesScreen viewer={ADMIN} />);

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort licensen Brf Talgoxen 4",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ja, ta bort den" }),
    );

    expect(
      await screen.findByText("Licensen var redan borttagen."),
    ).toBeTruthy();
    expect(fetchLicences).toHaveBeenCalledTimes(2);
  });
});

describe("a support session", () => {
  it("reads the licences and is offered no control", async () => {
    render(<LicencesScreen viewer={asSupportSession(ADMIN)} />);

    expect(
      await screen.findByText("Utfärdad till Brf Talgoxen 4, 769600-0000"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ta bort/ })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Lägg in en licens" }),
    ).toBeNull();
  });
});
