import { describe, expect, it } from "vitest";

import { CatalogError, parseCatalog } from "./catalog-entry";

/**
 * The instance's side of the index schema, which the SDK owns and tests.
 *
 * What is left to prove here is the wrapper: a refused index becomes the one
 * error the install screens and the command-line tool turn into a reason, and
 * the operator reading the log is told where in the file the problem is.
 */

const DIGEST = `sha512-${"A".repeat(86)}==`;

function theme(id: string): unknown {
  return {
    type: "theme",
    id,
    version: "1.0.0",
    name: { sv: "Nordisk", en: "Nordic" },
    description: { sv: "Ljust tema", en: "A light theme" },
    artifact: {
      url: "https://catalog.example.test/nordic.tgz",
      sha512: DIGEST,
    },
  };
}

function refusal(input: unknown): CatalogError {
  try {
    parseCatalog(input);
  } catch (error) {
    if (error instanceof CatalogError) {
      return error;
    }
    throw error;
  }
  throw new Error("The index was expected to be refused.");
}

describe("parseCatalog", () => {
  it("returns the parsed index", () => {
    const catalog = parseCatalog({ version: 1, entries: [theme("nordic")] });

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["nordic"]);
  });

  it("refuses an index the schema refuses as malformed", () => {
    expect(refusal({ version: 2, entries: [] }).reason).toBe(
      "catalog-malformed",
    );
  });

  it("names every offending field in the message", () => {
    const error = refusal({
      version: 1,
      entries: [theme("nordic"), theme("nordic"), theme("../escape")],
    });

    expect(error.reason).toBe("catalog-malformed");
    expect(error.message).toMatch(/entries\.2\.id/);
  });

  it("refuses an index that lists one id twice", () => {
    const error = refusal({
      version: 1,
      entries: [theme("nordic"), theme("nordic")],
    });

    expect(error.message).toMatch(/entries\.1\.id: "nordic" is already/);
  });
});
