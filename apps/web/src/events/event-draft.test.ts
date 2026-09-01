import { describe, expect, it } from "vitest";

import type { EventSeries } from "../api/events";
import {
  draftOf,
  EMPTY_DRAFT,
  type EventDraft,
  inputOf,
  signatureOf,
} from "./event-draft";

/**
 * What the form sends, and what it refuses to send yet.
 *
 * Two properties matter here and neither is visible in the components.
 *
 * A field the shape does not use is sent as null rather than left out. The API
 * reads a cleared field and an omitted one as the same thing, so a series turned
 * from repeating into a single date has to say that its rule is gone - otherwise
 * it keeps a rule describing something it no longer does.
 *
 * An unfinished form sends nothing at all, and "unfinished" never quietly
 * becomes "no limit". A slip in the places field that was read as an absent
 * capacity would turn a cleaning day with twenty places into one with none, and
 * that is the single direction this conversion must not fail in.
 */

const COMPLETE: EventDraft = {
  ...EMPTY_DRAFT,
  title: "  Cleaning day  ",
  description: "  Bring gloves.  ",
  category: "  Cleaning  ",
  location: "  The courtyard  ",
  firstOn: "2026-04-18",
  startsAt: "10:00",
  durationMinutes: "180",
};

/** A stored series, so the two conversions can be read against each other. */
const STORED: EventSeries = {
  id: "event-cleaning",
  title: "Cleaning day",
  description: "Bring gloves.",
  category: "Cleaning",
  location: "The courtyard",
  visibility: "MEMBER",
  published: true,
  publishedAt: "2026-03-01T08:00:00.000Z",
  signupOpen: true,
  capacity: 20,
  firstOn: "2026-04-18",
  startsAtMinute: 600,
  durationMinutes: 180,
  recurrence: {
    frequency: "MONTHLY",
    interval: 6,
    count: null,
    until: "2027-10-17",
  },
  occurrenceCount: 0,
  occurrences: [],
};

describe("what the form sends", () => {
  it("trims the text and sends an empty field as nothing", () => {
    expect(inputOf(COMPLETE)).toEqual({
      title: "Cleaning day",
      description: "Bring gloves.",
      category: "Cleaning",
      location: "The courtyard",
      signupOpen: false,
      capacity: null,
      firstOn: "2026-04-18",
      startsAtMinute: 600,
      durationMinutes: 180,
      recurrence: null,
    });

    expect(
      inputOf({ ...COMPLETE, description: "   ", category: "", location: " " }),
    ).toMatchObject({ description: null, category: null, location: null });
  });

  it("sends the time of day as minutes and never as an instant", () => {
    // The server turns the minute into an instant per date on the association's
    // clock. An instant assembled here would be an hour out on the two dates a
    // year the clocks move, which is exactly when a cleaning day matters.
    expect(inputOf({ ...COMPLETE, startsAt: "07:30" })).toMatchObject({
      startsAtMinute: 450,
    });
    expect(inputOf({ ...COMPLETE, startsAt: "00:00" })).toMatchObject({
      startsAtMinute: 0,
    });
  });

  it("sends no rule for a series that happens once", () => {
    expect(inputOf({ ...COMPLETE, frequency: "" })).toMatchObject({
      recurrence: null,
    });
  });

  it("states exactly the end the form is set to", () => {
    expect(
      inputOf({
        ...COMPLETE,
        frequency: "WEEKLY",
        interval: "2",
        end: "count",
        count: "6",
        // Left over from a form that was on a last date a moment ago. The rule
        // states one end, and a payload carrying both is refused by the server
        // with a reason of its own.
        until: "2026-12-24",
      }),
    ).toMatchObject({
      recurrence: {
        frequency: "WEEKLY",
        interval: 2,
        count: 6,
        until: null,
      },
    });

    expect(
      inputOf({
        ...COMPLETE,
        frequency: "ANNUAL",
        interval: "1",
        end: "until",
        count: "6",
        until: "2028-04-18",
      }),
    ).toMatchObject({
      recurrence: {
        frequency: "ANNUAL",
        interval: 1,
        count: null,
        until: "2028-04-18",
      },
    });
  });

  it("sends a capacity only for a series that takes sign-ups", () => {
    expect(
      inputOf({ ...COMPLETE, signupOpen: true, capacity: "20" }),
    ).toMatchObject({ signupOpen: true, capacity: 20 });

    // The capacity is left over from before the checkbox was cleared. Sending it
    // would ask the server to keep a limit on a series nobody can sign up to.
    expect(
      inputOf({ ...COMPLETE, signupOpen: false, capacity: "20" }),
    ).toMatchObject({ signupOpen: false, capacity: null });
  });
});

describe("what the form will not send yet", () => {
  it("sends nothing while a required field is empty", () => {
    expect(inputOf(EMPTY_DRAFT)).toBeNull();
    expect(inputOf({ ...COMPLETE, title: "   " })).toBeNull();
    expect(inputOf({ ...COMPLETE, firstOn: "" })).toBeNull();
    expect(inputOf({ ...COMPLETE, startsAt: "" })).toBeNull();
    expect(inputOf({ ...COMPLETE, durationMinutes: "" })).toBeNull();
    expect(inputOf({ ...COMPLETE, durationMinutes: "0" })).toBeNull();
  });

  it("sends nothing while a repeating rule states no end", () => {
    expect(
      inputOf({ ...COMPLETE, frequency: "WEEKLY", end: "count", count: "" }),
    ).toBeNull();
    expect(
      inputOf({ ...COMPLETE, frequency: "WEEKLY", end: "until", until: "" }),
    ).toBeNull();
    expect(
      inputOf({ ...COMPLETE, frequency: "WEEKLY", interval: "" }),
    ).toBeNull();
  });

  it("refuses a capacity it cannot read rather than reading it as no limit", () => {
    // The one direction this must not fail in: an unreadable places field that
    // became `null` would publish a cleaning day with no limit on it at all.
    expect(
      inputOf({ ...COMPLETE, signupOpen: true, capacity: "twenty" }),
    ).toBeNull();
    expect(
      inputOf({ ...COMPLETE, signupOpen: true, capacity: "2.5" }),
    ).toBeNull();
    expect(
      inputOf({ ...COMPLETE, signupOpen: true, capacity: "0" }),
    ).toBeNull();

    // An empty field is a limit nobody set, which is what no limit means.
    expect(
      inputOf({ ...COMPLETE, signupOpen: true, capacity: "" }),
    ).toMatchObject({ capacity: null });
  });

  it("sends nothing for a date that is not written as one", () => {
    expect(inputOf({ ...COMPLETE, firstOn: "18/4 2026" })).toBeNull();
    expect(
      inputOf({
        ...COMPLETE,
        frequency: "WEEKLY",
        end: "until",
        until: "24 dec",
      }),
    ).toBeNull();
  });
});

describe("the stored series as the form holds it", () => {
  it("opens on the end the rule actually states", () => {
    expect(draftOf(STORED)).toMatchObject({
      end: "until",
      until: "2027-10-17",
      count: "",
      interval: "6",
      frequency: "MONTHLY",
    });

    expect(
      draftOf({
        ...STORED,
        recurrence: {
          frequency: "WEEKLY",
          interval: 1,
          count: 8,
          until: null,
        },
      }),
    ).toMatchObject({ end: "count", count: "8", until: "" });
  });

  it("holds the time of day as a time field's value", () => {
    expect(draftOf(STORED)).toMatchObject({ startsAt: "10:00" });
    expect(draftOf({ ...STORED, startsAtMinute: 0 })).toMatchObject({
      startsAt: "00:00",
    });
    expect(draftOf({ ...STORED, startsAtMinute: 1139 })).toMatchObject({
      startsAt: "18:59",
    });
  });

  it("survives a round trip through what the form would send", () => {
    // The board opening a series and pressing save without touching anything
    // must send back what is stored. A field the conversion forgot in either
    // direction would silently clear itself on the next save.
    expect(inputOf(draftOf(STORED))).toEqual({
      title: STORED.title,
      description: STORED.description,
      category: STORED.category,
      location: STORED.location,
      signupOpen: STORED.signupOpen,
      capacity: STORED.capacity,
      firstOn: STORED.firstOn,
      startsAtMinute: STORED.startsAtMinute,
      durationMinutes: STORED.durationMinutes,
      recurrence: STORED.recurrence,
    });
  });
});

describe("the key a row re-seeds its fields from", () => {
  it("changes when any field the form can change does", () => {
    const base = signatureOf(STORED);

    expect(signatureOf({ ...STORED, title: "Sauna evening" })).not.toBe(base);
    expect(signatureOf({ ...STORED, description: null })).not.toBe(base);
    expect(signatureOf({ ...STORED, category: null })).not.toBe(base);
    expect(signatureOf({ ...STORED, location: null })).not.toBe(base);
    expect(signatureOf({ ...STORED, signupOpen: false })).not.toBe(base);
    expect(signatureOf({ ...STORED, capacity: null })).not.toBe(base);
    expect(signatureOf({ ...STORED, firstOn: "2026-04-25" })).not.toBe(base);
    expect(signatureOf({ ...STORED, startsAtMinute: 660 })).not.toBe(base);
    expect(signatureOf({ ...STORED, durationMinutes: 120 })).not.toBe(base);
    expect(signatureOf({ ...STORED, recurrence: null })).not.toBe(base);
    expect(
      signatureOf({
        ...STORED,
        recurrence: {
          frequency: "MONTHLY",
          interval: 12,
          count: null,
          until: "2027-10-17",
        },
      }),
    ).not.toBe(base);
  });

  it("ignores what the form cannot change", () => {
    // Publishing is its own act with its own control, so a series that was
    // published while the board had its fields open must not re-seed them and
    // throw away what they had typed.
    expect(signatureOf({ ...STORED, published: false })).toBe(
      signatureOf(STORED),
    );
    expect(signatureOf({ ...STORED, visibility: "PUBLIC" })).toBe(
      signatureOf(STORED),
    );
  });

  it("tells two series apart whatever the board typed in the free text", () => {
    // Four of these fields are free text, so every character is one somebody may
    // write. Two series that differ only in where a separator falls between two
    // of them must not share a key: they would leave the row showing what was
    // typed after a save had stored something else.
    expect(
      signatureOf({ ...STORED, title: "Cleaning day|", description: "" }),
    ).not.toBe(
      signatureOf({ ...STORED, title: "Cleaning day", description: "|" }),
    );

    expect(
      signatureOf({ ...STORED, category: "Sauna|", location: "The courtyard" }),
    ).not.toBe(
      signatureOf({ ...STORED, category: "Sauna", location: "|The courtyard" }),
    );
  });
});
