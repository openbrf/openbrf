import { describe, expect, it } from "vite-plus/test";

import { personIdCandidates } from "./plugin-person-records.service";

const ID = "cmh2x7q0a0000abcd1234efgh";

describe("personIdCandidates", () => {
  it("finds an id in the key, a property name and a string at any depth", () => {
    for (const [key, value] of [
      [ID, {}],
      [`offer:${ID}`, {}],
      ["k", { [ID]: 1 }],
      ["k", { holder: ID }],
      ["k", { notes: [{ by: [`by ${ID}.`] }] }],
    ] as const) {
      expect(personIdCandidates(key, value), JSON.stringify(value)).toContain(
        ID,
      );
    }
  });

  it("finds an id of letters and digits joined to a word with - or _", () => {
    expect(personIdCandidates("k", { a: `holder-${ID}` })).toContain(ID);
    expect(personIdCandidates("k", { a: `holder_${ID}` })).toContain(ID);
  });

  it("keeps an id holding - or _ whole where it is set off", () => {
    expect(personIdCandidates("k", { a: "offer:seed-person-anna." })).toContain(
      "seed-person-anna",
    );
  });

  it("leaves out numbers, runs longer than an id can be, and duplicates", () => {
    const long = "a".repeat(65);
    const found = personIdCandidates("k", { a: 12, b: long, c: [ID, ID] });
    expect(found).not.toContain(long);
    expect(found).not.toContain("12");
    expect(found.filter((candidate) => candidate === ID)).toHaveLength(1);
  });
});
