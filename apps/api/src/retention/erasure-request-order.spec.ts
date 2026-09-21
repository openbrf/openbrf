import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { parseSync } from "@swc/core";
import { describe, expect, it } from "vitest";

/**
 * The order of the night against a granted erasure request, as a test.
 *
 * A granted erasure request (GDPR art. 17) brings every purge that reads it
 * forward for one person, and the service-data purge is the job that marks the
 * request executed and closes it. A purge that looks for the request after that
 * finds nothing open: it does not select the person, and their rows wait out
 * their own retention window while the request says it was carried out. So
 * every scheduled job that reads granted erasure requests runs strictly before
 * the job that closes them.
 *
 * Nothing here lists those jobs. A file reads granted erasure requests when it
 * calls `erasureRequestedPersonIds`, or asks for an erasure request that has not
 * been executed; it marks one executed when it writes `executedAt` on a data
 * subject request. Each such file is found by walking the source, and placed in
 * the night by the schedule it registers itself. A purge written later is held
 * to the order by the same walk, whether or not it is named anywhere.
 *
 * Read from the syntax tree rather than from the text, so a comment about a
 * request is not a finding and a query spread over several lines is not missed.
 */

/*
 * Resolved from the package root rather than from this file's own location:
 * the API builds to CommonJS, where import.meta is not available. The first
 * assertion below is what makes a wrong path fail rather than check nothing.
 */
const SOURCE_DIRECTORY = join(process.cwd(), "src");

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

/**
 * Files that read granted erasure requests on a request path rather than at a
 * time of night, and why each one may.
 *
 * Checked in both directions. A file named here that no longer reads the
 * requests, or that has started registering a schedule, is an error: an entry
 * nothing uses is one the next edit to that file inherits without anybody
 * deciding to give it.
 */
const UNSCHEDULED_READERS = new Map([
  [
    "retention/withheld-persons.ts",
    "Defines the selector. It runs inside whichever job calls it, and that " +
      "job's own file is what this test places in the night.",
  ],
  [
    "data-protection/data-subject-request.service.ts",
    "Closes a granted request when the person moves in again, inside the " +
      "move-in's own transaction. A request closed there stops being an " +
      "instruction to every purge at once, so none is left behind by it.",
  ],
]);

/** One `jobs.schedule(queue, cron, data)` call, with its cron if it resolves. */
interface Schedule {
  cron: string | undefined;
}

/** What one production file does with granted erasure requests. */
interface SourceFacts {
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
 * The minute of the day a cron runs at, when it runs once a day at a fixed one.
 *
 * Every schedule goes through `JobQueueService.schedule`, which names no time
 * zone, so every cron here is read on the same clock and two of them compare
 * directly. A schedule of any other shape cannot be placed before or after a
 * minute, and is refused rather than guessed at.
 */
function minuteOfDay(cron: string): number | undefined {
  const match = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron);
  if (match === null) {
    return undefined;
  }
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  return minute > 59 || hour > 23 ? undefined : hour * 60 + minute;
}

function clock(minuteOfTheDay: number): string {
  const hours = String(Math.floor(minuteOfTheDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfTheDay % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const facts = productionSources(SOURCE_DIRECTORY).map((path) =>
  factsOf(
    relative(SOURCE_DIRECTORY, path).split(sep).join("/"),
    readFileSync(path, "utf8"),
  ),
);

/** Scheduled jobs that mark a request executed, which closes it. */
const closers = facts.filter(
  (file) => file.marksRequestExecuted && file.schedules.length > 0,
);

/** Scheduled jobs that read granted requests, the closing ones included. */
const readers = facts.filter(
  (file) => file.readsGrantedErasure && file.schedules.length > 0,
);

describe("the night's order against a granted erasure request", () => {
  it("is asserted over a source tree with a closing job and a reader in it", () => {
    // Without this, a moved directory or a renamed selector would turn every
    // assertion below into one that passes because it found nothing to order.
    expect(facts.length).toBeGreaterThan(100);
    expect(closers.map((file) => file.path)).not.toEqual([]);
    expect(
      readers
        .filter((file) => !file.marksRequestExecuted)
        .map((file) => file.path),
    ).not.toEqual([]);
  });

  it("marks a request executed only from a scheduled job", () => {
    // Anywhere else, the request would be closed at whatever moment somebody
    // acted, before every purge that reads it had run.
    const offenders = facts
      .filter(
        (file) => file.marksRequestExecuted && file.schedules.length === 0,
      )
      .map(
        (file) =>
          `${file.path} marks an erasure request executed and registers no ` +
          "schedule, so it can close the request before the purges that read it",
      );

    expect(offenders).toEqual([]);
  });

  it("runs every job that reads a granted request strictly before the job that closes it", () => {
    const offenders: string[] = [];
    const placed = (
      file: SourceFacts,
    ): { minute: number | undefined; cron: string | undefined }[] =>
      file.schedules.map(({ cron }) => ({
        cron,
        minute: cron === undefined ? undefined : minuteOfDay(cron),
      }));

    /*
     * The earliest closing job is the one every reader has to beat. A second
     * job that also closes requests reads them too, so it is held to the same
     * minute as every other reader and fails if it runs after the first.
     */
    let closing: { minute: number; path: string } | undefined;
    for (const closer of closers) {
      for (const { cron, minute } of placed(closer)) {
        if (minute === undefined) {
          offenders.push(
            `${closer.path} closes erasure requests on a schedule this test ` +
              `cannot place in the night: ${String(cron)}`,
          );
        } else if (closing === undefined || minute < closing.minute) {
          closing = { minute, path: closer.path };
        }
      }
    }

    for (const reader of readers) {
      if (closing === undefined || reader.path === closing.path) {
        continue;
      }
      for (const { cron, minute } of placed(reader)) {
        if (minute === undefined) {
          offenders.push(
            `${reader.path} reads granted erasure requests on a schedule this ` +
              `test cannot place in the night: ${String(cron)}. It places a ` +
              "cron that runs once a day at a fixed minute, passed as a literal " +
              "or as a constant declared in the same file",
          );
        } else if (minute >= closing.minute) {
          offenders.push(
            `${reader.path} reads granted erasure requests at ${clock(minute)}, ` +
              `which is not before ${clock(closing.minute)}, when ` +
              `${closing.path} marks them executed and closes them`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("places every reader of granted requests in the night, or names why it is not there", () => {
    const offenders = facts
      .filter(
        (file) =>
          file.readsGrantedErasure &&
          file.schedules.length === 0 &&
          !UNSCHEDULED_READERS.has(file.path),
      )
      .map(
        (file) =>
          `${file.path} reads granted erasure requests and registers no ` +
          "schedule, so nothing here can place it before the job that closes " +
          "them: schedule the job in this file, or name the file among the " +
          "unscheduled readers with the reason it reads them outside the night",
      );

    expect(offenders).toEqual([]);
  });

  it("names no unscheduled reader that has stopped being one", () => {
    const stale: string[] = [];
    for (const path of UNSCHEDULED_READERS.keys()) {
      const file = facts.find((candidate) => candidate.path === path);
      if (file === undefined) {
        stale.push(`${path} no longer exists`);
      } else if (!file.readsGrantedErasure) {
        stale.push(`${path} no longer reads granted erasure requests`);
      } else if (file.schedules.length > 0) {
        stale.push(
          `${path} registers a schedule, so it is placed like a purge`,
        );
      }
    }

    expect(stale).toEqual([]);
  });
});
