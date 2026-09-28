import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "../generated/prisma/client";

/**
 * Which columns in the schema name a person, read from the schema rather than
 * from a list somebody keeps.
 *
 * The data subject access report (registerutdrag, GDPR art. 15) is held to the
 * record of processing activities section by section, by a map the compiler
 * enumerates. That map cannot say whether a table holding rows about a person
 * has a section at all: which columns name a person is a fact only the schema
 * states. So the question is answered here, by a walk, and
 * `retention/data-subject-report-coverage.spec.ts` holds every answer to a
 * section that reads the column or to the reason none does.
 *
 * ## The rule
 *
 * A column names a person when it is called `personId`, `userId` or
 * `emailIndex`, or ends in `PersonId`, `ById` or `EmailIndex`, or is the key of
 * a relation to `Person` or `User`. The first half is applied to the scalar
 * fields of every model the generated client declares; the second to the
 * schema text, so a foreign key to either model is found whatever it is called.
 *
 * The rule is the guard's limit, and stated as one. A column naming a person
 * under another name and without a relation passes unseen, and so does data
 * keyed by a value rather than by a column - the verification rows the sign-in
 * library keeps by address, and the rows of an import before the apply writes
 * the register.
 *
 * This file lives under `src/testing`, like `erasure-source-facts.ts`: a helper
 * that describes a rule is not one of the files the rule is about.
 */

/**
 * The scalar columns of every model, by model.
 *
 * Read off the generated client's `<Model>ScalarFieldEnum` objects, which the
 * namespace declares for every model. The conditional is what lets the compiler
 * index the namespace with a template literal; a model without such an object
 * would have no columns here, and the spec over this file would say so.
 */
export type ColumnsOf = {
  [M in Prisma.ModelName]: `${M}ScalarFieldEnum` extends keyof typeof Prisma
    ? keyof (typeof Prisma)[`${M}ScalarFieldEnum`]
    : never;
};

/**
 * The schema the walk reads.
 *
 * Resolved from the package root rather than from this file's own location, as
 * `API_SOURCE_DIRECTORY` is: the API builds to CommonJS, where import.meta is
 * not available.
 */
export const SCHEMA_FILE = join(process.cwd(), "prisma", "schema.prisma");

/** Whether a column's name says that it names a person. */
function namesAPerson(column: string): boolean {
  return (
    column === "personId" ||
    column === "userId" ||
    column === "emailIndex" ||
    column.endsWith("PersonId") ||
    column.endsWith("ById") ||
    column.endsWith("EmailIndex")
  );
}

/** Every `<Model>.<column>` the naming rule matches on the generated client. */
function namedColumns(): string[] {
  const namespace = Prisma as unknown as Record<string, unknown>;
  return Object.values(Prisma.ModelName).flatMap((model) => {
    const fields = namespace[`${model}ScalarFieldEnum`];
    if (typeof fields !== "object" || fields === null) {
      throw new Error(
        `The generated client declares no ${model}ScalarFieldEnum, so the ` +
          "walk of person columns cannot read that model.",
      );
    }
    return Object.keys(fields)
      .filter(namesAPerson)
      .map((column) => `${model}.${column}`);
  });
}

/**
 * Every `<Model>.<key>` that is the key of a relation to `Person` or `User`.
 *
 * Read from the schema text line by line: a relation field is one line, and the
 * model it sits in is the last `model` block opened above it.
 */
function relationKeys(schema: string): string[] {
  const keys: string[] = [];
  let model: string | undefined;
  for (const line of schema.split("\n")) {
    const opened = /^model\s+(\w+)\s*\{/.exec(line);
    if (opened !== null) {
      model = opened[1];
      continue;
    }
    if (line.startsWith("}")) {
      model = undefined;
      continue;
    }
    if (model === undefined) {
      continue;
    }
    const relation = /^\s*\w+\s+(?:Person|User)\??\s.*@relation\(/.exec(line);
    const fields = /fields:\s*\[([^\]]*)\]/.exec(line);
    if (relation === null || fields === null) {
      continue;
    }
    for (const key of (fields[1] ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed !== "") {
        keys.push(`${model}.${trimmed}`);
      }
    }
  }
  return keys;
}

/**
 * Every column in the schema that names a person, as `<Model>.<column>`,
 * sorted.
 *
 * @param schema The schema text, read from {@link SCHEMA_FILE} unless given.
 */
export function personColumns(
  schema: string = readFileSync(SCHEMA_FILE, "utf8"),
): string[] {
  return [...new Set([...namedColumns(), ...relationKeys(schema)])].toSorted();
}
