import { describe, expect, it } from "vitest";

import {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
} from "../crypto/personal-data";
import { normalizePhone } from "../crypto/personal-data";
import { runIdentityNumber, runPhone, runSuffix } from "./integration-env";

/**
 * The fixture generators, which are the answer to a collision that cost a
 * green suite.
 *
 * A worker runs several integration suites against one database, and several
 * of them leave a person behind on purpose, because append-only register rows
 * hold them. Contact details carry a blind index that normalizes every
 * spelling to one value, so a fixture written as a literal does not merely
 * duplicate data: it answers a lookup that was about somebody else's row, and
 * it keeps answering it for every suite that follows. Two retention suites and
 * the demo data all held +46701234567, and the seed suite's phone lookup
 * returned whichever came back first.
 *
 * These tests are unit tests on purpose. The property that matters - that a
 * generated value is valid, stable and unlike anything else in the tree - is
 * decidable without a database, and it is the property a future fixture author
 * will rely on without reading the generator.
 */

/** Enough runs to make a shape or range fault certain to show. */
const SEEDS = Array.from({ length: 2000 }, () => runSuffix());

describe("runPhone", () => {
  it("produces a Swedish mobile number in E.164", () => {
    for (const seed of SEEDS) {
      expect(runPhone(seed)).toMatch(/^\+4676\d{7}$/);
    }
  });

  it("stores and indexes as the same string", () => {
    // The suites assert that the report shows the number the fixture wrote, so
    // the written form has to be its own canonical form.
    for (const seed of SEEDS) {
      const phone = runPhone(seed);
      expect(normalizePhone(phone)).toBe(phone);
    }
  });

  it("avoids every number already written in the tree", () => {
    // The demo data's five, and the import suite's fixed one.
    const taken = new Set([
      "+46701234567",
      "+46705551234",
      "+46739876543",
      "+46724567890",
      "+46702345678",
      "+46701110011",
    ]);
    for (const seed of SEEDS) {
      expect(taken.has(runPhone(seed))).toBe(false);
    }
  });

  it("answers the same for one seed and differently for another", () => {
    expect(runPhone("a-run")).toBe(runPhone("a-run"));
    expect(runPhone("a-run")).not.toBe(runPhone("b-run"));
  });
});

describe("runIdentityNumber", () => {
  it("passes the checksum the register validates with", () => {
    for (const seed of SEEDS) {
      expect(isValidPersonalIdentityNumber(runIdentityNumber(seed))).toBe(true);
    }
  });

  it("stores and indexes as the same string", () => {
    for (const seed of SEEDS) {
      const number = runIdentityNumber(seed);
      expect(normalizePersonalIdentityNumber(number)).toBe(number);
    }
  });

  it("belongs to an adult born in the reserved years", () => {
    // The range is what keeps a generated number away from every literal in
    // the repository, so it is asserted rather than left to the comment.
    for (const seed of SEEDS) {
      const year = Number(runIdentityNumber(seed).slice(0, 4));
      expect(year).toBeGreaterThanOrEqual(1940);
      expect(year).toBeLessThanOrEqual(1979);
    }
  });

  it("avoids the numbers the demo data and the other suites hold", () => {
    const reference = new Date("2026-01-01T00:00:00Z");
    const taken = new Set(
      [
        "811228-9874",
        "121212-1212",
        "010101-1005",
        "811228-9875",
        "19850312-4527",
        "19850101-0017",
      ].map((written) => normalizePersonalIdentityNumber(written, reference)),
    );
    for (const seed of SEEDS) {
      expect(taken.has(runIdentityNumber(seed))).toBe(false);
    }
  });

  it("answers the same for one seed and differently for another", () => {
    expect(runIdentityNumber("a-run")).toBe(runIdentityNumber("a-run"));
    expect(runIdentityNumber("a-run")).not.toBe(runIdentityNumber("b-run"));
  });

  it("gives one suite's several people numbers of their own", () => {
    // How the register suite asks for three, and the reason a holder's extract
    // has something it must refuse to show.
    const seed = runSuffix();
    const numbers = ["member", "protected", "former"].map((role) =>
      runIdentityNumber(`${seed}-${role}`),
    );
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
