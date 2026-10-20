import { Injectable } from "@nestjs/common";
import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import type { z } from "zod";

import { ActionRegistryService } from "./action-registry.service";

/**
 * How a core feature registers its actions.
 *
 * The only way core code reaches `register`, so that a core owner is never
 * spelled by hand: an owner written out at a call site is an owner that can be
 * written differently at the next one, and `unregisterOwner` would then have
 * nothing to match. The module's own name goes in once, here.
 */
@Injectable()
export class CoreActionRegistrar {
  constructor(private readonly registry: ActionRegistryService) {}

  register(module: string, definitions: readonly ActionDefinition[]): void {
    for (const definition of definitions) {
      this.registry.register(definition, { kind: "core", module });
    }
  }
}

/**
 * One core definition, with its schemas and its handler typed together.
 *
 * The registry takes `ActionDefinition<unknown, unknown>`, and a handler that
 * takes a parsed input is not assignable to one that takes unknown, because a
 * function parameter is contravariant. The widening happens here, once, behind
 * a signature that ties each handler to the schema whose value it is actually
 * handed. A cast at every call site would be as many places where a handler
 * could be bound to another action's schema and the compiler would have been
 * told not to mind.
 */
export function coreAction<Input extends z.ZodType, Output extends z.ZodType>(
  definition: Omit<ActionDefinition, "input" | "output" | "handler"> & {
    readonly input: Input;
    readonly output: Output;
    readonly handler: (
      input: z.output<Input>,
      context: ActionContext,
    ) => Promise<z.output<Output>>;
  },
): ActionDefinition {
  return definition as unknown as ActionDefinition;
}
