import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_ACCESS_LEFT_OUT_MARK as MARK,
  isGivenInPartOf,
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
  });
});
