import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { erasureSourceFacts } from "./erasure-source-facts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function idsIn(source: string): (string | null)[] {
  const directory = mkdtempSync(join(tmpdir(), "mail-template-"));
  directories.push(directory);
  writeFileSync(join(directory, "template.ts"), source);
  return erasureSourceFacts(directory).flatMap((file) => file.mailTemplateIds);
}

describe("discovering mail templates", () => {
  it("finds a template whose functions are written in place", () => {
    expect(
      idsIn(
        `export const a = { id: "a", subject: () => "s", body() { return "b"; } };`,
      ),
    ).toEqual(["a"]);
  });

  it("finds a template whose functions are references", () => {
    expect(
      idsIn(
        `export const a = { id: "extra", processing: null, subject: other.subject, body: other.body };`,
      ),
    ).toEqual(["extra"]);
  });

  it("finds a template whose functions are shorthand", () => {
    expect(
      idsIn(`const subject = () => "s"; const body = () => "b";
export const a = { id: "short", subject, body };`),
    ).toEqual(["short"]);
  });

  it("lists an id that is not a literal as null, failing closed", () => {
    expect(
      idsIn(
        `const id = "x"; export const a = { id, subject: o.subject, body: o.body };`,
      ),
    ).toEqual([null]);
  });

  it("does not take a select of the same names for a template", () => {
    expect(
      idsIn(
        `export const q = { select: { id: true, subject: true, body: true } };`,
      ),
    ).toEqual([]);
  });
});
