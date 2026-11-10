import { describe, expect, it } from "vite-plus/test";

import {
  type KeyedWeighing,
  type StandingWeighing,
  strictestWeighing,
  weighingsByText,
} from "./issue-access-weighing";

/**
 * Which of several weighings on one text the report reads. The database holds
 * a text to one per report (`issue_access_weighing_text_key`); these are what
 * the readers do should two ever stand, so that a second row could never give
 * what the first left out (ADR 0057).
 */

const given: StandingWeighing = { withheldBecause: null, givenText: null };
const inPart: StandingWeighing = {
  withheldBecause: "ABOUT_ANOTHER_PERSON",
  givenText: "Grannen […] klagade",
};
const withheld: StandingWeighing = {
  withheldBecause: "IDENTIFIES_REPORTER",
  givenText: null,
};

describe("the weighing that stands of the rows on one text", () => {
  it("is none where there is no row", () => {
    expect(strictestWeighing([])).toBeUndefined();
  });

  it("is the row itself where there is one", () => {
    expect(strictestWeighing([inPart])).toEqual(inPart);
  });

  it("leaves a text out whole where any row does, whatever the order", () => {
    expect(strictestWeighing([given, withheld])).toEqual(withheld);
    expect(strictestWeighing([withheld, given])).toEqual(withheld);
    expect(strictestWeighing([inPart, withheld, given])).toEqual(withheld);
  });

  it("gives a copy in part before the text whole", () => {
    expect(strictestWeighing([given, inPart])).toEqual(inPart);
    expect(strictestWeighing([inPart, given])).toEqual(inPart);
  });

  it("leaves a text out whole where two copies given in part differ", () => {
    const other: StandingWeighing = {
      withheldBecause: "IDENTIFIES_REPORTER",
      givenText: "[…] klagade på musiken",
    };
    expect(strictestWeighing([inPart, other])).toEqual({
      withheldBecause: "ABOUT_ANOTHER_PERSON",
      givenText: null,
    });
    expect(strictestWeighing([inPart, given, other])).toEqual({
      withheldBecause: "ABOUT_ANOTHER_PERSON",
      givenText: null,
    });
  });

  it("gives the copy where two rows give the same one", () => {
    expect(strictestWeighing([inPart, { ...inPart }])).toEqual(inPart);
  });
});

describe("the weighings of one report, by text", () => {
  it("keys each text apart and takes the most restrictive row on each", () => {
    const rows: KeyedWeighing[] = [
      {
        part: "DESCRIPTION",
        messageId: null,
        noteId: null,
        workOrderId: null,
        ...given,
      },
      {
        part: "DESCRIPTION",
        messageId: null,
        noteId: null,
        workOrderId: null,
        ...withheld,
      },
      {
        part: "LOCATION",
        messageId: null,
        noteId: null,
        workOrderId: null,
        ...given,
      },
      {
        part: "NOTE",
        messageId: null,
        noteId: "n1",
        workOrderId: null,
        ...given,
      },
      {
        part: "NOTE",
        messageId: null,
        noteId: "n2",
        workOrderId: null,
        ...inPart,
      },
      {
        part: "MESSAGE",
        messageId: "m1",
        noteId: null,
        workOrderId: null,
        ...given,
      },
      {
        part: "MESSAGE",
        messageId: "m1",
        noteId: null,
        workOrderId: null,
        ...inPart,
      },
      {
        part: "WORK_ORDER",
        messageId: null,
        noteId: null,
        workOrderId: "w1",
        ...given,
      },
      {
        part: "WORK_ORDER",
        messageId: null,
        noteId: null,
        workOrderId: "w2",
        ...withheld,
      },
    ];
    const byText = weighingsByText(rows);
    expect(byText.get("DESCRIPTION")).toMatchObject(withheld);
    expect(byText.get("LOCATION")).toMatchObject(given);
    expect(byText.get("NOTE:n1")).toMatchObject(given);
    expect(byText.get("NOTE:n2")).toMatchObject(inPart);
    expect(byText.get("MESSAGE:m1")).toMatchObject(inPart);
    expect(byText.get("WORK_ORDER:w1")).toMatchObject(given);
    expect(byText.get("WORK_ORDER:w2")).toMatchObject(withheld);
    expect(byText.size).toBe(7);
  });
});
