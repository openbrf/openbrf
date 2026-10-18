import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import {
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import i18n from "../i18n";
import type { InstanceSettings, Viewer } from "../api/instance";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { SettingsScreen } from "./SettingsScreen";

/**
 * What each viewer is offered.
 *
 * Hiding a panel is courtesy: the API enforces the same capabilities and
 * refuses the call whatever the interface shows. The reason to test it anyway
 * is that offering a control nobody may use trains a board to ignore refusals,
 * and offering a resident a panel of the instance's SMTP credentials would be a
 * disclosure even before anything was saved.
 */

const fetchSettings = vi.fn();
const fetchAddresses = vi.fn();
const saveSmtp = vi.fn();
const saveSelfSignup = vi.fn();
const saveRetention = vi.fn();
const saveFinances = vi.fn();
const saveDataProtectionContacts = vi.fn();
const saveOwnProfile = vi.fn();
const saveIssueReporting = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSettings: () => fetchSettings(),
  fetchAddresses: () => fetchAddresses(),
  saveSmtp: (input: unknown) => saveSmtp(input),
  saveSelfSignup: (input: unknown) => saveSelfSignup(input),
  saveRetention: (input: unknown) => saveRetention(input),
  saveFinances: (input: unknown) => saveFinances(input),
  saveDataProtectionContacts: (input: unknown) =>
    saveDataProtectionContacts(input),
  saveOwnProfile: (input: unknown) => saveOwnProfile(input),
}));

// The queue self-loads. This file is about which panels a viewer is offered,
// so it answers with an empty queue rather than reaching for the network.
vi.mock("../api/signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/signup")>()),
  fetchSignupRequests: () => Promise.resolve({ ok: true, value: [] }),
}));

// The issue types panel self-loads too. Same reason as the queue above: this
// file is about which panels a viewer is offered.
vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueTypes: () => Promise.resolve({ ok: true, value: [] }),
  saveIssueReporting: (input: unknown) => saveIssueReporting(input),
}));

// The connected apps section inside the security panel self-loads as well.
// Same reason again: this file is about which panels a viewer is offered, and
// that section is offered to every account.
vi.mock("../connected-apps/connections-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../connected-apps/connections-api")
  >()),
  fetchMyConnectedApps: () =>
    Promise.resolve({ ok: true, value: { connectedApps: [] } }),
}));

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: { user: { twoFactorEnabled: false } } }),
  authClient: {
    passkey: {
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}));

/*
 * Where the screen sent the reader instead of rendering a section. A redirect
 * is the router's business; what this file checks is which section the screen
 * asked it for, and that it asked to replace the address rather than add one.
 */
const redirected = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    to: string;
    params?: { section: string };
    children: ReactNode;
    className?: string;
    "aria-current"?: "page";
  }): ReactElement => (
    <a
      href={params === undefined ? to : to.replace("$section", params.section)}
      className={className}
      aria-current={ariaCurrent}
    >
      {children}
    </a>
  ),
  Navigate: (props: {
    to: string;
    params: { section: string };
    replace?: boolean;
  }): null => {
    redirected(props);
    return null;
  },
}));

// Typed, so a field added, renamed or retyped in the API client breaks this
// fixture instead of leaving the tests passing against a shape the API no
// longer returns.
const SETTINGS: InstanceSettings = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-1234",
    defaultLocale: "sv",
    setupCompletedAt: "2026-08-27T10:00:00.000Z",
  },
  branding: { primaryColor: null, logo: null, logoDark: null },
  smtp: {
    source: "settings",
    host: "smtp.example.se",
    port: 587,
    secure: true,
    user: null,
    fromAddress: "styrelsen@exempel.se",
    passwordSet: true,
    configured: true,
  },
  boardMailbox: {
    address: null,
    host: null,
    port: null,
    secure: true,
    user: null,
    passwordSet: false,
    configured: false,
  },
  sms: {
    driver: null,
    gatewayUrl: null,
    senderName: null,
    tokenSet: false,
    configured: false,
  },
  retention: { daysAfterMoveOut: 365 },
  finances: {
    financialYearStartMonth: 1,
    bankgiro: null,
    plusgiro: null,
  },
  selfSignup: { enabled: false },
  issueReporting: { publicFormEnabled: true },
  dataProtectionContacts: {
    controller: { contactEmail: null, postalAddress: null },
    officer: { name: null, email: null, phone: null },
    jointController: { name: null, contact: null },
  },
  // The clause a cooperative's own bylaws set. Null here, which is the ordinary
  // state of an instance whose bylaws say nothing about motions.
  motionDeadline: null,
  // The four clauses about the general meeting, at the statutory position. Never
  // null, unlike the deadline above: each of them has a rule that applies unless
  // the bylaws displace it, so this is what an instance that has recorded
  // nothing is under rather than an unconfigured state.
  meetingBylaws: {
    proxyHolderEligibilityWidened: false,
    maxMembersPerProxyHolder: 1,
    storageOnlyVoteLimited: false,
    assistantEligibilityWidened: false,
  },
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

function screenFor(capabilities: string[], section: string | undefined) {
  return (
    <ThemeModeProvider>
      <SettingsScreen viewer={viewerWith(capabilities)} section={section} />
    </ThemeModeProvider>
  );
}

function renderScreen(capabilities: string[], section: string | undefined) {
  return render(screenFor(capabilities, section));
}

const RESIDENT = ["self:manage", "residentDirectory:read"];
const ADMIN = [
  "association:read",
  "association:manage",
  "addressBook:read",
  "addressBook:write",
  "self:manage",
];

const smtpHeading = () => screen.queryByRole("heading", { name: /^e-post$/i });
const signupQueueHeading = () =>
  screen.queryByRole("heading", { name: /väntande ansökningar/i });
const profileHeading = () =>
  screen.queryByRole("heading", { name: /din profil/i });
const issueTypesHeading = () =>
  screen.queryByRole("heading", { name: /^ärendetyper$/i });

beforeEach(() => {
  fetchSettings.mockReset().mockResolvedValue({ ok: true, value: SETTINGS });
  fetchAddresses.mockReset().mockResolvedValue({ ok: true, value: [] });
  saveSmtp.mockReset();
  redirected.mockReset();
});

const BOARD_MEMBER = [
  "association:read",
  "addressBook:read",
  "addressBook:write",
  "self:manage",
];

describe("a resident", () => {
  it("gets their own profile and security, and nothing about the instance", async () => {
    renderScreen(RESIDENT, "account");

    await waitFor(() => {
      expect(profileHeading()).toBeTruthy();
    });
    expect(smtpHeading()).toBeNull();
    expect(screen.queryByRole("heading", { name: /gallring/i })).toBeNull();
    // The instance settings are never even asked for.
    expect(fetchSettings).not.toHaveBeenCalled();
  });

  it("is offered their own account and no other section", () => {
    renderScreen(RESIDENT, "account");

    const nav = screen.getByRole("navigation", {
      name: /delar av inställningarna/i,
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Mitt konto"]);
  });

  it("is sent to their own account from a section about the instance", () => {
    renderScreen(RESIDENT, "communication");

    expect(redirected).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/$section",
        params: { section: "account" },
        replace: true,
      }),
    );
    expect(smtpHeading()).toBeNull();
  });
});

describe("a board member", () => {
  it("reads the instance settings without being able to change them", async () => {
    renderScreen(BOARD_MEMBER, "communication");

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(screen.getByLabelText(/^server$/i)).toHaveProperty("disabled", true);
  });

  it("reads the retention policy without being able to change it", async () => {
    renderScreen(BOARD_MEMBER, "data-protection");

    // Read, not write: the board answers for the retention policy, an admin
    // changes it.
    expect(
      await screen.findByLabelText(/dagar efter utflyttning/i),
    ).toHaveProperty("disabled", true);
  });

  it("configures the issue types, which are the board's own vocabulary", async () => {
    renderScreen(
      [
        "association:read",
        "addressBook:read",
        "issues:configure",
        "self:manage",
      ],
      "issues-bookings",
    );

    await waitFor(() => {
      expect(issueTypesHeading()).toBeTruthy();
    });
  });

  it("gets the sign-up queue it is the one allowed to decide", async () => {
    renderScreen(
      [
        "association:read",
        "addressBook:read",
        "addressBook:write",
        "signupRequest:decide",
        "self:manage",
      ],
      "account-requests",
    );

    await waitFor(() => {
      expect(signupQueueHeading()).toBeTruthy();
    });
  });
});

describe("an admin", () => {
  it("can change the instance settings", async () => {
    renderScreen(
      [
        "association:read",
        "association:manage",
        "addressBook:read",
        "addressBook:write",
        "self:manage",
      ],
      "communication",
    );

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(screen.getByLabelText(/^server$/i)).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("is offered no type catalogue without the capability to configure it", async () => {
    // An administrator may switch the public form on and off; which categories
    // the cooperative sorts its problems into is the board's decision.
    renderScreen(
      ["association:read", "association:manage", "self:manage"],
      "issues-bookings",
    );

    await screen.findByRole("heading", {
      name: /^felanmälan från webbplatsen$/i,
    });
    expect(issueTypesHeading()).toBeNull();
  });

  it("is offered no queue without the capability to decide a request", async () => {
    /*
     * Approving one creates a person, a residency and an invitation, and the
     * API refuses the call for anyone without the capability. Offering the
     * panel anyway would put the applicant's name and email address on the
     * screen of somebody who may not act on either.
     */
    renderScreen(
      ["association:read", "association:manage", "self:manage"],
      "account-requests",
    );

    await screen.findByRole("heading", { name: /^ansökningar om konto$/i });
    expect(signupQueueHeading()).toBeNull();
  });

  it("is pointed back to the wizard while setup is unfinished", async () => {
    fetchSettings.mockResolvedValue({
      ok: true,
      value: {
        ...SETTINGS,
        housingCooperative: {
          ...SETTINGS.housingCooperative,
          setupCompletedAt: null,
        },
      },
    });

    renderScreen(
      ["association:read", "association:manage", "self:manage"],
      // Any section: the notice is the frame's, not one section's.
      "account",
    );

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: /återuppta konfigurationen/i }),
      ).toBeTruthy();
    });
  });

  it("is not pointed back once setup is finished", async () => {
    renderScreen(
      ["association:read", "association:manage", "self:manage"],
      "communication",
    );

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(
      screen.queryByRole("link", { name: /återuppta konfigurationen/i }),
    ).toBeNull();
  });
});

describe("before the reads settle", () => {
  it("offers no editable instance panels", async () => {
    /*
     * The initial value is an empty instance, and the panels built from it are
     * editable. A manager typing a name into an apparently unnamed cooperative
     * would overwrite the stored one - the write upserts - and an apparently
     * empty address list invites a second row for an entrance already in the
     * register, which splits that entrance's apartment numbers across two
     * address rows.
     */
    let release: (() => void) | undefined;
    fetchSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ ok: true, value: SETTINGS });
          };
        }),
    );

    renderScreen(
      [
        "association:read",
        "association:manage",
        "addressBook:read",
        "addressBook:write",
        "self:manage",
      ],
      "association",
    );

    // Picked out among the status lines rather than assumed to be the only
    // one: the security panel's connected apps read for itself and says so
    // while it is reading, which is a second unsettled read on this screen.
    expect(
      screen
        .getAllByRole("status")
        .some((node) => node.textContent?.includes("Hämtar inställningar")),
    ).toBe(true);
    // The three panels built from the unsettled read. The profile and security
    // panels below them do not depend on it and stay.
    expect(screen.queryByRole("heading", { name: /^föreningen$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^adresser$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^lägenheter$/i })).toBeNull();

    release?.();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^föreningen$/i }),
      ).toBeTruthy();
    });
  });
});

describe("a failed load", () => {
  it("says so when the addresses cannot be read", async () => {
    /*
     * The apartment register hangs off address rows. Rendered as "no addresses
     * registered", a failed load invites a board to add an entrance that already
     * exists, and the apartment numbers for one entrance then split across two
     * address rows - so the failure has to be named rather than shown as an
     * empty register.
     */
    fetchAddresses.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderScreen(
      [
        "association:read",
        "association:manage",
        "addressBook:read",
        "addressBook:write",
        "self:manage",
      ],
      "association",
    );

    await waitFor(() => {
      expect(screen.getByText(/kunde inte hämtas/i)).toBeTruthy();
    });
  });

  it("says so in a section that does not wait for the read as well", async () => {
    // The notice belongs to the frame every section shares, so a board that
    // opened its own account first still learns the instance could not be read.
    fetchAddresses.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderScreen(ADMIN, "account");

    await waitFor(() => {
      expect(screen.getByText(/kunde inte hämtas/i)).toBeTruthy();
    });
    expect(profileHeading()).toBeTruthy();
  });

  it("locks the instance panels when the settings cannot be read", async () => {
    /*
     * The cooperative write upserts. A form seeded from a read that failed shows
     * a blank name, and saving it would set the organisation number to null and
     * the language to Swedish on a cooperative that already has both.
     */
    fetchSettings.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderScreen(
      [
        "association:read",
        "association:manage",
        "addressBook:read",
        "addressBook:write",
        "self:manage",
      ],
      "association",
    );

    await waitFor(() => {
      expect(screen.getByText(/kunde inte hämtas/i)).toBeTruthy();
    });
    expect(screen.queryByRole("heading", { name: /^föreningen$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^adresser$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^lägenheter$/i })).toBeNull();
    // Nothing is known about the setup either, so the wizard is not offered.
    expect(
      screen.queryByRole("link", { name: /återuppta konfigurationen/i }),
    ).toBeNull();

    // The way out is a retry, which brings the panels back once a read lands.
    fetchSettings.mockResolvedValue({ ok: true, value: SETTINGS });
    fireEvent.click(screen.getByRole("button", { name: /försök igen/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^föreningen$/i }),
      ).toBeTruthy();
    });
  });
});

describe("a panel that a save rebuilds", () => {
  it("keeps focus in the same field when the SMTP host changes and the panel is keyed on it", async () => {
    // The panel is keyed on the host, so the save that changes it builds the
    // panel again and the field that had focus is gone with the old one.
    const user = userEvent.setup();
    const saved = {
      ...SETTINGS.smtp,
      host: "smtp.nytt.se",
    };
    saveSmtp.mockResolvedValue({ ok: true, value: saved });
    renderScreen(
      [
        "association:read",
        "association:manage",
        "addressBook:read",
        "addressBook:write",
        "self:manage",
      ],
      "communication",
    );

    const host = await screen.findByLabelText<HTMLInputElement>(/^server$/i);
    await user.clear(host);
    await user.type(host, "smtp.nytt.se");
    fetchSettings.mockResolvedValue({
      ok: true,
      value: { ...SETTINGS, smtp: saved },
    });
    await user.type(host, "{Enter}");

    await waitFor(() => {
      expect(host.isConnected).toBe(false);
    });
    const rebuilt = screen.getByLabelText<HTMLInputElement>(/^server$/i);
    expect(rebuilt.value).toBe("smtp.nytt.se");
    expect(document.activeElement).toBe(rebuilt);
  });
});

describe("two saves in quick succession", () => {
  it("keep what the second stored when the first one's read lands last", async () => {
    // Each save reads the settings again. If the older read were applied after
    // the newer one, the keyed panel would be rebuilt from a host that is no
    // longer stored, and the next save would write it back.
    const user = userEvent.setup();
    saveSmtp.mockImplementation(async (input: { host: string }) => ({
      ok: true,
      value: { ...SETTINGS.smtp, host: input.host },
    }));
    renderScreen(
      ["association:read", "association:manage", "self:manage"],
      "communication",
    );

    const first = await screen.findByLabelText<HTMLInputElement>(/^server$/i);
    let answerFirst: (result: unknown) => void = () => undefined;
    fetchSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    await user.clear(first);
    await user.type(first, "smtp.forsta.se{Enter}");
    await waitFor(() => {
      expect(saveSmtp).toHaveBeenCalledTimes(1);
    });

    fetchSettings.mockResolvedValueOnce({
      ok: true,
      value: { ...SETTINGS, smtp: { ...SETTINGS.smtp, host: "smtp.andra.se" } },
    });
    await user.clear(first);
    await user.type(first, "smtp.andra.se{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/^server$/i).value).toBe(
        "smtp.andra.se",
      );
    });

    await act(async () => {
      answerFirst({
        ok: true,
        value: {
          ...SETTINGS,
          smtp: { ...SETTINGS.smtp, host: "smtp.forsta.se" },
        },
      });
    });

    expect(screen.getByLabelText<HTMLInputElement>(/^server$/i).value).toBe(
      "smtp.andra.se",
    );
  });
});

describe("the sections", () => {
  const EVERY_CAPABILITY = [
    ...ADMIN,
    "signupRequest:decide",
    "issues:configure",
    "bookings:configure",
    "site:manage",
  ];

  it.each([
    ["no section at all", undefined],
    ["a section that does not exist", "smtp"],
  ])("sends %s on to the first one, in place", (_, section) => {
    renderScreen(ADMIN, section);

    expect(redirected).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings/$section",
        params: { section: "account" },
        replace: true,
      }),
    );
  });

  it("lists every section to a viewer who has something in each, as links", () => {
    renderScreen(BOARD_MEMBER, "account");

    const nav = screen.getByRole("navigation", {
      name: /delar av inställningarna/i,
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Mitt konto", "/settings/account"],
      ["Föreningen", "/settings/association"],
      ["Utseende", "/settings/appearance"],
      ["E-post och sms", "/settings/communication"],
      ["Kontoansökningar och kontakt", "/settings/account-requests"],
      ["Ärenden och bokningar", "/settings/issues-bookings"],
      ["Föreningsstämman", "/settings/meetings"],
      ["Dataskydd och ekonomi", "/settings/data-protection"],
    ]);
    expect(redirected).not.toHaveBeenCalled();
  });

  it("marks the open section as the current page, and only that one", () => {
    renderScreen(BOARD_MEMBER, "meetings");

    const nav = screen.getByRole("navigation", {
      name: /delar av inställningarna/i,
    });
    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual([
      "Föreningsstämman",
    ]);
  });

  it("renders only the open section's panels", async () => {
    renderScreen(EVERY_CAPABILITY, "communication");

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(
      screen.getByRole("heading", {
        name: /^styrelsens gemensamma brevlåda$/i,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^sms$/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^föreningen$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^gallring$/i })).toBeNull();
    expect(profileHeading()).toBeNull();
  });

  it("reads the instance once, whichever sections the reader moves through", async () => {
    const { rerender } = renderScreen(ADMIN, "communication");
    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });

    rerender(screenFor(ADMIN, "association"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^föreningen$/i }),
      ).toBeTruthy();
    });
    rerender(screenFor(ADMIN, "account"));
    expect(profileHeading()).toBeTruthy();

    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(fetchAddresses).toHaveBeenCalledTimes(1);
  });

  describe("a save made in a section the reader then leaves", () => {
    /*
     * The panels save inside themselves and are built again from the screen's
     * snapshot when their section is opened. The snapshot has to carry what
     * was saved, or the panel returns showing the old value while the server
     * holds the new one - and its next save writes the old one back.
     */
    const leaveAndReturn = async (
      rerender: (ui: ReactElement) => void,
      from: string,
      via: string,
    ): Promise<void> => {
      rerender(screenFor(ADMIN, via));
      await waitFor(() => {
        expect(screen.queryByRole("status")).toBeNull();
      });
      rerender(screenFor(ADMIN, from));
    };

    it("keeps the account requests switch that was saved", async () => {
      const user = userEvent.setup();
      saveSelfSignup.mockResolvedValue({ ok: true, value: { enabled: true } });
      const { rerender } = renderScreen(ADMIN, "account-requests");

      const box = await screen.findByRole<HTMLInputElement>("checkbox", {
        name: /ta emot ansökningar/i,
      });
      expect(box.checked).toBe(false);
      await user.click(box);
      await waitFor(() => {
        expect(saveSelfSignup).toHaveBeenCalledWith({ enabled: true });
      });

      await leaveAndReturn(rerender, "account-requests", "account");

      const again = screen.getByRole<HTMLInputElement>("checkbox", {
        name: /ta emot ansökningar/i,
      });
      expect(again.checked).toBe(true);
      expect(screen.getByText(/^på: ansökningar hamnar/i)).toBeTruthy();
      expect(fetchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the issue report form switch that was saved", async () => {
      const user = userEvent.setup();
      saveIssueReporting.mockResolvedValue({
        ok: true,
        value: { publicFormEnabled: false },
      });
      const { rerender } = renderScreen(ADMIN, "issues-bookings");

      const box = await screen.findByRole<HTMLInputElement>("checkbox", {
        name: /ta emot felanmälan från webbplatsen/i,
      });
      expect(box.checked).toBe(true);
      await user.click(box);
      await waitFor(() => {
        expect(saveIssueReporting).toHaveBeenCalledWith({
          publicFormEnabled: false,
        });
      });

      await leaveAndReturn(rerender, "issues-bookings", "account");

      const again = screen.getByRole<HTMLInputElement>("checkbox", {
        name: /ta emot felanmälan från webbplatsen/i,
      });
      expect(again.checked).toBe(false);
      expect(fetchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the retention period that was saved, and its notice and focus while saving", async () => {
      const user = userEvent.setup();
      saveRetention.mockResolvedValue({
        ok: true,
        value: { daysAfterMoveOut: 400 },
      });
      const { rerender } = renderScreen(ADMIN, "data-protection");

      const days = await screen.findByLabelText<HTMLInputElement>(
        /dagar efter utflyttning/i,
      );
      await user.clear(days);
      await user.type(days, "400{Enter}");
      await waitFor(() => {
        expect(saveRetention).toHaveBeenCalledWith({ daysAfterMoveOut: 400 });
      });

      // The panel is not built again by its own save.
      expect(
        await screen.findByText(/^sparat$/i, { selector: "[role=status] *" }),
      ).toBeTruthy();
      expect(days.isConnected).toBe(true);
      expect(document.activeElement).toBe(days);

      await leaveAndReturn(rerender, "data-protection", "account");

      expect(
        screen.getByLabelText<HTMLInputElement>(/dagar efter utflyttning/i)
          .value,
      ).toBe("400");
      expect(fetchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps a save made while an earlier save's reload is still out", async () => {
      const user = userEvent.setup();
      const finances = {
        financialYearStartMonth: 1,
        bankgiro: "123-4567",
        plusgiro: null,
      };
      saveFinances.mockResolvedValue({ ok: true, value: finances });
      saveRetention.mockResolvedValue({
        ok: true,
        value: { daysAfterMoveOut: 400 },
      });
      const { rerender } = renderScreen(ADMIN, "data-protection");

      const bankgiro = await screen.findByLabelText<HTMLInputElement>(
        /^bankgiro/i,
      );
      // The reload the finances save starts is held back, as a slow server
      // would: it began before the retention save below and answers with the
      // value from before it.
      let answer: (value: unknown) => void = () => undefined;
      fetchSettings.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      await user.type(bankgiro, "123-4567");
      fireEvent.submit(bankgiro.closest("form") as HTMLFormElement);
      await waitFor(() => {
        expect(saveFinances).toHaveBeenCalled();
        expect(fetchSettings).toHaveBeenCalledTimes(2);
      });

      const days = screen.getByLabelText<HTMLInputElement>(
        /dagar efter utflyttning/i,
      );
      await user.clear(days);
      await user.type(days, "400{Enter}");
      await waitFor(() => {
        expect(saveRetention).toHaveBeenCalledWith({ daysAfterMoveOut: 400 });
      });

      await act(async () => {
        answer({ ok: true, value: { ...SETTINGS, finances } });
        await Promise.resolve();
      });
      // The read's own change is kept ...
      await waitFor(() => {
        expect(
          screen.getByLabelText<HTMLInputElement>(/^bankgiro/i).value,
        ).toBe("123-4567");
      });

      // ... and so is the save it did not know about.
      await leaveAndReturn(rerender, "data-protection", "account");
      expect(
        screen.getByLabelText<HTMLInputElement>(/dagar efter utflyttning/i)
          .value,
      ).toBe("400");
    });

    it("keeps the data protection contacts that were saved", async () => {
      const user = userEvent.setup();
      const stored = {
        controller: {
          contactEmail: "styrelsen@exempel.se",
          postalAddress: null,
        },
        officer: { name: null, email: null, phone: null },
        jointController: { name: null, contact: null },
      };
      saveDataProtectionContacts.mockResolvedValue({
        ok: true,
        value: stored,
      });
      const { rerender } = renderScreen(ADMIN, "data-protection");

      const email = await screen.findByLabelText<HTMLInputElement>(
        /^e-post till föreningen$/i,
      );
      await user.type(email, "styrelsen@exempel.se{Enter}");
      await waitFor(() => {
        expect(saveDataProtectionContacts).toHaveBeenCalled();
      });
      await screen.findByText(/^sparat$/i);

      await leaveAndReturn(rerender, "data-protection", "account");

      expect(
        screen.getByLabelText<HTMLInputElement>(/^e-post till föreningen$/i)
          .value,
      ).toBe("styrelsen@exempel.se");
      expect(fetchSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the language that was saved on the profile", async () => {
      onTestFinished(async () => {
        await i18n.changeLanguage("sv");
      });
      const user = userEvent.setup();
      saveOwnProfile.mockResolvedValue({
        ok: true,
        value: { preferredLocale: "en" },
      });
      const { rerender } = renderScreen(ADMIN, "account");

      const select = await screen.findByLabelText<HTMLSelectElement>(
        /språk för e-post och utdrag/i,
      );
      expect(select.value).toBe("sv");
      await user.selectOptions(select, "en");
      await user.click(screen.getByRole("button", { name: /^spara$/i }));
      await waitFor(() => {
        expect(saveOwnProfile).toHaveBeenCalledWith({ preferredLocale: "en" });
      });

      rerender(screenFor(ADMIN, "association"));
      rerender(screenFor(ADMIN, "account"));

      // The interface follows the saved language; find the select by its name.
      const again = await screen.findByRole<HTMLSelectElement>("combobox");
      expect(again.value).toBe("en");
    });
  });
});
