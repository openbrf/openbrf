import { describe, expect, it } from "vitest";

import type { ApiFailure } from "../api/client";
import {
  eventFailureKey,
  type EventReason,
  refusedDates,
  scannedFields,
} from "./event-failures";

/**
 * The refusals the event screens read, and the particulars they act on.
 *
 * That every reason has a sentence is a compile-time fact: the map is checked
 * against the whole union, so a reason without one is a build failure rather
 * than a test. What is left for this file is the part a type cannot state.
 *
 * That the two refusals carrying particulars publish something a screen can
 * render - a field name a board member can be sent to edit, and a date they can
 * go and call off - and that nothing else gets through the narrowing. Both read
 * `ApiFailure.detail`, which is `unknown` and endpoint-specific, so what is
 * asserted here is what happens to a shape the client did not expect.
 *
 * And that the reasons which are also refusals by status - every one of these
 * arrives as a 403 in this file - are resolved by the map rather than by the
 * shared branch that answers a forbidden request.
 */

const refused = (
  reason: string,
  detail?: unknown,
  status = 409,
): ApiFailure => ({ status, reason, detail });

/**
 * Every reason the module can answer with, written out.
 *
 * Duplicated from the client's own union deliberately: the union is what the map
 * is checked against, so a test importing it would be asserting that a list
 * matches itself. This is the list read out of the API's `EventReason`, so a
 * reason renamed on the server without the client following shows up here.
 */
const REASONS: readonly EventReason[] = [
  "not-found",
  "occurrence-not-found",
  "personal-identity-number",
  "invalid-date",
  "recurrence-interval-invalid",
  "recurrence-end-required",
  "recurrence-end-ambiguous",
  "recurrence-end-invalid",
  "recurrence-past-horizon",
  "duration-invalid",
  "start-does-not-exist",
  "capacity-not-positive",
  "occurrence-in-use",
  "occurrence-already-cancelled",
  "signup-not-offered",
  "occurrence-cancelled",
  "occurrence-started",
  "occurrence-full",
  "already-signed-up",
  "already-withdrawn",
  "signup-not-found",
];

describe("the sentence a refusal maps to", () => {
  it("gives every reason a sentence of its own", () => {
    const keys = REASONS.map((reason) => eventFailureKey(refused(reason)));

    expect(keys).not.toContain("events.errors.unknown");
    // Distinct as well as present. Two reasons sharing one sentence would pass
    // the check above while telling a board member that the places are gone
    // when what happened was that the date had been called off.
    expect(new Set(keys).size).toBe(REASONS.length);
  });

  it("falls back for a reason this build has never heard of", () => {
    expect(eventFailureKey(refused("brand-new-reason"))).toBe(
      "events.errors.unknown",
    );
  });

  it("answers a request the guard refused with the shared sentence", () => {
    // Nothing in this module needs its own 403 sentence: every reason above is
    // about the state of a date or the shape of a series, and an account that
    // holds neither capability is told what the rest of the product tells it.
    expect(eventFailureKey(refused("nothing-mapped", undefined, 403))).toBe(
      "settings.errors.forbidden",
    );
  });

  it("answers a request that never reached the server", () => {
    expect(eventFailureKey({ status: 0, reason: "offline" })).toBe(
      "settings.errors.unknown",
    );
  });
});

describe("the fields a scan refusal names", () => {
  it("names each field the refusal pointed at, once", () => {
    expect(
      scannedFields(
        refused("personal-identity-number", [
          { field: "description", offset: 12 },
          { field: "title", offset: 3 },
          { field: "description", offset: 80 },
        ]),
      ),
    ).toEqual(["description", "title"]);
  });

  it("drops a field name this client cannot render", () => {
    /*
     * The screen has one sentence per field of the form and no fifth. A name it
     * does not know would have to be folded into one of the four, so a board
     * member would be sent to edit text that holds nothing while the personal
     * identity number stayed where it was - and the series would be refused
     * again for a reason they had just been told they had fixed.
     */
    expect(
      scannedFields(
        refused("personal-identity-number", [
          { field: "attachment", offset: 0 },
          { field: "location", offset: 4 },
        ]),
      ),
    ).toEqual(["location"]);
  });

  it("answers a refusal carrying no locations with nothing", () => {
    expect(scannedFields(refused("personal-identity-number"))).toEqual([]);
    expect(scannedFields(refused("personal-identity-number", {}))).toEqual([]);
    expect(
      scannedFields(
        refused("personal-identity-number", [null, "description", 7]),
      ),
    ).toEqual([]);
  });
});

describe("the dates an in-use refusal names", () => {
  it("keeps the dates in the order the refusal stated them", () => {
    expect(
      refusedDates(refused("occurrence-in-use", ["2026-04-18", "2026-10-17"])),
    ).toEqual(["2026-04-18", "2026-10-17"]);
  });

  it("drops anything that is not a date in that form", () => {
    // These reach a sentence on the screen, so a value of another shape would
    // put whatever it held in front of the board. A refusal is not a place to
    // start trusting `detail`.
    expect(
      refusedDates(
        refused("occurrence-in-use", [
          "2026-04-18",
          "den 18 april",
          17,
          null,
          { on: "2026-05-01" },
          "2026-4-18",
        ]),
      ),
    ).toEqual(["2026-04-18"]);
  });

  it("answers every other refusal with no dates at all", () => {
    // The scan refusal carries field locations in the same field, and a sentence
    // about dates built out of those would name none of them and read as though
    // it had been cut off.
    expect(
      refusedDates(
        refused("personal-identity-number", [{ field: "title", offset: 3 }]),
      ),
    ).toEqual([]);
    expect(refusedDates(refused("occurrence-full"))).toEqual([]);
  });
});
