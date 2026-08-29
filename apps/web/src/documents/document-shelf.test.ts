import { describe, expect, it } from "vitest";

import {
  audienceForBinder,
  fileSizeOf,
  isMinutesBinder,
  shelvesOf,
} from "./document-shelf";
import type { ArchivedDocument } from "./documents-api";

/**
 * The shelf's own rules.
 *
 * The minutes rule is the one that is not layout. Minutes of a general meeting
 * name the members who spoke and how they voted, so the archive puts them with
 * the members and makes publishing one a separate, deliberate answer. These
 * cases are what say that the rule narrows and never widens.
 */

function documentWith(
  fields: Partial<ArchivedDocument> & { id: string },
): ArchivedDocument {
  return {
    title: "Stadgar",
    category: "Stadgar",
    audience: "PUBLIC",
    fileName: "stadgar.pdf",
    contentType: "application/pdf",
    byteSize: 2048,
    url: "/api/media/file-1",
    uploadedAt: "2026-08-29T09:00:00.000Z",
    ...fields,
  };
}

describe("grouping the archive", () => {
  it("keeps the server's order within a binder and between them", () => {
    const shelves = shelvesOf([
      documentWith({ id: "a", category: "Protokoll", title: "Mars" }),
      documentWith({ id: "b", category: "Stadgar" }),
      documentWith({ id: "c", category: "Protokoll", title: "Februari" }),
    ]);

    expect(shelves.map((shelf) => shelf.category)).toEqual([
      "Protokoll",
      "Stadgar",
    ]);
    expect(shelves[0]?.documents.map((entry) => entry.title)).toEqual([
      "Mars",
      "Februari",
    ]);
  });

  it("has nothing to show for an empty archive", () => {
    expect(shelvesOf([])).toEqual([]);
  });
});

describe("the minutes binder", () => {
  it("is recognised in either language the interface ships in", () => {
    expect(isMinutesBinder("Protokoll")).toBe(true);
    expect(isMinutesBinder("  minutes ")).toBe(true);
  });

  it("is not a binder the board named something else", () => {
    expect(isMinutesBinder("Stadgar")).toBe(false);
    expect(isMinutesBinder("Protokollsutdrag")).toBe(false);
  });

  it("takes minutes off the public shelf", () => {
    expect(audienceForBinder("Protokoll", "PUBLIC")).toBe("MEMBER");
  });

  it("leaves an audience that is already narrower alone", () => {
    expect(audienceForBinder("Protokoll", "BOARD")).toBe("BOARD");
    expect(audienceForBinder("Protokoll", "MEMBER")).toBe("MEMBER");
  });

  it("never narrows another binder", () => {
    expect(audienceForBinder("Stadgar", "PUBLIC")).toBe("PUBLIC");
  });
});

describe("describing a file", () => {
  it("names bytes below a kilobyte", () => {
    expect(fileSizeOf(512)).toEqual({ unit: "bytes", size: "512" });
  });

  it("rounds to whole kilobytes", () => {
    expect(fileSizeOf(41_500)).toEqual({ unit: "kilobytes", size: "41" });
  });

  it("keeps one decimal on a megabyte", () => {
    expect(fileSizeOf(3_500_000)).toEqual({ unit: "megabytes", size: "3.3" });
  });
});
