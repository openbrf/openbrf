/**
 * How the ADR number check reads file names and when it refuses.
 *
 * Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { duplicateNumbers } from "./check-adr-numbers.mjs";

test("records with numbers of their own are not refused", () => {
  assert.deepEqual(
    duplicateNumbers([
      "0001-linting-and-formatting.md",
      "0002-field-encryption-and-blind-indexes.md",
      "0044-a-listing-released-from-a-repository-without-its-source.md",
    ]),
    [],
  );
});

test("a gap in the numbers is not a duplicate", () => {
  assert.deepEqual(
    duplicateNumbers(["0021-the-management-api.md", "0023-claiming.md"]),
    [],
  );
});

test("two records with one number are refused, both named", () => {
  const failures = duplicateNumbers([
    "0029-reports-to-the-register.md",
    "0030-plugins-that-extend-plugins.md",
    "0029-a-debiting-list.md",
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^ADR 0029 /);
  assert.ok(failures[0].includes("0029-a-debiting-list.md"));
  assert.ok(failures[0].includes("0029-reports-to-the-register.md"));
  assert.ok(!failures[0].includes("0030"));
});

test("every number that is shared is reported, in order", () => {
  const failures = duplicateNumbers([
    "0030-b.md",
    "0030-a.md",
    "0029-b.md",
    "0029-a.md",
  ]);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^ADR 0029 /);
  assert.match(failures[1], /^ADR 0030 /);
});

test("three records with one number are named in one sentence", () => {
  const failures = duplicateNumbers(["0007-a.md", "0007-b.md", "0007-c.md"]);
  assert.equal(failures.length, 1);
  for (const name of ["0007-a.md", "0007-b.md", "0007-c.md"]) {
    assert.ok(failures[0].includes(name));
  }
});

test("a file that does not start with four digits and a hyphen is left alone", () => {
  assert.deepEqual(
    duplicateNumbers(["README.md", "template.md", "00290-a.md", "029-a.md"]),
    [],
  );
});
