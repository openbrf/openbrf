import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import {
  actionInputJsonSchema,
  actionOutputJsonSchema,
  EXTENSION_MAX_TIMEOUT_MS,
  EXTENSION_TIMEOUT_MS,
  type ExtensionContext,
  type ExtensionContributionDefinition,
  type ExtensionContributionSummary,
  type ExtensionPointDefinition,
  type ExtensionResult,
  type PluginExtensionDeclaration,
  type PluginExtensionPointDeclaration,
  type StandardSchemaV1,
} from "@openbrf/plugin-sdk";

import { assertStrictAtEveryDepth } from "../actions/action-registry.service";
import { failureFrames, failureName } from "../logging/failure";

/**
 * The calls between a host plugin and its addons (ADR 0030).
 *
 * Holds the schemas each host plugin defined for its extension points and the
 * handler each addon contributed, and carries a call from one to the other.
 * Neither plugin holds anything of the other's: the host plugin names an addon
 * by id and gets data back, and the addon's handler runs with the addon's own
 * host object, so neither receives the other's permissions.
 *
 * What may cross is decided here. The input is validated against the host
 * plugin's schema before the call and the output after it, and both are copied
 * as JSON values on the way through, so no function, object reference, request
 * or person crosses a point. Everything an addon does wrong is answered in the
 * result rather than thrown, because a screen that loses one source should go
 * on with the others.
 */

interface DefinedPoint {
  readonly hostPlugin: string;
  readonly declaration: PluginExtensionPointDeclaration;
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly timeoutMs: number;
}

interface Contribution {
  readonly addon: string;
  readonly declaration: PluginExtensionDeclaration;
  readonly titleKey: string;
  readonly descriptionKey: string | null;
  readonly handler: ExtensionContributionDefinition["handler"];
}

/**
 * A definition or contribution the host refused, in the host's own words.
 *
 * Its message is composed here from ids and the platform's rules and never
 * from anything a plugin's code produced, so the binder may log it whole. A
 * schema the conversion refuses is named by the kind of failure alone, since
 * a plugin's schema is the plugin's code.
 */
export class ExtensionDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionDefinitionError";
  }
}

/** Whether a plugin is loaded and serving, read at the moment of the call. */
export type PluginServing = (pluginId: string) => boolean;

/** A bare text key: no namespace of its own, since the host adds the addon's. */
const BARE_KEY = /^[A-Za-z0-9_.-]{1,200}$/;

function pointKey(hostPlugin: string, point: string): string {
  return `${hostPlugin}/${point}`;
}

function contributionKey(
  hostPlugin: string,
  point: string,
  addon: string,
): string {
  return `${hostPlugin}/${point}/${addon}`;
}

@Injectable()
export class PluginExtensionsService {
  private readonly logger = new Logger(PluginExtensionsService.name);
  private readonly points = new Map<string, DefinedPoint>();
  private readonly contributions = new Map<string, Contribution>();
  private serving: PluginServing = () => false;

  /**
   * Supplies the plugin state every call reads.
   *
   * Pushed in by the binder rather than pulled from the loader, for the reason
   * the action registry's liveness is: the loader takes registrations back out
   * of this service when a plugin stops serving, and two providers that
   * injected each other would be a cycle.
   */
  bindLiveness(serving: PluginServing): void {
    this.serving = serving;
  }

  /**
   * Accepts a host plugin's schemas for a point its manifest declares.
   *
   * Throws for a definition that cannot be accepted, which the binder turns
   * into `extension-refused`: a second one for the same point, a time out of
   * range, or a schema that is not a strict object at every depth built with
   * the host's zod. The last is what keeps a field nobody consented to from
   * crossing: a key the schema does not name is a key an addon could use to
   * hand over anything.
   */
  define(
    hostPlugin: string,
    declaration: PluginExtensionPointDeclaration,
    definition: unknown,
  ): void {
    const key = pointKey(hostPlugin, declaration.id);
    if (this.points.has(key)) {
      throw new ExtensionDefinitionError(
        `${key}: the extension point is defined twice.`,
      );
    }
    if (typeof definition !== "object" || definition === null) {
      throw new ExtensionDefinitionError(
        `${key}: the definition is not an object.`,
      );
    }
    const { input, output, timeoutMs } =
      definition as Partial<ExtensionPointDefinition>;

    /*
     * Converted here, as an action's schemas are at registration: both helpers
     * refuse a schema from a second copy of zod, and only the output helper
     * refuses a transform, so the output is converted that way too. Each is
     * held to the strictness rule as its input-mode document, because the
     * output mode closes every object whether or not it refuses unknown keys -
     * it describes what is left after they were stripped - and a stripped key
     * is one the addon handed over and nobody was told about.
     */
    strictSchema(key, "input", () =>
      actionInputJsonSchema(input as StandardSchemaV1, `${key} input`),
    );
    strictSchema(key, "output", () => {
      actionOutputJsonSchema(output as StandardSchemaV1, `${key} output`);
      return actionInputJsonSchema(output as StandardSchemaV1, `${key} output`);
    });

    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > EXTENSION_MAX_TIMEOUT_MS)
    ) {
      throw new ExtensionDefinitionError(
        `${key}: timeoutMs is a whole number of milliseconds from 1 to ${String(EXTENSION_MAX_TIMEOUT_MS)}.`,
      );
    }

    this.points.set(key, {
      hostPlugin,
      declaration,
      input: input as StandardSchemaV1,
      output: output as StandardSchemaV1,
      timeoutMs: timeoutMs ?? EXTENSION_TIMEOUT_MS,
    });
  }

  /**
   * Accepts an addon's handler for a point its manifest extends.
   *
   * Throws, for the binder to turn into `extension-refused`, on a second
   * contribution to the same point, a handler that is not a function, or a
   * text key that is not a bare key: the host qualifies it into the addon's
   * own namespace, and a key naming another namespace would let an addon
   * present itself under text it does not own.
   */
  contribute(
    addon: string,
    declaration: PluginExtensionDeclaration,
    contribution: unknown,
  ): void {
    const key = contributionKey(declaration.plugin, declaration.point, addon);
    if (this.contributions.has(key)) {
      throw new ExtensionDefinitionError(
        `${key}: the addon contributes twice to this point.`,
      );
    }
    if (typeof contribution !== "object" || contribution === null) {
      throw new ExtensionDefinitionError(
        `${key}: the contribution is not an object.`,
      );
    }
    const { titleKey, descriptionKey, handler } =
      contribution as Partial<ExtensionContributionDefinition>;
    if (typeof titleKey !== "string" || !BARE_KEY.test(titleKey)) {
      throw new ExtensionDefinitionError(`${key}: titleKey is not a bare key.`);
    }
    if (
      descriptionKey !== undefined &&
      (typeof descriptionKey !== "string" || !BARE_KEY.test(descriptionKey))
    ) {
      throw new ExtensionDefinitionError(
        `${key}: descriptionKey is not a bare key.`,
      );
    }
    if (typeof handler !== "function") {
      throw new ExtensionDefinitionError(
        `${key}: the handler is not a function.`,
      );
    }

    const namespace = `plugin-${addon}`;
    this.contributions.set(key, {
      addon,
      declaration,
      titleKey: `${namespace}:${titleKey}`,
      descriptionKey:
        descriptionKey === undefined ? null : `${namespace}:${descriptionKey}`,
      handler: (input, context) => handler.call(contribution, input, context),
    });
  }

  /**
   * Takes back everything one plugin defined or contributed, as a host plugin
   * and as an addon. Called on every path that stops a plugin serving.
   */
  unregisterPlugin(pluginId: string): void {
    for (const [key, point] of this.points) {
      if (point.hostPlugin === pluginId) {
        this.points.delete(key);
      }
    }
    for (const [key, contribution] of this.contributions) {
      if (
        contribution.addon === pluginId ||
        contribution.declaration.plugin === pluginId
      ) {
        this.contributions.delete(key);
      }
    }
  }

  /**
   * The contributions to a point that are serving now, in addon id order.
   *
   * Serving means both plugins are loaded and switched on and the addon has
   * registered its handler. The manifest rules - that the host plugin declares
   * the point at the version the addon names, and that it accepts what the
   * addon hands over - were held before either plugin's code ran, and an addon
   * that failed them is not loaded at all.
   */
  list(
    hostPlugin: string,
    point: string,
  ): readonly ExtensionContributionSummary[] {
    this.definedPoint(hostPlugin, point);
    return [...this.contributions.values()]
      .filter(
        (contribution) =>
          contribution.declaration.plugin === hostPlugin &&
          contribution.declaration.point === point &&
          this.isServing(contribution),
      )
      .map((contribution) => ({
        addon: contribution.addon,
        titleKey: contribution.titleKey,
        descriptionKey: contribution.descriptionKey,
      }))
      .sort((left, right) => left.addon.localeCompare(right.addon));
  }

  /**
   * Calls one addon's contribution on behalf of its host plugin.
   *
   * Throws for the host plugin's own mistakes - a point it has not defined, an
   * input its own schema refuses - and with the signal's reason when the host
   * plugin aborts the call itself. Everything the addon does is answered in
   * the result.
   */
  async invoke<Output>(
    hostPlugin: string,
    point: string,
    addon: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ExtensionResult<Output>> {
    const defined = this.definedPoint(hostPlugin, point);

    const parsed = await defined.input["~standard"].validate(input);
    if (parsed.issues !== undefined) {
      throw new TypeError(
        `Plugin "${hostPlugin}" invoked its extension point "${point}" with an input its own schema refuses` +
          describeIssues(parsed.issues),
      );
    }

    const contribution = this.contributions.get(
      contributionKey(hostPlugin, point, addon),
    );
    if (contribution === undefined || !this.isServing(contribution)) {
      return { ok: false, reason: "not-serving" };
    }
    signal?.throwIfAborted();

    const requestId = randomUUID();
    const where = `${hostPlugin}/${point} from "${addon}" [${requestId}]`;
    const answered = await this.call(
      contribution,
      // A copy, so the addon is handed data and nothing the host plugin could
      // reach back through.
      jsonCopy(parsed.value),
      {
        hostPlugin,
        point,
        version: defined.declaration.version,
        requestId,
        now: new Date(),
      },
      defined.timeoutMs,
      signal,
    );
    if (answered.kind === "timed-out") {
      this.logger.warn(
        `The contribution to ${where} did not answer within ${String(defined.timeoutMs)} ms.`,
      );
      return { ok: false, reason: "timed-out" };
    }
    if (answered.kind === "failed") {
      // The class and the frames, never the message: the addon wrote it, and
      // an addon reading the register can have a resident's details in hand.
      this.logger.error(
        `The contribution to ${where} failed: ${failureName(answered.cause)}`,
        failureFrames(answered.cause),
      );
      return { ok: false, reason: "failed" };
    }

    // Copied before it is validated, so what is checked is exactly what the
    // host plugin receives: a getter or a prototype cannot answer differently
    // the second time it is read.
    let copied: unknown;
    try {
      copied = jsonCopy(answered.value);
    } catch (cause) {
      this.logger.error(
        `The contribution to ${where} answered a value that is not JSON: ${failureName(cause)}`,
      );
      return { ok: false, reason: "output-invalid" };
    }
    const validated = await defined.output["~standard"].validate(copied);
    if (validated.issues !== undefined) {
      // Paths and a count, never the value or the validator's message: the
      // answer may hold what the addon read from the register.
      this.logger.error(
        `The contribution to ${where} answered a value the point's output schema refuses` +
          describeIssues(validated.issues),
      );
      return { ok: false, reason: "output-invalid" };
    }
    return { ok: true, value: validated.value as Output };
  }

  private definedPoint(hostPlugin: string, point: string): DefinedPoint {
    const defined = this.points.get(pointKey(hostPlugin, point));
    if (defined === undefined) {
      throw new Error(
        `Plugin "${hostPlugin}" used its extension point "${point}" without ` +
          "defining it. Call host.extensions.define for every point the manifest declares.",
      );
    }
    return defined;
  }

  private isServing(contribution: Contribution): boolean {
    return (
      this.serving(contribution.addon) &&
      this.serving(contribution.declaration.plugin)
    );
  }

  /**
   * Runs the handler against the clock.
   *
   * The handler's signal is aborted when the time runs out or the host plugin
   * aborts its own, and a late answer is dropped. A rejection that arrives
   * after the call is over is caught here, so an addon cannot leave an
   * unhandled rejection behind it.
   */
  private async call(
    contribution: Contribution,
    input: unknown,
    context: Omit<ExtensionContext, "signal">,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "answered"; value: unknown }
    | { kind: "failed"; cause: unknown }
    | { kind: "timed-out" }
  > {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const deadline = new Promise<{ kind: "timed-out" }>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("The contribution timed out."));
        resolve({ kind: "timed-out" });
      }, timeoutMs);
      if (signal !== undefined) {
        onAbort = () => {
          controller.abort(signal.reason);
          reject(signal.reason as Error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const answer = (async () => {
      try {
        const value = await contribution.handler(input, {
          ...context,
          signal: controller.signal,
        });
        return { kind: "answered" as const, value };
      } catch (cause) {
        return { kind: "failed" as const, cause };
      }
    })();

    try {
      return await Promise.race([answer, deadline]);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

/**
 * Holds one of a point's schemas to the rule an action's input is held to: a
 * strict object at every depth, built with the host's zod.
 */
function strictSchema(
  key: string,
  direction: "input" | "output",
  convert: () => Record<string, unknown>,
): void {
  try {
    assertStrictAtEveryDepth(convert(), `${key} ${direction}`);
  } catch (cause) {
    throw new ExtensionDefinitionError(
      `${key}: the ${direction} schema is not a strict object at every depth built with the host's zod (${failureName(cause)}).`,
    );
  }
}

/**
 * The value as JSON would carry it.
 *
 * What makes "only data crosses" true: a function, a class instance's
 * prototype, a getter and an object shared with the sender do not survive it.
 * Throws for a value JSON cannot hold, such as a BigInt or a cycle, and for
 * none at all.
 */
function jsonCopy(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError("The value has no JSON form.");
  }
  return JSON.parse(text) as unknown;
}

/** The paths and the count of a refusal, never the values. */
function describeIssues(
  issues: readonly {
    path?: readonly (PropertyKey | { key: PropertyKey })[];
  }[],
): string {
  const paths = issues
    .map((issue) =>
      (issue.path ?? [])
        .map((segment) =>
          typeof segment === "object" ? String(segment.key) : String(segment),
        )
        .join("."),
    )
    .filter((path) => path !== "");
  return (
    `: ${String(issues.length)} issue(s)` +
    (paths.length === 0 ? "" : ` at ${paths.join(", ")}`)
  );
}
