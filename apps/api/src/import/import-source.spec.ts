import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { contentDigestOf, savedMapping, sourceKeyOf } from "./import-source";

/**
 * How a file is recognised as one the board has imported from before, and as
 * the very rows it imported last time.
 */

const encryption = new FieldEncryptionService({
  NODE_ENV: "test",
  OPENBRF_ENCRYPTION_KEY: "c".repeat(64),
} as Env);

describe("the key a source is recognised by", () => {
  const keyOf = (columns: readonly string[]) =>
    sourceKeyOf(encryption, columns);

  it("is the same for titles that differ only in case and surrounding space", async () => {
    expect(await keyOf(["Lägenhet", " Namn ", "E-post"])).toBe(
      await keyOf(["lägenhet", "namn", "E-POST"]),
    );
  });

  it("is the same for a title written with a combining accent", async () => {
    expect(await keyOf(["Lägenhet"])).toBe(await keyOf(["Lägenhet"]));
  });

  it("differs when the columns have moved", async () => {
    expect(await keyOf(["Namn", "Lägenhet"])).not.toBe(
      await keyOf(["Lägenhet", "Namn"]),
    );
  });

  it("differs when a column has been added", async () => {
    expect(await keyOf(["Namn", "Lägenhet"])).not.toBe(
      await keyOf(["Namn", "Lägenhet", "Telefon"]),
    );
  });

  it("does not run two titles together", async () => {
    expect(await keyOf(["ab", "c"])).not.toBe(await keyOf(["a", "bc"]));
  });

  it("confirms no guess at a first row without the instance's key", async () => {
    /*
     * A file saved without a header row: its first row, taken as the titles,
     * is a member's. Name and apartment known, the identity number's last four
     * digits not, and hashing every candidate the way the key is taken, but
     * without the instance's key, finds nothing.
     */
    const row = (suffix: string) => [
      "Anna Lindqvist",
      "1101",
      `19800101-${suffix}`,
    ];
    const stored = await keyOf(row("1234"));

    const found = Array.from({ length: 10_000 }, (_, n) =>
      String(n).padStart(4, "0"),
    ).filter(
      (suffix) =>
        createHash("sha256")
          .update(JSON.stringify(row(suffix).map((cell) => cell.toLowerCase())))
          .digest("hex") === stored,
    );

    expect(found).toEqual([]);
    expect(stored).not.toBe(
      await sourceKeyOf(
        new FieldEncryptionService({
          NODE_ENV: "test",
          OPENBRF_ENCRYPTION_KEY: "b".repeat(64),
        } as Env),
        row("1234"),
      ),
    );
  });

  it("is not the content digest of the same text", async () => {
    // A key of its own, so a source key cannot be matched against the digest
    // of a file that holds only its first row.
    expect(await keyOf(["namn"])).not.toBe(
      await contentDigestOf(encryption, [["namn"]]),
    );
    expect(await keyOf(["namn"])).not.toBe(
      await encryption.importContentDigest(JSON.stringify(["namn"])),
    );
  });
});

describe("the digest of a file's rows", () => {
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
