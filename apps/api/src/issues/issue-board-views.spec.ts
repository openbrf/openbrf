import { dateColumnOf, parseLocalDay } from "@openbrf/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  meaningsInView,
  searchTermsOf,
  unicodeFormsOf,
  viewWhere,
} from "./issue.service";

/**
 * The conditions the board's views of the queue are read and counted by
 * (decision 15). Both the list and the counts go through these, so what they
 * say here is what both say.
 */

describe("the meanings a view covers", () => {
  it("covers every meaning in Mina, Ej tilldelade and Alla, in the queue's order", () => {
    for (const view of ["MINE", "UNASSIGNED", "ALL"] as const) {
      expect(meaningsInView(view, undefined)).toEqual([
        "NEW",
        "IN_PROGRESS",
        "WAITING",
        "DONE",
      ]);
    }
  });

  it("covers only the open meanings in Försenade, whatever the filter", () => {
    expect(meaningsInView("OVERDUE", undefined)).toEqual([
      "NEW",
      "IN_PROGRESS",
      "WAITING",
    ]);
    expect(meaningsInView("OVERDUE", "DONE")).toEqual([]);
  });

  it("narrows to the open meanings, or to one", () => {
    expect(meaningsInView("MINE", "OPEN")).toEqual([
      "NEW",
      "IN_PROGRESS",
      "WAITING",
    ]);
    expect(meaningsInView("ALL", "DONE")).toEqual(["DONE"]);
    expect(meaningsInView("OVERDUE", "WAITING")).toEqual(["WAITING"]);
  });
});

describe("whose issues a view holds", () => {
  const today = parseLocalDay("2026-11-03");
  if (today === null) {
    throw new Error("The fixture's day does not parse.");
  }

  it("holds the reader's in Mina and nobody's in Ej tilldelade", () => {
    expect(viewWhere("MINE", "person-1", today)).toEqual({
      assigneePersonId: "person-1",
    });
    expect(viewWhere("UNASSIGNED", "person-1", today)).toEqual({
      assigneePersonId: null,
    });
    expect(viewWhere("ALL", "person-1", today)).toEqual({});
  });

  it("holds a target date before today in Försenade, never today itself", () => {
    expect(viewWhere("OVERDUE", "person-1", today)).toEqual({
      targetDate: { lt: dateColumnOf(today) },
    });
  });
});

describe("the words of a search", () => {
  it("splits on any white space, each word once", () => {
    expect(searchTermsOf("  läcka\ttak\u00A0läcka  ")).toEqual([
      "läcka",
      "tak",
    ]);
  });

  it("counts two spellings of a word, in different case, as one", () => {
    expect(searchTermsOf("LEAK leak Leak roof wall fire light door")).toEqual([
      "LEAK",
      "roof",
      "wall",
      "fire",
      "light",
      "door",
    ]);
  });

  it("keeps the zero-width joiner and non-joiner", () => {
    expect(searchTermsOf("a\u200Db\u200Cc \u200Bd")).toEqual([
      "a\u200Db\u200Cc",
      "d",
    ]);
  });

  it("is no words when blank", () => {
    expect(searchTermsOf("   ")).toEqual([]);
    expect(searchTermsOf("")).toEqual([]);
  });

  it("drops invisible format characters, inside a word or on their own", () => {
    expect(searchTermsOf("blås\u200Blampa \u200B \uFEFF")).toEqual([
      "blåslampa",
    ]);
  });

  it("composes a letter typed with a combining mark", () => {
    expect(searchTermsOf("la\u0308cka")).toEqual(["läcka"]);
  });

  it("matches a word in both Unicode forms, once when they are the same", () => {
    expect(unicodeFormsOf("läcka")).toEqual(["läcka", "la\u0308cka"]);
    expect(unicodeFormsOf("tak")).toEqual(["tak"]);
  });

  it("reads at most six words of at most a hundred characters", () => {
    expect(searchTermsOf("a b c d e f g h")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(searchTermsOf("x".repeat(150))).toEqual(["x".repeat(100)]);
  });
});
