import { z } from "zod";

import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * An action's schemas, as the JSON Schema a caller is published.
 *
 * The only call to `z.toJSONSchema` in the product. Every option here is set
 * against a failure that would otherwise be silent, so they are worth reading
 * one at a time.
 *
 * `io: "input"` because output mode makes a key with a default REQUIRED, and a
 * model reading that will dutifully supply a value for every field the platform
 * was perfectly happy to choose itself.
 *
 * `cycles: "throw"` because a self-referential schema has no JSON Schema
 * without `$ref`, and a silently emitted `$ref` to a positional name is worse
 * than a refusal at registration.
 *
 * `reused: "inline"` because `$defs` invents names from the position a schema
 * happens to hold, and those names would reach a committed artefact and a
 * third-party client. Inlining costs bytes and keeps the document stable.
 *
 * The function form of `unrepresentable` because the default error names
 * neither the action nor the path, and a build failing with "unrepresentable
 * type" and nothing else is a half hour of searching.
 *
 * One property is worth stating because it is NOT what one would assume: a bare
 * `.transform()` does not throw under input mode - it is erased and the
 * pre-transform type is emitted. The guarantee is placed where it is real, on
 * the output helper, which does throw. So an action whose pair is converted at
 * registration cannot carry a transform anywhere.
 *
 * `.refine()`, `.check()`, `.superRefine()` and `.brand()` are erased with no
 * marker under both modes. That is why the rule for a published schema is
 * structural constraints first: what the document says has to be at least as
 * strict as what the runtime enforces, or a caller is told a value is
 * acceptable that the service will refuse.
 */

/** Refuses a schema built with a second copy of zod, whose internals differ. */
export function isHostZodSchema(schema: unknown): schema is z.ZodType {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "_zod" in schema &&
    (schema as { _zod?: unknown })._zod !== undefined
  );
}

function convert(
  schema: unknown,
  actionName: string,
  io: "input" | "output",
): Record<string, unknown> {
  if (!isHostZodSchema(schema)) {
    throw new Error(
      `${actionName}: an action schema must be built with the host's zod.`,
    );
  }
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    cycles: "throw",
    reused: "inline",
    unrepresentable: ({ path, message }) => {
      throw new Error(
        `${actionName}: ${message} at ${[io, ...path.map(String)].join(".")}`,
      );
    },
  }) as Record<string, unknown>;
}

export function actionInputJsonSchema(
  schema: StandardSchemaV1<unknown, unknown>,
  actionName: string,
): Record<string, unknown> {
  return convert(schema, actionName, "input");
}

export function actionOutputJsonSchema(
  schema: StandardSchemaV1<unknown, unknown>,
  actionName: string,
): Record<string, unknown> {
  return convert(schema, actionName, "output");
}
