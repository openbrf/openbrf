import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { erasureSourceFacts } from "./erasure-source-facts";
import {
  registryCoverageProblems,
  unexplainedNoProcessing,
} from "./mail-template-checks";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function declaredIn(source: string): { path: string; id: string | null }[] {
  const directory = mkdtempSync(join(tmpdir(), "mail-template-"));
  directories.push(directory);
  writeFileSync(join(directory, "template.ts"), source);
  return erasureSourceFacts(directory).flatMap((file) =>
    file.mailTemplateIds.map((id) => ({ path: file.path, id })),
  );
}

function idsIn(source: string): (string | null)[] {
  return declaredIn(source).map((template) => template.id);
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

  it("fails the registry check for a discovered template that is not registered", () => {
    const declared = declaredIn(
      `export const a = { id: "extra", processing: null, subject: other.subject, body: other.body };`,
    );

    expect(registryCoverageProblems(declared, [{ id: "other" }])).toEqual([
      "template.ts declares extra, which the registry does not reach",
      "other is registered and declared nowhere in the source",
    ]);
    expect(registryCoverageProblems(declared, [{ id: "extra" }])).toEqual([]);
  });

  it("fails the registry check for a discovered template whose id is not a literal", () => {
    const declared = declaredIn(
      `const id = "x"; export const a = { id, subject: o.subject, body: o.body };`,
    );

    expect(registryCoverageProblems(declared, [{ id: "x" }])).toContain(
      "template.ts declares a mail template whose id is not a literal",
    );
  });

  it("fails the exception check for a template with no processing that is not on the list", () => {
    const registered = [
      { id: "extra", processing: null },
      { id: "listed", processing: null },
      { id: "sent", processing: "newsMailings" },
    ];

    expect(unexplainedNoProcessing(registered, { listed: "why" })).toEqual([
      "extra declares no processing and is not one of the mails sent on none",
    ]);
    expect(
      unexplainedNoProcessing(registered, { extra: "why", listed: "why" }),
    ).toEqual([]);
  });
});
