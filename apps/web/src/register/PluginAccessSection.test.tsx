import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { PluginAccessSection } from "./PluginAccessSection";
import { type PersonDetail, RegisterRequestError } from "./register-api";

/**
 * The plugin accesses on a person's page (ADR 0053).
 *
 * The rules are the server's and are tested there against a real database:
 * the grant is refused for a person with any residency, and a residency ends
 * every access. What this file pins is what the board reads: the accesses and
 * since when, a grant offered only where the server would take it, and every
 * refusal said in words.
 */

const { fetchGrantablePlugins, setPluginAccess } = vi.hoisted(() => ({
  fetchGrantablePlugins: vi.fn(),
  setPluginAccess: vi.fn(),
}));

// The real module, so RegisterRequestError is the class the section tests
// with `instanceof`.
vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchGrantablePlugins,
  setPluginAccess,
}));

const GARAGE_RENTER: PersonDetail = {
  personId: "person-tove",
  firstName: "Tove",
  lastName: "Lind",
  postalAddress: {
    state: "visible",
    street: "Bergsgatan 4",
    postalCode: "11123",
    city: "Stockholm",
  },
  contact: { state: "visible", email: "tove@exempel.se", phone: null },
  hasPersonalIdentityNumber: false,
  protectedPersonalData: false,
  preferredLocale: "sv",
  isMember: false,
  residencies: [],
  boardPositions: [],
  systemRoles: [],
  pluginAccesses: [],
  account: {
    state: "none",
    twoFactorEnabled: false,
    invitationExpiresAt: null,
  },
  publicationConsents: [],
  legalHold: null,
  dataSubjectRequests: [],
  communicationObjectionAt: null,
  processingRestrictedAt: null,
  erasureWaitingOn: null,
};

const WITH_ACCESS: PersonDetail = {
  ...GARAGE_RENTER,
  pluginAccesses: [
    {
      pluginId: "parking-share",
      pluginName: "Parkeringsdelning",
      grantedAt: "2026-10-01T08:00:00.000Z",
    },
  ],
};

const A_RESIDENT: PersonDetail = {
  ...GARAGE_RENTER,
  residencies: [
    {
      residencyId: "residency-1",
      apartmentId: "apartment-1",
      apartmentNumber: "1101",
      addressId: "address-1",
      addressLabel: "Storgatan 12",
      role: "RESIDENT",
      movedInOn: "2025-01-01",
      movedOutOn: null,
      purgeOn: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchGrantablePlugins.mockResolvedValue([
    { pluginId: "parking-share", pluginName: "Parkeringsdelning" },
  ]);
});

describe("what the board reads", () => {
  it("shows each access with the day it was granted", () => {
    render(
      <PluginAccessSection
        person={WITH_ACCESS}
        canWrite={false}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Tilläggsåtkomst" }),
    ).toBeTruthy();
    expect(screen.getByText("Parkeringsdelning")).toBeTruthy();
    expect(screen.getByText("Sedan 2026-10-01")).toBeTruthy();
    // A reader who may not write is offered nothing to press.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is absent for a reader who may not write when there is nothing to show", () => {
    const { container } = render(
      <PluginAccessSection
        person={GARAGE_RENTER}
        canWrite={false}
        onSaved={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
    expect(fetchGrantablePlugins).not.toHaveBeenCalled();
  });

  it("offers no grant for a person with a residency on record", () => {
    const { container } = render(
      <PluginAccessSection person={A_RESIDENT} canWrite onSaved={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
    expect(fetchGrantablePlugins).not.toHaveBeenCalled();
  });
});

describe("granting and withdrawing", () => {
  it("grants the chosen plugin and reads the person again", async () => {
    setPluginAccess.mockResolvedValue({
      personId: GARAGE_RENTER.personId,
      accesses: WITH_ACCESS.pluginAccesses,
    });
    const onSaved = vi.fn();
    render(
      <PluginAccessSection person={GARAGE_RENTER} canWrite onSaved={onSaved} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Ge åtkomst" }),
    );

    expect(setPluginAccess).toHaveBeenCalledWith(
      "person-tove",
      "parking-share",
      true,
    );
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("does not offer a plugin the person already has access to", async () => {
    render(
      <PluginAccessSection person={WITH_ACCESS} canWrite onSaved={vi.fn()} />,
    );

    // Not "no plugin serves": one does, and the person holds it.
    expect(
      await screen.findByText(
        "Personen har redan åtkomst till alla tillägg som tar emot personer som styrelsen ger åtkomst.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Inget installerat tillägg tar emot personer som styrelsen ger åtkomst.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Ge åtkomst" })).toBeNull();
  });

  it("says no plugin serves them when none is installed that does", async () => {
    fetchGrantablePlugins.mockResolvedValue([]);
    render(
      <PluginAccessSection person={GARAGE_RENTER} canWrite onSaved={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        "Inget installerat tillägg tar emot personer som styrelsen ger åtkomst.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/redan åtkomst till alla tillägg/)).toBeNull();
  });

  it("withdraws an access by its plugin", async () => {
    setPluginAccess.mockResolvedValue({
      personId: GARAGE_RENTER.personId,
      accesses: [],
    });
    const onSaved = vi.fn();
    render(
      <PluginAccessSection person={WITH_ACCESS} canWrite onSaved={onSaved} />,
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Ta bort åtkomst till Parkeringsdelning",
      }),
    );

    expect(setPluginAccess).toHaveBeenCalledWith(
      "person-tove",
      "parking-share",
      false,
    );
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("says why the server refused a person with a residency", async () => {
    setPluginAccess.mockRejectedValue(
      new RegisterRequestError(409, "person-has-residency"),
    );
    const onSaved = vi.fn();
    render(
      <PluginAccessSection person={GARAGE_RENTER} canWrite onSaved={onSaved} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Ge åtkomst" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Personen har ett boende registrerat. Tilläggsåtkomst är bara för en person som aldrig har bott här.",
    );
    // Read again all the same, so the page shows what the register holds.
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps the refusal on screen once the person read again has a residency", async () => {
    // A move-in landed before the grant: the person read again after the
    // refusal has a residency and no access, which on its own closes the
    // section. The sentence saying why nothing was granted has to stay.
    setPluginAccess.mockRejectedValue(
      new RegisterRequestError(409, "person-has-residency"),
    );
    const onSaved = vi.fn();
    const { rerender } = render(
      <PluginAccessSection person={GARAGE_RENTER} canWrite onSaved={onSaved} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Ge åtkomst" }),
    );
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    rerender(
      <PluginAccessSection person={A_RESIDENT} canWrite onSaved={onSaved} />,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "Personen har ett boende registrerat. Tilläggsåtkomst är bara för en person som aldrig har bott här.",
    );
    expect(screen.queryByRole("button", { name: "Ge åtkomst" })).toBeNull();

    // Never on another person's page.
    rerender(
      <PluginAccessSection
        person={{ ...A_RESIDENT, personId: "person-other" }}
        canWrite
        onSaved={onSaved}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the plugins that can be granted cannot be read", async () => {
    fetchGrantablePlugins.mockRejectedValue(new Error("offline"));
    render(
      <PluginAccessSection person={GARAGE_RENTER} canWrite onSaved={vi.fn()} />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Tilläggen som kan ges åtkomst till gick inte att läsa. Försök igen senare.",
    );
  });
});
