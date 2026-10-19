import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { contentDigestOf, savedMapping, sourceKeyOf } from "./import-source";

/**
 * How a file is recognised as one the board has imported from before, and as
 * the very rows it imported last time.
 */

describe("the key a source is recognised by", () => {
  it("is the same for titles that differ only in case and surrounding space", () => {
    expect(sourceKeyOf(["Lägenhet", " Namn ", "E-post"])).toBe(
      sourceKeyOf(["lägenhet", "namn", "E-POST"]),
    );
  });

  it("is the same for a title written with a combining accent", () => {
    expect(sourceKeyOf(["Lägenhet"])).toBe(sourceKeyOf(["Lägenhet"]));
  });

  it("differs when the columns have moved", () => {
    expect(sourceKeyOf(["Namn", "Lägenhet"])).not.toBe(
      sourceKeyOf(["Lägenhet", "Namn"]),
    );
  });

  it("differs when a column has been added", () => {
    expect(sourceKeyOf(["Namn", "Lägenhet"])).not.toBe(
      sourceKeyOf(["Namn", "Lägenhet", "Telefon"]),
    );
  });

  it("does not run two titles together", () => {
    expect(sourceKeyOf(["ab", "c"])).not.toBe(sourceKeyOf(["a", "bc"]));
  });
});

describe("the digest of a file's rows", () => {
  const encryption = new FieldEncryptionService({
    NODE_ENV: "test",
    OPENBRF_ENCRYPTION_KEY: "c".repeat(64),
  } as Env);

  it("is the same for the same rows", async () => {
    expect(await contentDigestOf(encryption, [["Namn"], ["Anna"]])).toBe(
      await contentDigestOf(encryption, [["Namn"], ["Anna"]]),
    );
  });

  it("changes with one cell", async () => {
    expect(await contentDigestOf(encryption, [["Namn"], ["Anna"]])).not.toBe(
      await contentDigestOf(encryption, [["Namn"], ["Anne"]]),
    );
  });

  it("does not run two cells together", async () => {
    expect(await contentDigestOf(encryption, [["ab", "c"]])).not.toBe(
      await contentDigestOf(encryption, [["a", "bc"]]),
    );
  });

  it("confirms no guess at a cell without the instance's key", async () => {
    /*
     * The one-row file a database reader could otherwise sweep: titles, name
     * and apartment known, the identity number's last four digits not. Hashing
     * every candidate the way the digest is taken, but without the key, finds
     * nothing.
     */
    const rows = (suffix: string) => [
      ["Namn", "Lägenhet", "Personnummer"],
      ["Anna Lindqvist", "1101", `19800101-${suffix}`],
    ];
    const stored = await contentDigestOf(encryption, rows("1234"));

    const found = Array.from({ length: 10_000 }, (_, n) =>
      String(n).padStart(4, "0"),
    ).filter(
      (suffix) =>
        createHash("sha256")
          .update(JSON.stringify(rows(suffix)))
          .digest("hex") === stored,
    );

    expect(found).toEqual([]);
  });
});

describe("the mapping offered for a source", () => {
  const source = {
    mapping: ["apartmentNumber", "", "fullName"],
    defaultRole: "MEMBER" as const,
    defaultMovedInOn: "2020-01-01",
    mappingSavedAt: new Date("2026-10-01T10:00:00.000Z"),
  };

  it("is the one saved, column by column", () => {
    expect(savedMapping(source, 3)).toEqual({
      mapping: ["apartmentNumber", null, "fullName"],
      defaultRole: "MEMBER",
      defaultMovedInOn: "2020-01-01",
      mappingSavedAt: "2026-10-01T10:00:00.000Z",
    });
  });

  it("is none the first time", () => {
    expect(savedMapping(null, 3)).toBeNull();
  });

  it("is none when it does not fit the file", () => {
    expect(savedMapping(source, 4)).toBeNull();
  });
});
