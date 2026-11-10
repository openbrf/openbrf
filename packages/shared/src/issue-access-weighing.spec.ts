import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_ACCESS_LEFT_OUT_MARK as MARK,
  ISSUE_ACCESS_PARTS,
  isGivenInPartOf,
  issueAccessPartHasId,
} from "./issue-access-weighing.ts";

const TEXT =
  "I in apartment 1102 hear the neighbour playing music every night.";

describe("isGivenInPartOf", () => {
  it("accepts the text with words taken out and each place marked", () => {
    expect(
      isGivenInPartOf(
        `I ${MARK} hear the neighbour playing music every night.`,
        TEXT,
      ),
    ).toBe(true);
    expect(
      isGivenInPartOf(`${MARK} hear the neighbour playing music ${MARK}`, TEXT),
    ).toBe(true);
  });

  it("accepts the mark written with three full stops", () => {
    expect(
      isGivenInPartOf(
        "I [...] hear the neighbour playing music every night.",
        TEXT,
      ),
    ).toBe(true);
  });

  it("refuses a copy that puts in a word the text does not hold", () => {
    expect(
      isGivenInPartOf(
        `I ${MARK} hear the neighbour playing loud music every night.`,
        TEXT,
      ),
    ).toBe(false);
  });

  it("refuses a copy that moves the text's words out of their order", () => {
    expect(
      isGivenInPartOf(
        `every night ${MARK} hear the neighbour playing music`,
        TEXT,
      ),
    ).toBe(false);
  });

  it("refuses words taken out without a mark where they were", () => {
    expect(
      isGivenInPartOf("I hear the neighbour playing music every night.", TEXT),
    ).toBe(false);
  });

  it("refuses words left out at the start or the end without a mark", () => {
    // Each kept piece is the text's own words in order, but the words before
    // the first piece, or after the last, are gone with no mark where they were.
    expect(isGivenInPartOf(`beta ${MARK}`, "alpha beta gamma")).toBe(false);
    expect(isGivenInPartOf(`${MARK} beta`, "alpha beta gamma")).toBe(false);
    expect(
      isGivenInPartOf(
        `The neighbour ${MARK} plays music.`,
        "The neighbour in 1102 plays music. I am not sure which apartment it comes from.",
      ),
    ).toBe(false);
    expect(
      isGivenInPartOf(`hear the neighbour ${MARK} every night.`, TEXT),
    ).toBe(false);
  });

  it("accepts the same words left out where a mark says so", () => {
    expect(isGivenInPartOf(`${MARK} beta ${MARK}`, "alpha beta gamma")).toBe(
      true,
    );
    expect(
      isGivenInPartOf(
        `The neighbour ${MARK} plays music. ${MARK}`,
        "The neighbour in 1102 plays music. I am not sure which apartment it comes from.",
      ),
    ).toBe(true);
  });

  it("accepts several places left out, each marked, and refuses one unmarked among them", () => {
    const text =
      "Anna in 1102 says the dog in 1104 barks at night and Bo in 1201 agrees.";
    expect(
      isGivenInPartOf(
        `Anna ${MARK} says the dog ${MARK} barks at night and ${MARK} agrees.`,
        text,
      ),
    ).toBe(true);
    expect(
      isGivenInPartOf(
        `${MARK} says the dog ${MARK} barks at night ${MARK}`,
        text,
      ),
    ).toBe(true);
    // The words "in 1104" are gone between two kept pieces with no mark there.
    expect(
      isGivenInPartOf(
        `Anna ${MARK} says the dog barks at night and ${MARK} agrees.`,
        text,
      ),
    ).toBe(false);
  });

  it("refuses kept pieces that overlap in the text", () => {
    expect(isGivenInPartOf(`ab ${MARK} ba`, "aba")).toBe(false);
  });

  it("refuses a copy that joins two words or splits one", () => {
    expect(
      isGivenInPartOf(
        `I ${MARK} hear theneighbour playing music every night.`,
        TEXT,
      ),
    ).toBe(false);
    expect(
      isGivenInPartOf(
        `I ${MARK} hear the neigh bour playing music every night.`,
        TEXT,
      ),
    ).toBe(false);
  });

  it("refuses a copy that keeps nothing, or leaves nothing out", () => {
    expect(isGivenInPartOf(MARK, TEXT)).toBe(false);
    expect(isGivenInPartOf(` ${MARK}  ${MARK} `, TEXT)).toBe(false);
    expect(isGivenInPartOf(`${TEXT} ${MARK}`, TEXT)).toBe(false);
    expect(isGivenInPartOf(`${MARK}${TEXT}`, TEXT)).toBe(false);
  });

  it("refuses the text as it stands, even where it holds a mark itself", () => {
    const marked = `Quote: ${MARK} the rest`;
    expect(isGivenInPartOf(marked, marked)).toBe(false);
  });

  it("reads a line break the same whatever it was written with", () => {
    const written = "First line names 1102.\r\nSecond line is the noise.";
    expect(
      isGivenInPartOf(`First line ${MARK}\nSecond line is the noise.`, written),
    ).toBe(true);
    expect(
      isGivenInPartOf(
        `First line ${MARK} Second line\n  is the noise.`,
        written,
      ),
    ).toBe(true);
  });
});

describe("issueAccessPartHasId", () => {
  it("names a message, a note and a work order by identifier, and nothing else", () => {
    expect(ISSUE_ACCESS_PARTS.filter(issueAccessPartHasId)).toEqual([
      "MESSAGE",
      "NOTE",
      "WORK_ORDER",
    ]);
  });
});
