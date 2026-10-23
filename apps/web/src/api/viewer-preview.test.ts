import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Viewer } from "./instance";
import {
  asPreviewed,
  endResidentPreviewOn,
  forgetResidentPreview,
  leftPageAfterResidentPreview,
  offersResidentPreview,
  previewed,
  RESIDENT_PREVIEW_CAPABILITIES,
  residentPreview,
  setResidentPreview,
  subscribeToResidentPreview,
} from "./viewer-preview";

/** What a board member who lives here holds: a seat's grants and a home's. */
const BOARD_MEMBER_AT_HOME = [
  "issues:handle",
  "bookings:manage",
  "documents:manage",
  "addressBook:read",
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "motions:submit",
];

/** The external property manager: the issue queue and their own account. */
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

/** Somebody who lives here and is a member: nothing more to take away. */
const MEMBER = ["self:manage", "residentDirectory:read", "motions:submit"];

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Berit",
    lastName: "Styrelse",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: null,
  };
}

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

describe("the capabilities a resident preview keeps", () => {
  /*
   * The server's RESIDENT_CAPABILITIES and MEMBER_CAPABILITIES, written out
   * here a second time on purpose: a change to the client's copy has to be
   * made in this test as well, by somebody who then checks capabilities.ts.
   */
  it("are a resident's and a member's grants, and nothing else", () => {
    expect([...RESIDENT_PREVIEW_CAPABILITIES].toSorted()).toEqual(
      [
        "bookings:book",
        "chat:participate",
        "events:attend",
        "issues:report",
        "keyOrders:place",
        "motions:submit",
        "news:comment",
        "residentDirectory:read",
        "self:manage",
        "sublets:apply",
      ].toSorted(),
    );
  });

  it("narrow a viewer to those, keeping everything else about them", () => {
    const viewer = viewerWith(BOARD_MEMBER_AT_HOME);
    expect(previewed(viewer)).toEqual({
      ...viewer,
      capabilities: [
        "self:manage",
        "residentDirectory:read",
        "issues:report",
        "news:comment",
        "bookings:book",
        "motions:submit",
      ],
    });
  });
});

describe("who is offered the preview", () => {
  it("is an account that sees more than a resident and holds a resident's grants", () => {
    expect(offersResidentPreview(BOARD_MEMBER_AT_HOME)).toBe(true);
  });

  it("is never the property manager, whose own account is all a resident's they hold", () => {
    expect(offersResidentPreview(PROPERTY_MANAGER)).toBe(false);
  });

  it("is never a resident, who has nothing more to take away", () => {
    expect(offersResidentPreview(MEMBER)).toBe(false);
  });
});

describe("the preview's state", () => {
  it("is off, and offered to nobody, until a viewer is read", () => {
    expect(residentPreview()).toMatchObject({
      on: false,
      offered: false,
      endedOn: null,
    });
  });

  it("narrows the viewer only while it is on", () => {
    const viewer = viewerWith(BOARD_MEMBER_AT_HOME);
    expect(asPreviewed(viewer)).toBe(viewer);
    expect(residentPreview().offered).toBe(true);

    setResidentPreview(true);
    expect(asPreviewed(viewer).capabilities).not.toContain("issues:handle");

    setResidentPreview(false);
    expect(asPreviewed(viewer)).toBe(viewer);
  });

  it("is kept in the tab's session storage and nowhere else", () => {
    setResidentPreview(true);
    expect(sessionStorage.getItem("openbrf.preview")).toBe("resident");
    expect(localStorage.length).toBe(0);

    setResidentPreview(false);
    expect(sessionStorage.getItem("openbrf.preview")).toBeNull();
  });

  it("is read back from the tab when the page loads again", async () => {
    sessionStorage.setItem("openbrf.preview", "resident");
    vi.resetModules();
    const reloaded = await import("./viewer-preview");
    expect(reloaded.residentPreview().on).toBe(true);
  });

  it("asks the frame to mount the screens again when switched, unless told not to", () => {
    const before = residentPreview().generation;
    setResidentPreview(true);
    expect(residentPreview().generation).toBe(before + 1);
    setResidentPreview(false, { remount: false });
    expect(residentPreview().generation).toBe(before + 1);
  });

  it("tells whoever listens, and only on a change", () => {
    const listener = vi.fn();
    const stop = subscribeToResidentPreview(listener);
    setResidentPreview(true);
    setResidentPreview(true);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setResidentPreview(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ends on one of the board's pages, and says so until the reader leaves it", () => {
    setResidentPreview(true);
    endResidentPreviewOn("/board/issues");
    expect(residentPreview()).toMatchObject({
      on: false,
      endedOn: "/board/issues",
    });
    expect(sessionStorage.getItem("openbrf.preview")).toBeNull();

    leftPageAfterResidentPreview("/board/issues");
    expect(residentPreview().endedOn).toBe("/board/issues");
    leftPageAfterResidentPreview("/");
    expect(residentPreview().endedOn).toBeNull();
  });

  it("says nothing on a board page when it was not on", () => {
    endResidentPreviewOn("/board");
    expect(residentPreview().endedOn).toBeNull();
  });

  it("is switched off, not applied, for an account that is not offered it", () => {
    setResidentPreview(true);
    const viewer = viewerWith(PROPERTY_MANAGER);
    expect(asPreviewed(viewer)).toBe(viewer);
    expect(residentPreview()).toMatchObject({ on: false, offered: false });
    expect(sessionStorage.getItem("openbrf.preview")).toBeNull();
  });

  it("is forgotten for the next sign-in", () => {
    asPreviewed(viewerWith(BOARD_MEMBER_AT_HOME));
    setResidentPreview(true);
    forgetResidentPreview();
    expect(residentPreview()).toMatchObject({ on: false, offered: false });
    expect(sessionStorage.getItem("openbrf.preview")).toBeNull();
  });
});
