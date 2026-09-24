import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { parseSync } from "@swc/core";

/**
 * What every file the server runs does with granted erasure requests, read from
 * the source rather than from a list somebody keeps.
 *
 * A granted erasure request (GDPR art. 17) is carried out by several jobs and
 * closed by one of them, and two rules hold the arrangement together. Every job
 * that reads the request runs before the job that closes it, which is
 * `retention/erasure-request-order.spec.ts`. Every job that erases a person's
 * rows on the request is registered in `retention/erasure-domains.ts`, so the
 * closing job can verify the rows are gone before it records the erasure as
 * carried out, which is `retention/erasure-domains.spec.ts`.
 *
 * Both rules need the same answer to the same question - which files are those
 * jobs - and neither may take it from a list, because a list is the thing that
 * gets forgotten. So the answer is computed here, once, by walking the source.
 *
 * A file reads granted erasure requests when it calls `erasureRequestedPersonIds`
 * or asks for an erasure request that has not been executed; it marks one
 * executed when it writes `executedAt` on a data subject request; and it is
 * placed in the night by the schedule it registers itself.
 *
 * Read from the syntax tree rather than from the text, so a comment about a
 * request is not a finding and a query spread over several lines is not missed.
 *
 * This file lives under `src/testing`, which the walk below skips along with
 * the generated client: a helper that describes the rule is not one of the jobs
 * the rule is about.
 */

/**
 * Where the walk starts.
 *
 * Resolved from the package root rather than from this file's own location: the
 * API builds to CommonJS, where import.meta is not available. Each spec asserts
 * that the walk found a tree with the jobs in it, which is what makes a wrong
 * path fail rather than pass having found nothing.
 */
export const API_SOURCE_DIRECTORY = join(process.cwd(), "src");

/** The selector every purge calls to learn who has been granted erasure. */
const ERASURE_SELECTOR = "erasureRequestedPersonIds";

/** The Prisma methods that write a row, and so can mark a request executed. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/** One `jobs.schedule(queue, cron, data)` call, with its cron if it resolves. */
export interface Schedule {
  cron: string | undefined;
}

/** What one production file does with granted erasure requests. */
export interface SourceFacts {
  /** Relative to src, with forward slashes. */
  path: string;
  readsGrantedErasure: boolean;
  marksRequestExecuted: boolean;
  schedules: Schedule[];
}

type SyntaxNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Every node under a value, the value itself included. */
function* nodesIn(value: unknown): Generator<SyntaxNode> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* nodesIn(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (isNode(value)) {
    yield value;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "span") {
      yield* nodesIn(child);
    }
  }
}

/** An expression without the casts and parentheses around it. */
function unwrapped(node: unknown): unknown {
  let current = node;
  while (
    isNode(current) &&
    [
      "ParenthesisExpression",
      "TsAsExpression",
      "TsConstAssertion",
      "TsNonNullExpression",
      "TsSatisfiesExpression",
      "TsTypeAssertion",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

/** The name an identifier or a string key spells, if it spells one. */
function nameOf(node: unknown): string | undefined {
  if (
    isNode(node) &&
    (node.type === "Identifier" || node.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  return undefined;
}

/** The text of a string literal, or of a template literal with no holes in it. */
function stringValue(node: unknown): string | undefined {
  const expression = unwrapped(node);
  if (!isNode(expression)) {
    return undefined;
  }
  if (expression.type === "StringLiteral") {
    return typeof expression.value === "string" ? expression.value : undefined;
  }
  if (
    expression.type === "TemplateLiteral" &&
    Array.isArray(expression.expressions) &&
    expression.expressions.length === 0 &&
    Array.isArray(expression.quasis)
  ) {
    const [only] = expression.quasis as unknown[];
    if (isNode(only) && typeof only.cooked === "string") {
      return only.cooked;
    }
  }
  return undefined;
}

/** The `key: value` pairs an object literal spells out. */
function propertiesOf(node: SyntaxNode): Map<string, unknown> {
  const properties = new Map<string, unknown>();
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return properties;
  }
  for (const property of node.properties as unknown[]) {
    if (isNode(property) && property.type === "KeyValueProperty") {
      const key = nameOf(property.key);
      if (key !== undefined) {
        properties.set(key, property.value);
      }
    }
  }
  return properties;
}

/** The method a call names, when its callee is `something.method`. */
function calledMethod(call: SyntaxNode): string | undefined {
  const callee = unwrapped(call.callee);
  if (isNode(callee) && callee.type === "MemberExpression") {
    return nameOf(callee.property);
  }
  return undefined;
}

/** The expressions a call passes, in order. */
function argumentsOf(call: SyntaxNode): unknown[] {
  if (!Array.isArray(call.arguments)) {
    return [];
  }
  return (call.arguments as unknown[]).map((argument) =>
    typeof argument === "object" && argument !== null
      ? (argument as { expression?: unknown }).expression
      : undefined,
  );
}

/** A call of the selector, bare or through an object. */
function callsSelector(call: SyntaxNode): boolean {
  const callee = unwrapped(call.callee);
  return (
    nameOf(callee) === ERASURE_SELECTOR ||
    calledMethod(call) === ERASURE_SELECTOR
  );
}

/** An object asking for an erasure request that has not been executed. */
function asksForOpenErasure(node: SyntaxNode): boolean {
  const properties = propertiesOf(node);
  const executedAt = unwrapped(properties.get("executedAt"));
  return (
    stringValue(properties.get("kind")) === "ERASURE" &&
    isNode(executedAt) &&
    executedAt.type === "NullLiteral"
  );
}

/**
 * A write to a data subject request that sets `executedAt` to something.
 *
 * Only what the write stores is read - its `data`, or an upsert's `create` and
 * `update` - so a `where` asking for an unexecuted row is not mistaken for one.
 */
function marksExecuted(call: SyntaxNode): boolean {
  const method = calledMethod(call);
  if (
    method === undefined ||
    !WRITE_METHODS.has(method) ||
    !isDataSubjectRequestDelegate(unwrapped(call.callee))
  ) {
    return false;
  }

  const [first] = argumentsOf(call);
  const argument = unwrapped(first);
  if (!isNode(argument)) {
    return false;
  }
  const properties = propertiesOf(argument);
  for (const stored of ["data", "create", "update"]) {
    for (const node of nodesIn(properties.get(stored))) {
      const executedAt = unwrapped(propertiesOf(node).get("executedAt"));
      if (
        isNode(executedAt) &&
        executedAt.type !== "NullLiteral" &&
        executedAt.type !== "BooleanLiteral"
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Whether a callee is a method on `<client>.dataSubjectRequest`. */
function isDataSubjectRequestDelegate(callee: unknown): boolean {
  if (!isNode(callee) || callee.type !== "MemberExpression") {
    return false;
  }
  const delegate = unwrapped(callee.object);
  return (
    isNode(delegate) &&
    delegate.type === "MemberExpression" &&
    nameOf(delegate.property) === "dataSubjectRequest"
  );
}

/** The string every `const NAME = "..."` in a file holds, by name. */
function stringConstants(module: unknown): Map<string, string | undefined> {
  const constants = new Map<string, string | undefined>();
  for (const node of nodesIn(module)) {
    if (node.type !== "VariableDeclarator") {
      continue;
    }
    const name = nameOf(node.id);
    if (name === undefined) {
      continue;
    }
    const value = stringValue(node.init);
    // Declared twice with different values is ambiguous, and an ambiguous
    // schedule is one this test refuses to place.
    constants.set(
      name,
      constants.has(name) && constants.get(name) !== value ? undefined : value,
    );
  }
  return constants;
}

/** The cron a schedule call passes, if it is a literal or a local constant. */
function cronOf(
  expression: unknown,
  constants: Map<string, string | undefined>,
): string | undefined {
  const literal = stringValue(expression);
  if (literal !== undefined) {
    return literal;
  }
  const name = nameOf(unwrapped(expression));
  return name === undefined ? undefined : constants.get(name);
}

function factsOf(path: string, source: string): SourceFacts {
  const module = parseSync(source, {
    syntax: "typescript",
    tsx: path.endsWith(".tsx"),
    decorators: true,
  });
  const constants = stringConstants(module);

  const facts: SourceFacts = {
    path,
    readsGrantedErasure: false,
    marksRequestExecuted: false,
    schedules: [],
  };
  for (const node of nodesIn(module)) {
    if (node.type === "ObjectExpression" && asksForOpenErasure(node)) {
      facts.readsGrantedErasure = true;
    }
    if (node.type !== "CallExpression") {
      continue;
    }
    if (callsSelector(node)) {
      facts.readsGrantedErasure = true;
    }
    if (marksExecuted(node)) {
      facts.marksRequestExecuted = true;
    }
    const args = argumentsOf(node);
    if (calledMethod(node) === "schedule" && args.length >= 2) {
      facts.schedules.push({ cron: cronOf(args[1], constants) });
    }
  }
  return facts;
}

/** Every file the server runs, however deep it sits. */
function productionSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["generated", "node_modules", "testing"].includes(entry.name)) {
        found.push(...productionSources(path));
      }
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(spec|int-spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * What every file the server runs does with granted erasure requests.
 *
 * Walked once per spec run. The tree is a few hundred small files and parsing
 * it takes less time than a single database round trip, so neither spec caches
 * an answer that could go stale against an edit made while the suite ran.
 */
export function erasureSourceFacts(
  directory: string = API_SOURCE_DIRECTORY,
): SourceFacts[] {
  return productionSources(directory).map((path) =>
    factsOf(
      relative(directory, path).split(sep).join("/"),
      readFileSync(path, "utf8"),
    ),
  );
}
