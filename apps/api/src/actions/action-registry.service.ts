import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  actionInputJsonSchema,
  actionOutputJsonSchema,
  type ActionChannel,
  type ActionContext,
  type ActionDefinition,
  type ActionSummary,
  type ActionSurface,
  type PluginActionRegistration,
} from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { ZodError, type ZodIssue } from "zod";

import { PrincipalService } from "../authorization/principal.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { I18nService } from "../i18n/i18n.service";
import { failureFrames, failureName } from "../logging/failure";
import {
  type ActionCaller,
  ActionCallerFactory,
  type ResolvedCaller,
} from "./action-caller";
import {
  insufficientScopeChallenge,
  resourceMetadataUrl,
} from "../auth/resource-challenge";
import type { ProtectedResource } from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import { ActionError, type ActionErrorReason } from "./action.error";

/**
 * One place where "may this person do this" is decided for every action.
 *
 * The registry is a choke point rather than a convenience. Before it, a
 * capability was checked in exactly one place - the global guard, from a
 * route's declaration - and the value of that arrangement is that there is no
 * second opinion to disagree with the first. Dispatch adds a second caller that
 * never passes through a route, so the job is to make the two provably the same
 * decision rather than to add a third: the same capability value, the same
 * resolver, the same predicate, over the same set of service methods.
 *
 * What follows from that, and is easy to get wrong: the services stay ignorant.
 * A write service holds no principal and checks nothing, because a check inside
 * it would be a third opinion, and `getAllAndMerge` unions rather than
 * overrides so it could never narrow anything anyway.
 */

/** Who registered an action, and what unregisters it again. */
export type ActionOwner =
  { kind: "core"; module: string } | { kind: "plugin"; pluginId: string };

/** What the binder hands the registry, so liveness and arming are one lookup. */
export interface PluginLiveness {
  get: (pluginId: string) => Promise<{
    serving: boolean;
    armedActions: readonly string[];
    /**
     * The capability this plugin's own routes demand, already computed by the
     * binder with `routeCapabilityFloor`.
     *
     * Handed over rather than derived here, so that `actions/` imports nothing
     * from `plugins/` and the one-way dependency is literal rather than a
     * convention.
     */
    capabilityFloor: string;
  } | null>;
}

/** A definition plus who owns it. What get() returns and list() maps over. */
export interface RegisteredAction {
  readonly definition: ActionDefinition;
  readonly owner: ActionOwner;
}

/** The same narrowing list() offers a caller. */
export interface ActionListFilter {
  readonly surface?: ActionSurface;
  readonly group?: string;
}

/** The surface a call through each channel is entitled to reach. */
/**
 * Every scope this instance will issue.
 *
 * Named in one insufficient-scope challenge rather than one at a time, so a
 * client that is missing more than one learns all of them at once.
 */
const ISSUABLE_SCOPES = ["mcp:read", "mcp:write"] as const;

const SURFACE_FOR_CHANNEL: Record<ActionChannel, ActionSurface> = {
  web: "ui",
  plugin: "ui",
  system: "ui",
  mcp: "mcp",
  ai: "ai",
};

function ownerKey(owner: ActionOwner): string {
  return owner.kind === "core"
    ? `core:${owner.module}`
    : `plugin:${owner.pluginId}`;
}

@Injectable()
export class ActionRegistryService {
  private readonly logger = new Logger(ActionRegistryService.name);
  private readonly actions = new Map<string, RegisteredAction>();
  /** Alias to canonical name. Resolved on dispatch and never enumerated. */
  private readonly aliases = new Map<string, string>();
  private liveness: PluginLiveness | null = null;

  constructor(
    private readonly callers: ActionCallerFactory,
    private readonly principals: PrincipalService,
    private readonly i18n: I18nService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
  ) {}

  /**
   * Registers a core action.
   *
   * Reached through CoreActionRegistrar rather than called directly, so a core
   * owner is never spelled by hand and unregisterOwner has a value to match.
   */
  register(definition: ActionDefinition, owner: ActionOwner): void {
    this.assertNameFree(definition.name);
    for (const alias of definition.deprecatedAliases ?? []) {
      this.assertNameFree(alias);
    }

    // Converted here, at registration, rather than when something asks for the
    // document: a schema that cannot be published is a defect in the action,
    // and the moment to refuse it is before anything can call it. Both
    // directions, because only the output helper refuses a transform.
    if (definition.effect === "delete" && !definition.needsConfirmation) {
      /*
       * A delete is the one effect with no undo. MCP's destructiveHint
       * defaults to true, but a client uses needsConfirmation to decide
       * whether to ask the person first, and an action that removes something
       * for good is not one an author may quietly mark as needing no answer.
       */
      throw new Error(
        `${definition.name}: an action that deletes must declare needsConfirmation.`,
      );
    }

    if (definition.personalData.includes("protected")) {
      /*
       * Rule 1, the exposure rule, refused before anything can call the action.
       *
       * Beslutslogg 64 puts protected personal data (skyddade personuppgifter)
       * outside every token and every prompt, so an action that can return a
       * field of such a person is offered in process and nowhere else. The
       * plugin gate refuses the same thing over a manifest
       * (plugin-action-gate.ts), which is where a board can still act on it;
       * here it is refused over the definition, so it holds for a core action
       * too and no action is ever registered that the two checks disagree
       * about. They read different objects - a declaration and a definition -
       * and a later change that made one of them read the other would collapse
       * a distinction that exists because the two can disagree.
       */
      const offending = definition.surfaces.filter(
        (surface) => surface === "mcp" || surface === "ai",
      );
      if (offending.length > 0) {
        throw new Error(
          `${definition.name}: an action touching protected personal data may not be offered on ${offending.join(", ")}.`,
        );
      }
    }

    const input = actionInputJsonSchema(definition.input, definition.name);
    actionOutputJsonSchema(definition.output, definition.name);
    assertStrictAtEveryDepth(input, definition.name);

    this.actions.set(definition.name, { definition, owner });
    for (const alias of definition.deprecatedAliases ?? []) {
      this.aliases.set(alias, definition.name);
    }
  }

  /** Registers an action a plugin declared. The composed name is the host's. */
  registerFor(
    pluginId: string,
    registration: PluginActionRegistration,
    declared: {
      capability: string;
      effect: ActionDefinition["effect"];
      personalData: ActionDefinition["personalData"];
      surfaces: ActionDefinition["surfaces"];
    },
  ): void {
    /*
     * The plugin's own i18n namespace, applied by the host.
     *
     * A plugin's locale files are loaded under `plugin-<id>`, and a bare key
     * would otherwise be looked up in the platform's own resources and render
     * as the key itself on the board's screen. The plugin writes
     * `actions.summary.title`, exactly as its view writes `view.title`, and
     * qualifying it is the host's business rather than something every plugin
     * author has to know the convention for.
     */
    const namespaced = (key: string): string =>
      key.includes(":") ? key : `plugin-${pluginId}:${key}`;

    this.register(
      {
        ...registration.definition,
        titleKey: namespaced(registration.definition.titleKey),
        descriptionKey: namespaced(registration.definition.descriptionKey),
        groupTitleKey: namespaced(registration.definition.groupTitleKey),
        capability: declared.capability,
        effect: declared.effect,
        personalData: declared.personalData,
        surfaces: declared.surfaces,
      },
      { kind: "plugin", pluginId },
    );
  }

  /**
   * Takes back everything one owner registered.
   *
   * Called on every path that stops a plugin serving, not only the tidy one:
   * an unload, a seal refusal, and the container drop after a failed boot.
   */
  unregisterOwner(owner: ActionOwner): void {
    const key = ownerKey(owner);
    for (const [name, held] of new Map(this.actions)) {
      if (ownerKey(held.owner) !== key) {
        continue;
      }
      this.actions.delete(name);
      for (const alias of held.definition.deprecatedAliases ?? []) {
        this.aliases.delete(alias);
      }
    }
  }

  /**
   * Supplies the plugin state the registry reads per call.
   *
   * Pushed in by the binder rather than pulled from the loader, because a
   * registry that injected the loader and a loader that injected the registry
   * is a provider cycle, and `forwardRef` appears nowhere in this codebase as
   * an injection.
   */
  bindLiveness(lookup: PluginLiveness): void {
    this.liveness = lookup;
  }

  get(nameOrAlias: string): RegisteredAction | null {
    const canonical = this.actions.has(nameOrAlias)
      ? nameOrAlias
      : this.aliases.get(nameOrAlias);
    return canonical === undefined
      ? null
      : (this.actions.get(canonical) ?? null);
  }

  inputJsonSchema(name: string): Record<string, unknown> {
    const held = this.require(name);
    return actionInputJsonSchema(held.definition.input, name);
  }

  outputJsonSchema(name: string): Record<string, unknown> {
    const held = this.require(name);
    return actionOutputJsonSchema(held.definition.output, name);
  }

  /**
   * What this caller may be offered, in their own language.
   *
   * Filtered to what they could actually call, so a catalogue is never a list
   * of things to be refused. The same liveness and arming tests invoke() makes,
   * for the same reason: an action an unserved plugin owns must not be
   * advertised by the catalogue, by tools/list, or by a consent screen.
   */
  async list(
    caller: ActionCaller,
    filter?: ActionListFilter,
    locale?: string | null,
  ): Promise<ActionSummary[]> {
    const resolved = this.callers.resolve(caller);
    const principal = await this.principals.forPerson(resolved.personId);
    if (principal === null) {
      return [];
    }

    /*
     * Which surface this listing is of, and who may choose it.
     *
     * A person on a session may name one; a program may not. That asymmetry is
     * the rule, and it is worth stating as a rule rather than as "the filter
     * narrows", because the two directions are not the same question and a
     * later reader without the distinction will collapse them.
     *
     * A program may not, because of what "ui" means to `permits()`: on that
     * surface a serving plugin's action is offered without any arming test at
     * all, which is right for something inside this process and is exactly
     * wrong for something outside it. A caller on `mcp` asking `?surface=ui`
     * was therefore handed the actions offered nowhere beyond the instance and
     * the plugin actions no administrator had armed. Arming IS what offers an
     * action beyond this instance, so that branch is the whole of the leak -
     * not the filter as such, which is honoured correctly for `mcp` and `ai`.
     *
     * A person may, because that read is informed consent: the sign-in screen
     * shows a member what an external app would be able to do AS THEM before
     * they grant it, and it is safe for the same reason the leak is not - on
     * `mcp` and `ai` `permits()` demands the arming, and the list is filtered
     * to the person's own live capabilities either way.
     *
     * Which is why the surface chosen here is the one `permits()` is then asked
     * about, below. Judging arming by the CALLER's channel instead would make
     * that consent screen show actions the app could not in fact perform, which
     * misleads a person at the moment they decide - worse than the leak.
     */
    const surface =
      resolved.channel === "web"
        ? (filter?.surface ?? SURFACE_FOR_CHANNEL.web)
        : SURFACE_FOR_CHANNEL[resolved.channel];
    const translate = this.i18n.translatorFor(locale);

    const candidates = [...this.actions.values()].filter((held) => {
      const { definition } = held;
      return (
        definition.surfaces.includes(surface) &&
        (filter?.group === undefined || definition.group === filter.group) &&
        holdsCapability(principal, definition.capability)
      );
    });

    /*
     * One lookup per plugin rather than one per action. Arming is read at the
     * moment of the call rather than cached, which is what makes disarming
     * bite at once; a catalogue listing a plugin's twelve actions should still
     * cost one read, not twelve.
     */
    const pluginIds = new Set(
      candidates
        .filter((held) => held.owner.kind === "plugin")
        .map((held) => (held.owner as { pluginId: string }).pluginId),
    );
    const states = new Map<
      string,
      Awaited<ReturnType<PluginLiveness["get"]>>
    >();
    for (const pluginId of pluginIds) {
      states.set(pluginId, (await this.liveness?.get(pluginId)) ?? null);
    }

    const summaries = candidates
      .filter((held) => {
        if (held.owner.kind !== "plugin") {
          return true;
        }
        // Against the surface actually being listed, so a listing of "mcp"
        // answers what a connected app could really be asked to do.
        return permits(states.get(held.owner.pluginId) ?? null, held, surface);
      })
      .map((held) => summarise(held.definition, translate));

    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Dispatch.
   *
   * The order of the checks is deliberate and is documented in ADR 0008: the
   * cheap and caller-independent refusals come first, so that a refusal cannot
   * double as a probe for what exists, and the capability check is last among
   * the authorization steps so that its answer is the live one.
   */
  async invoke<Output>(
    caller: ActionCaller,
    nameOrAlias: string,
    input: unknown,
  ): Promise<Output> {
    // 1. Who is calling. Nothing later reads an argument for this.
    const resolved = this.callers.resolve(caller);

    // 2. What they asked for.
    const held = this.get(nameOrAlias);
    if (held === null) {
      throw this.refuse(
        resolved,
        nameOrAlias,
        "unknown-action",
        "No such action.",
      );
    }
    const { definition } = held;

    // 3. Whether this channel may reach it at all. Before any database read.
    const surface = SURFACE_FOR_CHANNEL[resolved.channel];
    if (!definition.surfaces.includes(surface)) {
      throw this.refuse(
        resolved,
        definition.name,
        "forbidden-surface",
        "This action is not offered here.",
      );
    }

    // 4. And whether an administrator has switched it on, for a plugin's.
    // Read here once and used again at step 9, so one call costs one lookup.
    const pluginState =
      held.owner.kind === "plugin"
        ? ((await this.liveness?.get(held.owner.pluginId)) ?? null)
        : null;
    if (!permits(pluginState, held, surface)) {
      throw this.refuse(
        resolved,
        definition.name,
        "forbidden-surface",
        "This action is not offered here.",
      );
    }

    // 5. Read-only mode, unconditionally and above every caller-dependent
    // check, so that the refusal cannot tell one caller from another.
    if (this.env.OPENBRF_ACTIONS_READ_ONLY && definition.effect !== "read") {
      throw this.refuse(
        resolved,
        definition.name,
        "read-only",
        "This instance is not accepting writes through actions.",
      );
    }

    // 6. The ceiling on the token, for a caller that presented one. Above the
    // capability check so that the refusal is scope-shaped and names a scope.
    if (resolved.client !== null) {
      const required = definition.effect === "read" ? "mcp:read" : "mcp:write";
      if (!resolved.scopes.includes(required)) {
        throw this.refuse(
          resolved,
          definition.name,
          "insufficient-scope",
          `This token does not carry ${required}.`,
          { scopes: [required] },
          /*
           * Every scope this instance issues, not the one missing here. A
           * client told only the next missing scope would be refused again for
           * each of the others, and each refusal is a round trip the person is
           * watching; one challenge lets it ask once for everything it needs.
           */
          insufficientScopeChallenge(
            resourceMetadataUrl(this.resource, this.env.APP_URL),
            ISSUABLE_SCOPES,
            `This connection does not carry ${required}.`,
          ),
        );
      }
    }

    // 7. Who they are now. Re-derived per call: no cache, no snapshot, no
    // claim carried on a token. This is the line that makes "a token never
    // exceeds the person's current capabilities" true at the instant of use.
    const principal = await this.principals.forPerson(resolved.personId);
    if (principal === null) {
      throw this.refuse(
        resolved,
        definition.name,
        "forbidden-capability",
        "This person no longer holds an account.",
      );
    }

    // 8. The one capability the action declared. No merging, no ranking.
    if (!holdsCapability(principal, definition.capability)) {
      throw this.refuse(
        resolved,
        definition.name,
        "forbidden-capability",
        "This person may not do that.",
      );
    }

    // 9. For a plugin's action, the floor its own routes demand, so an action
    // is never reachable by a caller the plugin's routes would refuse.
    if (held.owner.kind === "plugin") {
      if (pluginState === null || !pluginState.serving) {
        throw this.refuse(
          resolved,
          definition.name,
          "not-serving",
          "No such action.",
        );
      }
      if (!holdsCapability(principal, pluginState.capabilityFloor)) {
        throw this.refuse(
          resolved,
          definition.name,
          "forbidden-capability",
          "This person may not do that.",
        );
      }
    }

    // 10. The input. The standard entry point RETURNS its issues rather than
    // throwing, so the refusal has to be raised here or a malformed body would
    // reach the handler as a typed value it is not.
    const parsed = await definition.input["~standard"].validate(input);
    if (parsed.issues !== undefined) {
      /*
       * Rethrown as the validator's own error so that the answer is exactly
       * what every controller in the product answers to a malformed body: 400
       * with the failing paths and never the submitted values. Safe because
       * registration pinned the schema to the host's zod, so these are real
       * zod issues whose paths the filter can render.
       */
      throw new ZodError(parsed.issues as unknown as ZodIssue[]);
    }

    const context: ActionContext = {
      principal: {
        personId: principal.personId,
        capabilities: [...principal.capabilities],
      },
      channel: resolved.channel,
      ...(resolved.client === null ? {} : { client: resolved.client }),
      requestId: resolved.requestId,
      now: new Date(),
    };

    // 11. The handler. A domain refusal it raises is the service's own answer
    // and travels untouched; anything else is ours and says nothing.
    let output: unknown;
    try {
      output = await definition.handler(parsed.value, context);
    } catch (cause) {
      if (cause instanceof ActionError) {
        throw cause;
      }
      if (isDomainError(cause)) {
        throw cause;
      }
      this.logger.error(
        `${definition.name} failed for ${resolved.requestId}: ${failureName(cause)}`,
        failureFrames(cause),
      );
      throw new ActionError("internal", "The action failed.");
    }

    // 12. The output. A service that widened its return type must not silently
    // ship a new field to a model.
    const validated = await definition.output["~standard"].validate(output);
    if (validated.issues !== undefined) {
      /*
       * Paths and a count, never the value and never the validator's own
       * message: an output refusal happens on the way back from a service that
       * has just read the register, so whatever is in the value is exactly
       * what must not reach a log. A refusal over an unrecognised key carries
       * no path at all, which is why the count is here too.
       */
      const paths = validated.issues
        .map((issue) => pathOf(issue.path))
        .filter((path) => path !== "");
      this.logger.error(
        `${definition.name} returned a value its own schema refuses: ` +
          `${String(validated.issues.length)} issue(s)` +
          (paths.length === 0 ? "" : ` at ${paths.join(", ")}`),
      );
      throw new ActionError(
        "output-invalid",
        "The action returned an unusable value.",
      );
    }

    // 13. No audit entry is written here. The service writes it, in its own
    // transaction, with the action's own AuditAction value: a generic
    // ACTION_INVOKED row would throw away the per-action judgement the enum's
    // hundred and nine values encode, and would tempt a caller into putting a
    // prompt in the context.
    return validated.value as Output;
  }

  /** One log line per refusal, and never the message a handler carried. */
  private refuse(
    caller: ResolvedCaller,
    name: string,
    reason: ActionErrorReason,
    message: string,
    details?: Record<string, readonly unknown[]>,
    challenge?: string,
  ): ActionError {
    this.logger.log(
      `refused ${name} (${reason}) for ${caller.personId} through ${caller.channel}` +
        (caller.client === null ? "" : ` as ${caller.client.clientId}`) +
        ` [${caller.requestId}]`,
    );
    return new ActionError(reason, message, details, challenge);
  }

  private assertNameFree(name: string): void {
    if (this.actions.has(name) || this.aliases.has(name)) {
      throw new Error(`Two actions claim the name "${name}".`);
    }
  }

  private require(name: string): RegisteredAction {
    const held = this.get(name);
    if (held === null) {
      throw new ActionError("unknown-action", "No such action.");
    }
    return held;
  }
}

/**
 * Whether a principal holds a capability named as a plain string.
 *
 * An action's capability is a string because the plugin SDK cannot import the
 * instance's capability union. The boot gate is what proves the string is one
 * of the thirty-five; here it is only looked up.
 */
function holdsCapability(
  principal: { capabilities: ReadonlySet<string> },
  capability: string,
): boolean {
  return principal.capabilities.has(capability);
}

/**
 * Refuses a published input document that would accept a key the service then
 * silently drops.
 *
 * At every depth, not only at the root. A nested plain object emits no
 * `additionalProperties` at all while the validator strips unknown keys at
 * runtime, so the document promises a caller that a key is acceptable and the
 * write then happens without it - the "answered saved and it was not" failure,
 * reintroduced on the surface a model reads. The walk covers every subschema
 * with properties, inside every oneOf and anyOf branch and every items.
 */
export function assertStrictAtEveryDepth(
  document: Record<string, unknown>,
  actionName: string,
  path: readonly string[] = [],
): void {
  const where = path.length === 0 ? "the input" : path.join(".");

  if (path.length === 0 && document.type !== "object") {
    throw new Error(`${actionName}: ${where} must be an object schema.`);
  }
  if (
    document.properties !== undefined &&
    document.additionalProperties !== false
  ) {
    throw new Error(
      `${actionName}: ${where} accepts keys it does not declare; use a strict object.`,
    );
  }
  if (document.$ref !== undefined) {
    throw new Error(
      `${actionName}: ${where} is a reference, which is not published.`,
    );
  }

  const properties = document.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === "object" && value !== null) {
        assertStrictAtEveryDepth(value as Record<string, unknown>, actionName, [
          ...path,
          key,
        ]);
      }
    }
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = document[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const [index, branch] of branches.entries()) {
      if (typeof branch === "object" && branch !== null) {
        assertStrictAtEveryDepth(
          branch as Record<string, unknown>,
          actionName,
          [...path, `${keyword}[${String(index)}]`],
        );
      }
    }
  }

  const items = document.items;
  if (typeof items === "object" && items !== null) {
    assertStrictAtEveryDepth(items as Record<string, unknown>, actionName, [
      ...path,
      "items",
    ]);
  }

  /*
   * A tuple publishes its members here rather than under `items`, so a plain
   * object inside one would never have been visited.
   */
  const prefixItems = document.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const [index, entry] of prefixItems.entries()) {
      if (typeof entry === "object" && entry !== null) {
        assertStrictAtEveryDepth(entry as Record<string, unknown>, actionName, [
          ...path,
          `prefixItems[${String(index)}]`,
        ]);
      }
    }
  }

  /*
   * A record publishes its VALUE schema as `additionalProperties` and declares
   * no `properties` at all, so the strictness check above is skipped for it and
   * the value schema is reached nowhere else. The boolean `false` a strict
   * object emits is not an object and falls through.
   */
  const additional = document.additionalProperties;
  if (typeof additional === "object" && additional !== null) {
    assertStrictAtEveryDepth(
      additional as Record<string, unknown>,
      actionName,
      [...path, "additionalProperties"],
    );
  }
}

/**
 * Whether a plugin's action may be reached on this surface right now.
 *
 * Three questions, and the order is the point: a plugin the board switched off
 * offers nothing at all; in process, a plugin's own route may reach its own
 * actions without any further act; and beyond this instance, an action is
 * offered only once an administrator has armed it.
 */
function permits(
  state: { serving: boolean; armedActions: readonly string[] } | null,
  held: RegisteredAction,
  surface: ActionSurface,
): boolean {
  if (held.owner.kind !== "plugin") {
    return true;
  }
  if (state === null || !state.serving) {
    return false;
  }
  if (surface === "ui") {
    return true;
  }
  return state.armedActions.includes(held.definition.name);
}

function summarise(
  definition: ActionDefinition,
  translate: TFunction,
): ActionSummary {
  return {
    name: definition.name,
    title: translate(definition.titleKey),
    description: translate(definition.descriptionKey),
    titleKey: definition.titleKey,
    descriptionKey: definition.descriptionKey,
    group: definition.group,
    groupTitle: translate(definition.groupTitleKey),
    groupTitleKey: definition.groupTitleKey,
    capability: definition.capability,
    effect: definition.effect,
    idempotent: definition.idempotent,
    additive: definition.additive,
    needsConfirmation: definition.needsConfirmation,
    openWorld: definition.openWorld,
    personalData: definition.personalData,
    surfaces: definition.surfaces,
    errors: definition.errors,
  };
}

function pathOf(
  path: readonly (PropertyKey | { key: PropertyKey })[] | undefined,
): string {
  return (path ?? [])
    .map((segment) =>
      typeof segment === "object" ? String(segment.key) : String(segment),
    )
    .join(".");
}

function isDomainError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    "status" in cause
  );
}
