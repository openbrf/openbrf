import { describe, expect, it } from "vite-plus/test";

import {
  associationSectionsFor,
  panelsIn,
  SETTINGS_PANELS,
  SETTINGS_SECTIONS,
  settingsAccessOf,
} from "./settings-sections";

const ids = (sections: readonly { id: string }[]): string[] =>
  sections.map((section) => section.id);

const RESIDENT = settingsAccessOf(["self:manage", "residentDirectory:read"]);
const BOARD_MEMBER = settingsAccessOf([
  "association:read",
  "addressBook:read",
  "self:manage",
]);
const EVERYTHING = settingsAccessOf([
  "association:read",
  "association:manage",
  "addressBook:write",
  "signupRequest:decide",
  "issues:configure",
  "site:manage",
  "bookings:configure",
]);

describe("the panels", () => {
  it("are each in exactly one section", () => {
    const panelIds = SETTINGS_PANELS.map((panel) => panel.id);
    expect(new Set(panelIds).size).toBe(panelIds.length);

    const sectionIds = new Set<string>(ids(SETTINGS_SECTIONS));
    for (const panel of SETTINGS_PANELS) {
      expect(sectionIds.has(panel.section)).toBe(true);
    }
  });

  it("are all offered to a viewer who holds every capability", () => {
    const offered = SETTINGS_SECTIONS.flatMap((section) =>
      panelsIn(section.id, EVERYTHING),
    );
    expect(offered).toHaveLength(SETTINGS_PANELS.length);
  });

  it("about the instance are offered to nobody who may not read it", () => {
    // Every one of them is built from the instance settings, which are never
    // read for a viewer without association:read.
    const withoutRead = settingsAccessOf([
      "association:manage",
      "signupRequest:decide",
      "issues:configure",
      "bookings:configure",
    ]);
    const offered = SETTINGS_SECTIONS.flatMap((section) =>
      panelsIn(section.id, withoutRead),
    );
    expect(offered.map((panel) => panel.id)).toEqual(["profile", "security"]);
  });

  it.each([
    ["signupQueue", "signupRequest:decide"],
    ["contactInbox", "signupRequest:decide"],
    ["brokerUpdateRequests", "site:manage"],
    ["issueTypes", "issues:configure"],
    ["bookableResources", "bookings:configure"],
    ["themes", "association:manage"],
  ])("offers %s only with %s", (id, capability) => {
    const panel = SETTINGS_PANELS.find((each) => each.id === id);
    expect(panel?.shownTo(BOARD_MEMBER)).toBe(false);
    expect(
      panel?.shownTo(
        settingsAccessOf(["association:read", "self:manage", capability]),
      ),
    ).toBe(true);
  });

  it.each(["contactInbox", "brokerUpdateRequests"])(
    "offers %s to no support session, though it holds the capability",
    (id) => {
      const panel = SETTINGS_PANELS.find((each) => each.id === id);
      const capabilities = [
        "association:read",
        "signupRequest:decide",
        "site:manage",
      ];
      expect(panel?.shownTo(settingsAccessOf(capabilities))).toBe(true);
      expect(panel?.shownTo(settingsAccessOf(capabilities, true))).toBe(false);
    },
  );
});

describe("the association's sections a viewer is offered", () => {
  it("are none for a resident, whose settings are their own account", () => {
    expect(ids(associationSectionsFor(RESIDENT))).toEqual([]);
    expect(panelsIn("account", RESIDENT).map((panel) => panel.id)).toEqual([
      "profile",
      "security",
    ]);
  });

  it("are every one of them for somebody who reads the instance settings", () => {
    expect(ids(associationSectionsFor(BOARD_MEMBER))).toEqual(
      ids(
        SETTINGS_SECTIONS.filter((section) => section.group === "association"),
      ),
    );
  });

  it("never include the account, which is /settings rather than a section", () => {
    for (const access of [RESIDENT, BOARD_MEMBER, EVERYTHING]) {
      expect(ids(associationSectionsFor(access))).not.toContain("account");
    }
  });

  it("leave a support session, which has no account, the association's alone", () => {
    const support = settingsAccessOf(["association:read"], true);
    expect(panelsIn("account", support)).toEqual([]);
    expect(associationSectionsFor(support).length).toBeGreaterThan(0);
  });
});
